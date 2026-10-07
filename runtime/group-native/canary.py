"""Owned guest only, synthetic data; never touches native credential/history files."""
import os, sys, json, subprocess, time
if os.getuid() != 1000 or not os.path.exists('/opt/dock/init.mjs'):
    raise SystemExit(1)
mode = sys.argv[1]
if mode == 'privacy':
    forbidden = ['/proc/1/fd/0', '/proc/1/fd/1', '/var/run/docker.sock', '/run/host-services',
                 '/Users', '/host', '/root']
    denied = []
    for path in forbidden:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            os.close(fd)
            denied.append(False)
        except OSError:
            denied.append(True)
    # UID/network/mount assertions contain no paths supplied by a browser.
    status = open('/proc/self/status').read()
    print(json.dumps({'uid': os.getuid(), 'pidOne': open('/proc/1/comm').read().strip(),
                      'forbiddenDenied': all(denied),
                      'capabilitiesZero': 'CapEff:\t0000000000000000' in status,
                      'noNewPrivileges': 'NoNewPrivs:\t1' in status}))
elif mode == 'nested':
    # Exercise the pinned native CLI's supported sandbox, not an unrelated
    # manual bwrap /proc layout that Docker's masked procfs cannot remount.
    # HOME is writable in the outer guest, so its denied write proves the native
    # sandbox adds a restriction even when /workspace is already read-only.
    probe = """import os,json,uuid,errno
path='/home/agent/.dock-native-sandbox-probe-'+str(uuid.uuid4())
denied=False
try:
    with open(path,'x') as stream: stream.write('synthetic native sandbox probe')
    os.unlink(path)
except OSError as error:
    if error.errno not in (errno.EACCES,errno.EPERM,errno.EROFS): raise
    denied=True
print(json.dumps({'uid':os.getuid(),'pidNamespace':os.readlink('/proc/self/ns/pid'),'homeWriteDenied':denied}))
"""
    nested = subprocess.run(['/usr/local/bin/codex', 'sandbox', '--',
                             '/usr/bin/python3', '-c', probe],
                            capture_output=True, timeout=15)
    try:
        native = json.loads(nested.stdout) if nested.returncode == 0 else {}
    except ValueError:
        native = {}
    native_ok = (native.get('uid') == 1000 and native.get('homeWriteDenied') is True
                 and isinstance(native.get('pidNamespace'), str)
                 and native['pidNamespace'] != os.readlink('/proc/self/ns/pid'))
    browser = subprocess.run(['/opt/dock/chromium', '--headless', '--disable-gpu',
                              '--user-data-dir=/tmp/group-browser-canary', '--dump-dom', 'about:blank'],
                             capture_output=True, timeout=15)
    print(json.dumps({'nested': nested.returncode == 0 and native_ok,
                      'chromiumNativeSandbox': browser.returncode == 0 and b'<html' in browser.stdout}))
elif mode == 'descendants':
    # All branches retain stdout so root can observe heartbeats and closure after
    # explicit stop OR attached-lifetime host crash. No host ancestry polling.
    for kind in ['fork', 'setsid', 'double-fork']:
        pid = os.fork()
        if pid:
            continue
        if kind != 'fork': os.setsid()
        if kind == 'double-fork':
            if os.fork(): os._exit(0)
        for count in range(36000):
            print(json.dumps({'kind': kind, 'heartbeat': count}), flush=True)
            time.sleep(0.1)
        os._exit(0)
    print(json.dumps({'started': True}), flush=True)
    # Docker exec owns the original parent; keep that process alive so the
    # daemon cannot end its stream while detached grandchildren still run.
    while True: time.sleep(1)
elif mode == 'receipt':
    import re
    nonce = sys.argv[2]
    if not re.fullmatch(r'[a-f0-9-]{36}', nonce): raise SystemExit(1)
    try:
        # Only the synthetic file named in the immediately preceding tool turn.
        with open('/workspace/native-canary.json') as stream:
            value = json.load(stream)
        verified = value == {'canary': 'group-native-ok', 'nonce': nonce}
    except (OSError, ValueError):
        verified = False
    print(json.dumps({'toolReceiptVerified': verified}))
else:
    raise SystemExit(1)
