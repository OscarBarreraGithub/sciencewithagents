"""Fixed compute-only scratch selection. Never a browser path or arbitrary executable API."""
import json, os, re, stat, sys
LOCAL_FILESYSTEMS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'overlay'}

def mount_type(path, mountinfo):
    device=os.stat(path).st_dev
    actual=str(os.major(device))+':'+str(os.minor(device))
    matches=[]
    for order,line in enumerate(mountinfo.splitlines()):
        left, sep, right=line.partition(' - ')
        if not sep: continue
        fields=left.split(); types=right.split()
        if len(fields)<5 or not types or fields[2]!=actual: continue
        point=fields[4].replace('\\040',' ').replace('\\134','\\')
        if path==point or path.startswith(point.rstrip('/')+'/'): matches.append((len(point),order,types[0]))
    if not matches: raise RuntimeError('Compute scratch filesystem is unavailable')
    length=max(match[0] for match in matches)
    types={match[2] for match in matches if match[0]==length}
    if len(types)!=1: raise RuntimeError('Compute scratch mount identity is ambiguous')
    # Actual stat device wins over stacked mounts; inconsistent evidence is refused.
    return types.pop()

def prepare_scratch(allocation, base, mountinfo):
    if not re.fullmatch(r'\d{1,20}', allocation['jobId']) or not re.fullmatch(r'[a-f0-9-]{36}', allocation['token']): raise RuntimeError('Scratch allocation identity changed')
    if not os.path.isabs(base) or any(c in base for c in '\r\n\0'): raise RuntimeError('Native compute scratch path is invalid')
    base=os.path.realpath(base)
    if mount_type(base, mountinfo) not in LOCAL_FILESYSTEMS: raise RuntimeError('A node-local filesystem is required for regenerable build files')
    parent=os.stat(base)
    if not stat.S_ISDIR(parent.st_mode) or (parent.st_uid not in (0,os.getuid())): raise RuntimeError('Native scratch parent ownership changed')
    if parent.st_mode & (stat.S_IWOTH | stat.S_IWGRP) and not parent.st_mode & stat.S_ISVTX: raise RuntimeError('Native scratch parent is not protected')
    free=os.statvfs(base); available=free.f_bavail*free.f_frsize
    if free.f_favail < 150000: raise RuntimeError('Compute scratch has insufficient free inodes')
    if available < 4*1024**3: raise RuntimeError('Compute scratch has less than 4 GiB available')
    root=os.path.join(base,'sciencewithagents-'+str(os.getuid())+'-'+allocation['jobId']+'-'+allocation['token'])
    try: os.mkdir(root,0o700)
    except FileExistsError: pass
    current=os.lstat(root)
    if not stat.S_ISDIR(current.st_mode) or current.st_uid!=os.getuid() or current.st_mode&0o077: raise RuntimeError('Owned compute scratch directory changed')
    marker=os.path.join(root,'allocation.json')
    identity={'jobId':allocation['jobId'],'token':allocation['token'],'uid':os.getuid()}
    try:
        with open(marker,'x') as f: json.dump(identity,f)
        os.chmod(marker,0o600)
    except FileExistsError:
        m=os.lstat(marker)
        if not stat.S_ISREG(m.st_mode) or m.st_uid!=os.getuid() or m.st_mode&0o077 or m.st_size>1000: raise RuntimeError('Scratch allocation marker changed')
        with open(marker) as f:
            if json.load(f)!=identity: raise RuntimeError('Scratch belongs to another allocation')
    return {'scratchRoot':root,'availableBytes':available}

def native_scratch(allocation, mountinfo):
    for variable in ('SLURM_TMPDIR', 'TMPDIR'):
        candidate=os.environ.get(variable)
        if not candidate: continue
        if not os.path.isabs(candidate) or any(c in candidate for c in '\r\n\0'): raise RuntimeError('Native compute scratch path is invalid')
        if mount_type(os.path.realpath(candidate),mountinfo) in LOCAL_FILESYSTEMS:
            return prepare_scratch(allocation,candidate,mountinfo)
    # FASRC node-local scratch; network $SCRATCH is deliberately never used.
    return prepare_scratch(allocation,'/scratch',mountinfo)



