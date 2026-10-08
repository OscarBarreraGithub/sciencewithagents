/** Metadata only, under explicitly saved roots: no file contents, symlink traversal,
 * full home scan, provider calls, or Slurm jobs. Payload is base64 JSON, never shell code. */
export const clusterWorkspaceProbe = String.raw`set -eu
exec python3 - "$1" <<'PY'
import base64, collections, datetime, json, os, pwd, re, signal, stat, subprocess, sys, time
signal.alarm(30)
payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
identity = pwd.getpwuid(os.getuid())
username = identity.pw_name
home = os.path.realpath(identity.pw_dir)
name = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
def command(args):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
        return p.stdout[:20000].decode('utf-8', 'replace') if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None

def allowed_root(raw):
    root = os.path.realpath(os.path.expanduser(raw))
    if root == '/' or len(root) > 1000 or not os.path.isdir(root):
        raise ValueError('Choose an existing cluster folder, rather than the filesystem root.')
    return root

def timestamp(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat().replace('+00:00','Z')
def entry(parent, child, relative):
    s = os.fstat(parent) if child is None else os.stat(child, dir_fd=parent, follow_symlinks=False)
    kind = 'symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file'
    git = False
    if kind == 'directory':
        directory = os.dup(parent) if child is None else os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            try:
                g = os.stat('.git', dir_fd=directory, follow_symlinks=False)
                git = stat.S_ISDIR(g.st_mode) or stat.S_ISREG(g.st_mode)
            except OSError:
                pass
        finally:
            os.close(directory)
    return dict(relativePath=relative, kind=kind, size=s.st_size if kind == 'file' else None, modifiedAt=timestamp(s.st_mtime), git=git)

def index(saved):
    out = dict(id=saved['id'], canonicalPath=None, entries=[], omitted=0, truncated=False, error=None)
    queue = collections.deque()
    opened = set()
    try:
        root = allowed_root(saved['path'])
        # An explicit home root exposes only immediate metadata. Save a project
        # subfolder separately to inspect its deeper bounded metadata.
        descend_depth = 0 if root == home else 2
        out['canonicalPath'] = root
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened.add(fd)
        out['entries'].append(entry(fd, None, '.'))
        queue.append((fd, '', 0))
        deadline = time.monotonic() + 3
        while queue:
            if len(out['entries']) >= 300 or time.monotonic() >= deadline:
                out['truncated'] = True
                break
            directory, prefix, depth = queue.popleft()
            slots = 300 - len(out['entries'])
            children = []
            with os.scandir(directory) as scan:
                for child in scan:
                    children.append(child.name)
                    if len(children) > slots:
                        out['omitted'] += 1
                        out['truncated'] = True
                        break
            for child in sorted(children[:slots]):
                relative = prefix + child
                if len(relative) > 1000:
                    out['omitted'] += 1
                    out['truncated'] = True
                    continue
                item = entry(directory, child, relative)
                out['entries'].append(item)
                if item['kind'] == 'directory' and child not in ('.git','node_modules','.venv','__pycache__'):
                    if depth < descend_depth:
                        fd = os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        opened.add(fd)
                        queue.append((fd, relative + '/', depth + 1))
                    else:
                        out['truncated'] = True
            os.close(directory)
            opened.remove(directory)
    except (OSError, ValueError, OverflowError):
        out['error'] = 'The saved folder could not be indexed. Check its path and your cluster access.'
    finally:
        for fd in opened:
            os.close(fd)
    return out

if 'validate' in payload:
    v = payload['validate']
    try:
        root = allowed_root(v['root'])
        if root != v['canonicalPath']:
            raise ValueError('Root changed')
        parts = v['relativePath'].split('/') if v['relativePath'] != '.' else []
        if any(part in ('', '.', '..') for part in parts):
            raise ValueError('Invalid relative path')
        path = root
        for part in parts:
            path = os.path.join(path, part)
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                raise ValueError('Directory changed')
        if os.path.realpath(path) != path:
            raise ValueError('Directory changed')
        identity=os.stat(path,follow_symlinks=False)
        print(json.dumps(dict(username=username, path=path, directoryIdentity=str(identity.st_dev)+':'+str(identity.st_ino), directoryOwnerUid=identity.st_uid, error=None)))
    except (OSError, ValueError):
        print(json.dumps(dict(username=username, path=None, error='The indexed folder changed. Refresh the saved root before opening it.')))
else:
    accounts = command(['sacctmgr','-nP','show','assoc','user=' + username,'format=Account'])
    default = command(['sacctmgr','-nP','show','user','where','name=' + username,'format=DefaultAccount'])
    rows = sorted(set(line.split('|')[0].strip() for line in (accounts or '').splitlines()))
    rows = [row for row in rows if name.fullmatch(row)][:50]
    default = next((line.split('|')[0].strip() for line in (default or '').splitlines() if name.fullmatch(line.split('|')[0].strip())), None)
    roots = payload.get('roots', [])[:8]
    print(json.dumps(dict(username=username, accounts=rows, defaultAccount=default,
        setupError=None if accounts is not None and rows else 'Slurm accounts were not reported. Refresh setup before choosing an account.', roots=[index(root) for root in roots])))
PY
`;
