import { afterEach, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runGroupDocumentGuest } from './group-documents-native-runtime-process.js';
const exec = promisify(execFile),
  roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const allow = (p: string) => {
      if (lstatSync(p).isDirectory()) {
        chmodSync(p, 0o700);
        for (const n of readdirSync(p)) allow(join(p, n));
      }
    };
    allow(root);
    rmSync(root, { recursive: true, force: true });
  }
});
const helper = resolve('../../runtime/group-native/group-documents.py');
async function python(code: string) {
  const root = mkdtempSync(join(tmpdir(), 'group-doc-guest-'));
  roots.push(root);
  mkdirSync(join(root, 'workspace'));
  writeFileSync(
    join(root, 'workspace', 'main.tex'),
    '\\documentclass{article}\\begin{document}Actual fixture\\end{document}',
  );
  const pre = `import importlib.util,sys,pathlib,json,os,hashlib,base64,uuid\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('docs',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.WORKSPACE=pathlib.Path(sys.argv[2])/'workspace'\n`;
  return (
    await exec('python3', ['-c', pre + code, helper, root], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;
}
it('real guest helper excludes extra workspace bytes and rejects mixed grants, symlink roots and path escapes', async () => {
  const out = await python(`(m.WORKSPACE/'secret.tex').write_text('private')
r={'receiptId':str(uuid.uuid4()),'resultDigest':'a'*64,'names':['main.tex']};captured=m.capture(r)
assert [f['name'] for f in captured['files']]==['main.tex']
for invalid in ['../secret.tex','/secret.tex','a/../../secret.tex','a//b.tex','a/./b.tex','a/.hidden.tex']:
 try:m.safe_read(m.WORKSPACE,invalid);raise AssertionError('escape allowed')
 except ValueError:pass
f=captured['files'][0];exported=m.export({**r,'files':[f]});assert base64.b64decode(exported['files'][0]['base64']).startswith(b'\\\\documentclass')
for files in [[f,f],[{**f,'sha256':'b'*64}],[{**f,'name':'secret.tex'}]]:
 try:m.export({**r,'files':files});raise AssertionError('mixed grant allowed')
 except ValueError:pass
snapshot=m.WORKSPACE/'.dock-documents'/r['receiptId'];snapshot.chmod(0o700);(snapshot/'main.tex').unlink();(snapshot/'main.tex').symlink_to(m.WORKSPACE/'secret.tex')
try:m.export({**r,'files':[f]});raise AssertionError('symlink allowed')
except OSError:pass
print('verified')`);
  expect(out.trim()).toBe('verified');
});
it('fixed compiler invocation has a fresh user/network namespace, only compiler assets and selected inputs, and shell disabled', async () => {
  const args = JSON.parse(
    await python(
      `print(json.dumps(m.compiler_args(pathlib.Path('/tmp/selected'),pathlib.Path('/tmp/output'),'nested/-entry.tex')))`,
    ),
  ) as string[];
  expect(args[0]).toBe('/usr/bin/bwrap');
  expect(args).toContain('--unshare-all');
  expect(args).not.toContain('--proc');
  expect(args).not.toContain('/proc');
  expect(args).toContain('--clearenv');
  expect(args).toContain('--cap-drop');
  expect(args).toContain('-no-shell-escape');
  expect(args).toContain('./-entry.tex');
  expect(args).not.toContain('--share-net');
  const bindings = args.flatMap((v, i) =>
    v === '--ro-bind' || v === '--bind' ? [args.slice(i + 1, i + 3)] : [],
  );
  expect(bindings.filter(([from]) => from?.startsWith('/tmp/'))).toEqual([
    ['/tmp/selected', '/inputs'],
    ['/tmp/output', '/output'],
  ]);
  expect(
    bindings.some(([from]) => from === '/' || from === '/workspace' || from === '/home/agent'),
  ).toBe(false);
  expect(args.slice(args.indexOf('--chdir') + 1, args.indexOf('--chdir') + 2)).toEqual([
    '/inputs/nested',
  ]);
  expect(args.slice(args.indexOf('openin_any'), args.indexOf('openin_any') + 2)).toEqual([
    'openin_any',
    'p',
  ]);
});
it('real build staging validates digest and entry before executing any compiler', async () => {
  const out =
    await python(`m.subprocess.Popen=lambda *a,**k: (_ for _ in ()).throw(AssertionError('compiler must not launch'))
data=b'actual';f={'name':'main.tex','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}
for request in [{'entry':'main.tex','files':[{**f,'sha256':'f'*64}]},{'entry':'missing.tex','files':[f]},{'entry':'../escape.tex','files':[f]},{'entry':'main.tex','files':[f,f]}]:
 try:m.build(request);raise AssertionError('invalid bytes accepted')
 except ValueError:pass
print('denied')`);
  expect(out.trim()).toBe('denied');
});
it('bounds fixed guest output and timeout, stopping the whole namespace; an unverified stop remains explicit', async () => {
  let stops = 0;
  const guest = (source: string, verified = true) => {
    let child: ChildProcess;
    return {
      spawn(argv: readonly string[]) {
        expect(argv).toEqual([
          '/usr/bin/python3',
          '-I',
          '-B',
          '/opt/dock/group-documents.py',
          'export',
        ]);
        child = spawn(process.execPath, ['-e', source]);
        return child;
      },
      async close() {
        stops++;
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill('SIGKILL');
          await exited;
        }
        if (!verified) throw new Error('unverified');
      },
    };
  };
  await expect(
    runGroupDocumentGuest(guest('process.stdout.write("x".repeat(128))'), 'export', {}, 1000, 16),
  ).rejects.toThrow(/exact receipt retained/);
  await expect(
    runGroupDocumentGuest(guest('setTimeout(()=>{},10000)', false), 'export', {}, 30, 100),
  ).rejects.toThrow(/stop is unverified/);
  expect(stops).toBe(2);
});