def extract_runtime_archive(archive, destination):
    """Validate every member before writing; pnpm's internal relative links are preserved."""
    import tarfile, posixpath
    destination=os.path.realpath(destination)
    if os.listdir(destination): raise RuntimeError('Artifact extraction requires an empty owned stage')
    with tarfile.open(archive, 'r:*') as tar:
        members=[]; expanded=0
        for member in tar:
            members.append(member); expanded+=member.size
            if len(members)>150000 or expanded>8*1024**3: raise RuntimeError('Runtime archive exceeds bounded extraction size')
        links={}
        names=set()
        for member in members:
            name=member.name.rstrip('/')
            if name in ('', '.'): continue
            if name.startswith('./'): name=name[2:]
            if not name or name.startswith('/') or any(p in ('..','.','') for p in name.split('/')) or any(c in name for c in '\r\n\0') or name in names: raise RuntimeError('Unsafe runtime archive member')
            names.add(name)
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise RuntimeError('Unsupported runtime archive member')
            if member.issym() or member.islnk():
                target=member.linkname
                if not target or target.startswith('/') or any(c in target for c in '\r\n\0'): raise RuntimeError('Runtime archive link escapes its owned tree')
                links[name]=(target,member.issym())
        # Resolve links before '..', as the filesystem does. Lexical normalization
        # alone misses e.g. inside -> '.' followed by escape -> 'inside/../outside'.
        for name in links:
            pending=name.split('/'); resolved=[]; hops=0
            while pending:
                part=pending.pop(0)
                if part in ('','.'): continue
                if part=='..':
                    if not resolved: raise RuntimeError('Runtime archive link escapes its owned tree')
                    resolved.pop(); continue
                key='/'.join(resolved+[part])
                if key in links:
                    hops+=1
                    if hops>40: raise RuntimeError('Runtime archive link resolution is cyclic or too deep')
                    target,relative=links[key]
                    if not relative: resolved=[]
                    pending=target.split('/')+pending
                else: resolved.append(part)
        for name in names:
            parent=posixpath.dirname(name)
            while parent:
                if parent in links: raise RuntimeError('Runtime archive writes through a link')
                parent=posixpath.dirname(parent)
        tar.extractall(destination, members=members)


def verify_compute_node(job):
    import socket, subprocess
    step=os.environ.get('SLURM_STEP_ID')
    if not step or not step.isdigit(): raise RuntimeError('An owned Slurm compute step is required')
    nodes=subprocess.check_output(['scontrol','show','hostnames',job['NodeList']],text=True,timeout=15).split()
    if socket.gethostname().split('.')[0] not in [node.split('.')[0] for node in nodes]: raise RuntimeError('This process is not on its allocated compute node')

if __name__=='__main__':
    import base64, platform, subprocess
    allocation=json.loads(base64.b64decode(sys.argv[1]))
    if os.environ.get('SLURM_JOB_ID')!=allocation['jobId']: raise RuntimeError('Compute allocation required')
    text=subprocess.check_output(['scontrol','show','job','-o',allocation['jobId']],text=True,timeout=15)
    job=dict(re.findall(r'(\w+)=([^ ]*)',text))
    expected={'JobId':allocation['jobId'],'UserId':allocation['username']+'('+str(os.getuid())+')','Account':allocation['account'],'Comment':'swa-development:'+allocation['projectId']+':'+allocation['token'],'JobName':'swa-dev-'+allocation['projectId'][:8],'JobState':'RUNNING'}
    if any(job.get(key)!=value for key,value in expected.items()): raise RuntimeError('Owned compute allocation changed')
    verify_compute_node(job)
    if platform.system()!='Linux': raise RuntimeError('Linux compute is required')
    arch={'x86_64':'x64','aarch64':'arm64'}.get(platform.machine())
    if not arch: raise RuntimeError('Unsupported compute architecture')
    with open('/proc/self/mountinfo') as f: mounts=f.read()
    result=native_scratch(allocation,mounts)
    print(json.dumps(dict(result,arch=arch)))
