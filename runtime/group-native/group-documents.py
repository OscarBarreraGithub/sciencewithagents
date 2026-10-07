#!/usr/bin/env python3
"""Fixed guest document protocol. No guest command, host path, mount or account input."""
import base64, hashlib, json, os, pathlib, re, resource, stat, subprocess, sys, tempfile, time
# /workspace is the image's fixed symlink; open the actual fixed volume directory.
WORKSPACE = pathlib.Path('/home/agent/workspace')
MAX_BYTES, MAX_FILES, MAX_PDF, MAX_LOG = 8*1024**2, 100, 50*1024**2, 16*1024**2
NAME = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9_./-]{0,239}\Z')
UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z')

def name(value):
    if not isinstance(value,str) or not NAME.fullmatch(value) or any(not x or x.startswith('.') for x in value.split('/')):
        raise ValueError('invalid resource name')
    return value

def safe_read(root, value):
    parts=name(value).split('/')
    fd=os.dup(root) if isinstance(root,int) else os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            before=os.fstat(f)
            if not stat.S_ISREG(before.st_mode) or before.st_size>MAX_BYTES: raise ValueError('regular bounded input required')
            with os.fdopen(os.dup(f),'rb') as stream: data=stream.read(MAX_BYTES+1)
            after=os.fstat(f)
            if len(data)>MAX_BYTES or (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('input changed')
            return data
        finally:os.close(f)
    finally:os.close(fd)

def descriptors(files):
    return [{'name':n,'sha256':hashlib.sha256(v).hexdigest(),'bytes':len(v)} for n,v in sorted(files.items())]

def collect(names):
    files={};pending=list(names)
    while pending:
        n=name(pending.pop())
        if n in files:continue
        data=safe_read(WORKSPACE,n);files[n]=data
        if len(files)>MAX_FILES or sum(map(len,files.values()))>MAX_BYTES:raise ValueError('input limit')
        if not n.endswith('.tex'):continue
        text=re.sub(r'(?<!\\)%[^\n]*','',data.decode('utf-8','strict'))
        # Packages/classes resolve ONLY from compiler assets. Literal file references are exact dependencies.
        for cmd,arg in re.findall(r'\\(input|include|includegraphics|addbibresource|bibliography)(?:\[[^\]\n]*\])?\s*\{([^{}]+)\}',text):
            candidates=arg.split(',') if cmd=='bibliography' else [arg]
            for part in candidates:
                part=part.strip()
                relative=pathlib.PurePosixPath(n).parent/part
                candidate=name(str(relative))
                extensions=[''] if pathlib.PurePosixPath(candidate).suffix else (['.png','.jpg','.jpeg','.pdf','.webp'] if cmd=='includegraphics' else ['.bib'] if cmd in ['bibliography','addbibresource'] else ['.tex'])
                selected=None
                for ext in extensions:
                    try:safe_read(WORKSPACE,candidate+ext);selected=candidate+ext;break
                    except FileNotFoundError:pass
                if selected is None:raise ValueError('missing exact dependency')
                pending.append(selected)
    return files

def write_snapshot(root, value, data):
    parts=value.split('/')
    fd=os.dup(root)
    try:
        for part in parts[:-1]:
            try:os.mkdir(part,0o700,dir_fd=fd)
            except FileExistsError:pass
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        f=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=fd)
        with os.fdopen(f,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.fsync(fd)
    finally:os.close(fd)

def capture(request):
    receipt=request['receiptId']
    if not UUID.fullmatch(receipt):raise ValueError('receipt')
    names=request['names']
    if not isinstance(names,list) or not names or len(names)>MAX_FILES:raise ValueError('files')
    root=os.open(WORKSPACE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    storage=None;target=None
    try:
        try:os.mkdir('.dock-documents',0o700,dir_fd=root)
        except FileExistsError:pass
        storage=os.open('.dock-documents',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
        try:target=os.open(receipt,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=storage)
        except FileNotFoundError:pass
        if target is not None:
            # Same exact capture reconciles a lost acknowledgement, never a newer working copy.
            manifest=json.loads(safe_manifest(target))
            if manifest['names']!=names or manifest['resultDigest']!=request['resultDigest']:raise ValueError('capture changed')
            files={f['name']:safe_read(target,f['name']) for f in manifest['files']}
            if descriptors(files)!=manifest['files']:raise ValueError('snapshot changed')
            return {'state':'completed','files':manifest['files']}
        files=collect(names)
        partial=receipt+'.partial'
        os.mkdir(partial,0o700,dir_fd=storage) # Uncertain unpublished snapshots are never silently replaced.
        target=os.open(partial,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=storage)
        for n,data in files.items():write_snapshot(target,n,data)
        manifest={'names':names,'resultDigest':request['resultDigest'],'files':descriptors(files)}
        write_snapshot(target,'manifest.json',json.dumps(manifest).encode())
        os.fchmod(target,0o500);os.fsync(target)
        # Refuse a replaced directory rather than publishing a different native object.
        if os.stat(partial,dir_fd=storage,follow_symlinks=False).st_ino!=os.fstat(target).st_ino:raise ValueError('snapshot replaced')
        os.rename(partial,receipt,src_dir_fd=storage,dst_dir_fd=storage);os.fsync(storage)
        return {'state':'completed','files':manifest['files']}
    finally:
        if target is not None:os.close(target)
        if storage is not None:os.close(storage)
        os.close(root)

def snapshot_fd(receipt):
    root=os.open(WORKSPACE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        storage=os.open('.dock-documents',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
        try:return os.open(receipt,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=storage)
        finally:os.close(storage)
    finally:os.close(root)

def safe_manifest(target):
    fd=os.open('manifest.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=target)
    if not stat.S_ISREG(os.fstat(fd).st_mode):os.close(fd);raise ValueError('regular manifest required')
    with os.fdopen(fd,'rb') as stream:
        raw=stream.read(65537)
        if len(raw)>65536:raise ValueError('manifest limit')
        return raw

def export(request):
    receipt=request['receiptId']
    if not UUID.fullmatch(receipt):raise ValueError('receipt')
    target=snapshot_fd(receipt)
    try:return export_selected(request,target)
    finally:os.close(target)

def export_selected(request,target):
    manifest=json.loads(safe_manifest(target));known={f['name']:f for f in manifest['files']}
    if manifest['resultDigest']!=request['resultDigest']:raise ValueError('result identity')
    selected=request['files']
    if not isinstance(selected,list) or not selected or len(selected)>MAX_FILES:raise ValueError('grant')
    output=[];total=0;seen=set()
    for f in selected:
        n=name(f['name'])
        if n in seen or known.get(n)!={k:f[k] for k in ['name','sha256','bytes']}:raise ValueError('mixed grant')
        seen.add(n);data=safe_read(target,n);total+=len(data)
        if total>MAX_BYTES or len(data)!=f['bytes'] or hashlib.sha256(data).hexdigest()!=f['sha256']:raise ValueError('snapshot digest')
        output.append({'name':n,'sha256':f['sha256'],'bytes':len(data),'base64':base64.b64encode(data).decode()})
    return {'state':'completed','files':output}

def compiler_args(inputs,output,entry):
    # Docker masks proc entries; nested proc remounts fail EPERM. PDFTeX needs no proc.
    # Keep proc absent rather than binding an outer guest process/root view.
    args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp','--setenv','LANG','C','--setenv','openin_any','p','--setenv','openout_any','p','--setenv','shell_escape','f']
    for path in ['/usr/bin/pdftex','/usr/lib/aarch64-linux-gnu','/usr/share/texlive','/usr/share/texmf','/usr/share/fonts','/etc/texmf','/var/lib/texmf']:
        args+=['--ro-bind',path,path]
    args+=['--symlink','usr/lib','/lib','--ro-bind','/usr/lib/ld-linux-aarch64.so.1','/usr/lib/ld-linux-aarch64.so.1','--symlink','pdftex','/usr/bin/pdflatex','--dev','/dev','--tmpfs','/tmp','--ro-bind',str(inputs),'/inputs','--bind',str(output),'/output','--chdir',str(pathlib.PurePosixPath('/inputs')/pathlib.PurePosixPath(entry).parent), '/usr/bin/pdflatex','-no-shell-escape','-interaction=batchmode','-halt-on-error','-file-line-error','-output-directory=/output','./'+pathlib.PurePosixPath(entry).name]
    return args

class CompilerDenied(ValueError):pass

def compiler_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_PDF,MAX_PDF))
    resource.setrlimit(resource.RLIMIT_CPU,(110,110))
    resource.setrlimit(resource.RLIMIT_NOFILE,(256,256))

def check_output(output,log,deadline):
    files=list(output.rglob('*'))
    if time.monotonic()>deadline or log.stat().st_size>MAX_LOG or len(files)>128:raise ValueError('compiler limit')
    total=0
    for p in files:
        if p.is_symlink() or not p.is_file():raise ValueError('unexpected compiler output')
        total+=p.stat().st_size
    if total>MAX_PDF+MAX_LOG:raise ValueError('compiler output limit')

def build(request):
    entry=name(request['entry'])
    if not entry.endswith('.tex'):raise ValueError('tex entry')
    files=request['files']
    if not isinstance(files,list) or not files or len(files)>MAX_FILES:raise ValueError('grant')
    with tempfile.TemporaryDirectory(prefix='group-document-') as private:
        root=pathlib.Path(private);inputs=root/'inputs';output=root/'output';inputs.mkdir(mode=0o700);output.mkdir(mode=0o700)
        total=0;seen=set()
        for f in files:
            n=name(f['name']);data=base64.b64decode(f['base64'],validate=True);total+=len(data)
            if n in seen or len(data)!=f['bytes'] or hashlib.sha256(data).hexdigest()!=f['sha256'] or total>MAX_BYTES:raise ValueError('grant digest')
            seen.add(n);p=inputs/n;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);p.write_bytes(data);p.chmod(0o400)
        if entry not in seen:raise ValueError('ungranted entry')
        # Preserve main-relative includes without copying any ambient working directory.
        args=compiler_args(inputs,output,entry)
        deadline=time.monotonic()+110
        for _ in range(2):
            log=root/'compiler.log'
            with log.open('wb') as stream:
                child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,start_new_session=True,env={'PATH':'/usr/bin:/bin'},preexec_fn=compiler_limits)
                try:
                    while child.poll() is None:
                        check_output(output,log,deadline)
                        time.sleep(.05)
                    check_output(output,log,deadline)
                    if child.returncode:raise CompilerDenied('compiler failed or dependency denied')
                finally:
                    if child.poll() is None:
                        os.killpg(child.pid,9);child.wait()
        pdf=output/(pathlib.PurePosixPath(entry).stem+'.pdf')
        if pdf.is_symlink() or not pdf.is_file() or pdf.stat().st_size>MAX_PDF:raise ValueError('pdf output')
        data=pdf.read_bytes()
        if not data.startswith(b'%PDF-'):raise ValueError('pdf header')
        return {'state':'completed','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}

def main():
    raw=sys.stdin.buffer.read(12*1024**2+1)
    if len(raw)>12*1024**2:raise ValueError('request bound')
    request=json.loads(raw)
    mode=sys.argv[1]
    result={'capture':capture,'export':export,'build':build}[mode](request)
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__':
    try:main()
    except CompilerDenied:
        print('{"state":"denied","reason":"compiler"}');sys.exit(1)
    except Exception:
        print('{"state":"denied","reason":"input"}');sys.exit(1)
