/** Executed only by the owning admitted GroupContainer, with no image changes.
 * The complete hash-bound committed closure is retained in memory and checked
 * BEFORE stdout emits any object bytes. Git sees a generated config-free bare
 * control directory; working-tree bytes, hooks and native account stores are
 * neither inputs nor exports. Host independently repeats closure validation. */
export const nativeGitExportGuest = String.raw`
import os,sys,json,hashlib,subprocess,tempfile,shutil,stat,signal

def fail(reason):
    raise ValueError(reason)

def path_ok(path):
    if not path or len(path.encode('utf-8'))>4096 or path.startswith('/') or '\\' in path:
        fail('path')
    if any(ord(c)<32 or ord(c)==127 for c in path) or any(p in ('','.','..') or p.lower()=='.git' for p in path.split('/')):
        fail('path')
    return path

def directory(path):
    current='/'
    for part in path.split('/')[1:]:
        current=os.path.join(current,part)
        s=os.lstat(current)
        if not stat.S_ISDIR(s.st_mode): fail('source-layout')

def storage(objects):
    stack=[objects]
    while stack:
        path=stack.pop()
        for entry in os.scandir(path):
            s=entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(s.st_mode) or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                fail('source-layout')
            if entry.name in ('alternates','http-alternates'): fail('source-layout')
            if stat.S_ISDIR(s.st_mode): stack.append(entry.path)

def oid_ok(oid):
    if len(oid)!=40 or any(c not in '0123456789abcdef' for c in oid): fail('object-id')
    return oid

def frame(typ,data): return (typ+' '+str(len(data))).encode()+b'\0'+data

request=json.loads(sys.stdin.readline())
repository=sys.argv[1]
temporary=None
git=None
try:
    signal.signal(signal.SIGALRM,lambda *_: fail('deadline'))
    signal.alarm(120)
    # This exact alias is part of the reviewed read-only image, not an agent
    # gitdir/symlink grant. Reject every other alias or writable repository link.
    if repository=='/workspace' or repository.startswith('/workspace/'):
        alias=os.lstat('/workspace')
        if stat.S_ISLNK(alias.st_mode):
            if alias.st_uid!=0 or os.readlink('/workspace')!='/home/agent/workspace': fail('source-layout')
            repository='/home/agent/workspace'+repository[len('/workspace'):]
    directory(repository)
    gitdir=os.path.join(repository,'.git') if os.path.lexists(os.path.join(repository,'.git')) else repository
    directory(gitdir)
    for name in ('commondir','shallow'):
        if os.path.lexists(os.path.join(gitdir,name)): fail('source-layout')
    objects_dir=os.path.join(gitdir,'objects')
    directory(objects_dir)
    storage(objects_dir)
    allowed=set(path_ok(p) for p in request['contentPaths'])
    temporary=tempfile.mkdtemp(prefix='dock-git-export-',dir='/tmp')
    os.mkdir(os.path.join(temporary,'objects'))
    os.mkdir(os.path.join(temporary,'refs'))
    with open(os.path.join(temporary,'HEAD'),'x') as f: f.write('ref: refs/heads/unborn\n')
    with open(os.path.join(temporary,'config'),'x') as f: f.write('[core]\nrepositoryformatversion=0\nbare=true\n[protocol]\nallow=never\n')
    environment={'PATH':'/usr/bin:/bin','HOME':temporary,'LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_LFS_SKIP_SMUDGE':'1','GIT_OBJECT_DIRECTORY':objects_dir}
    git=subprocess.Popen(['/usr/bin/git','--no-replace-objects','--git-dir='+temporary,'cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=environment)
    objects={}
    total=0
    def read(oid,expected):
        global total
        oid_ok(oid)
        if oid in objects:
            typ,data=objects[oid]
            if typ!=expected: fail('object-type')
            return data
        if len(objects)>=request['maxObjects']: fail('object-limit')
        git.stdin.write((oid+'\n').encode()); git.stdin.flush()
        header=git.stdout.readline(512).decode('ascii').rstrip('\n').split(' ')
        if len(header)!=3 or header[0]!=oid or header[1]!=expected or not header[2].isdigit(): fail('object-type')
        size=int(header[2])
        if size>request['maxBytes']-total or (expected=='blob' and size>request['maxFileBytes']): fail('byte-limit')
        data=git.stdout.read(size)
        if len(data)!=size or git.stdout.read(1)!=b'\n' or hashlib.sha1(frame(expected,data)).hexdigest()!=oid: fail('object-hash')
        total+=len(frame(expected,data))
        if total>request['maxBytes']: fail('byte-limit')
        if expected=='blob' and data.startswith(b'version https://git-lfs.github.com/spec/v1'): fail('lfs')
        objects[oid]=(expected,data)
        return data
    commits=[oid_ok(request['sourceOid'])]
    visited=set()
    trees=set()
    while commits:
        commit=commits.pop()
        if commit in visited: continue
        visited.add(commit)
        raw=read(commit,'commit')
        if b'\n\n' not in raw: fail('commit')
        headers=raw.split(b'\n\n',1)[0].decode('utf-8','strict').split('\n')
        roots=[line[5:] for line in headers if line.startswith('tree ')]
        if len(roots)!=1: fail('commit')
        commits.extend(oid_ok(line[7:]) for line in headers if line.startswith('parent '))
        pending=[(oid_ok(roots[0]),'')]
        while pending:
            tree,prefix=pending.pop()
            if (tree,prefix) in trees: continue
            trees.add((tree,prefix))
            data=read(tree,'tree'); offset=0; names=set()
            while offset<len(data):
                space=data.find(b' ',offset); end=data.find(b'\0',space+1)
                if space<offset or end<space or end+21>len(data): fail('tree')
                mode=data[offset:space].decode('ascii')
                name=data[space+1:end].decode('utf-8','strict')
                if '/' in name or name in names: fail('tree')
                names.add(name)
                path=path_ok(prefix+name)
                child=data[end+1:end+21].hex(); offset=end+21
                if mode=='40000':
                    if not any(p.startswith(path+'/') for p in allowed): fail('privacy')
                    pending.append((child,path+'/'))
                elif mode in ('100644','100755'):
                    if path not in allowed: fail('privacy')
                    read(child,'blob')
                else: fail('symlink-submodule')
    storage(objects_dir)
    manifest=[[oid,typ,len(data),hashlib.sha256(frame(typ,data)).hexdigest()] for oid,(typ,data) in sorted(objects.items())]
    digest=hashlib.sha256(json.dumps(manifest,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    # No data output occurs until every reachable parent/tree/blob passed.
    for oid,(typ,data) in sorted(objects.items()):
        header={'kind':'object','oid':oid,'type':typ,'size':len(data)}
        sys.stdout.buffer.write(json.dumps(header,separators=(',',':')).encode()+b'\n'+data+b'\n')
    sys.stdout.buffer.write(json.dumps({'kind':'complete','sourceOid':request['sourceOid'],'manifestDigest':digest,'objectCount':len(objects),'totalBytes':total},separators=(',',':')).encode()+b'\n')
    sys.stdout.buffer.flush()
except Exception as error:
    reason=str(error) if isinstance(error,ValueError) and str(error) in ('path','source-layout','object-id','deadline','object-type','object-limit','byte-limit','object-hash','lfs','commit','tree','privacy','symlink-submodule') else 'invalid-source'
    sys.stdout.buffer.write(json.dumps({'kind':'denied','reason':reason},separators=(',',':')).encode()+b'\n')
    sys.stdout.buffer.flush()
    sys.exit(1)
finally:
    if git is not None:
        git.kill(); git.wait()
    if temporary is not None: shutil.rmtree(temporary)
`;
