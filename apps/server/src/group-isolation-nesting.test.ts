import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const macIt = process.platform === 'darwin' && process.arch === 'arm64' ? it : it.skip;

macIt('preserves exact minimal nesting profiles, argv, environment, OS facts and stderr', () => {
  mkdirSync('data/tests', { recursive: true });
  const fixture = mkdtempSync('data/tests/group-nesting-');
  try {
    const cwd = realpathSync.native(fixture);
    const home = join(cwd, 'home');
    mkdirSync(home, { mode: 0o700 });
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };
    const strict = [
      '(version 1)',
      '(deny default)',
      '(allow process-fork)',
      '(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal "/usr/bin/sandbox-exec"))',
      '(allow sysctl-read)',
      '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (literal "/bin/sh") (literal "/bin/bash") (literal "/usr/bin/sandbox-exec") (literal "/private/var/select/sh") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
      `(allow file-read-metadata (path-ancestors ${JSON.stringify(cwd)}))`,
      '(allow file-write-data (literal "/dev/null"))',
      `(allow file-read* (literal ${JSON.stringify(cwd)}))`,
    ].join('\n');
    const sandbox = '/usr/bin/sandbox-exec';
    const deniedRead = join(cwd, 'outside-file.txt');
    const deniedWrite = join(cwd, 'outside-write.txt');
    writeFileSync(deniedRead, 'fabricated-private-canary');
    const variants = [
      { name: 'strict-shell', profile: strict, command: ['/bin/sh', '-c', 'printf shell-ok'] },
      {
        name: 'strict-permissive-inner',
        profile: strict,
        command: [sandbox, '-p', '(version 1)(allow default)', '/bin/sh', '-c', 'printf nested-ok'],
      },
      {
        name: 'strict-identical-inner',
        profile: strict,
        command: [sandbox, '-p', strict, '/bin/sh', '-c', 'printf nested-ok'],
      },
      // Diagnostic only. No filesystem/process/network permissions are added and the
      // production profile is never modified or retried with this allowance.
      {
        name: 'sandbox-mac-syscall-permissive-inner',
        profile: strict + '\n(allow system-mac-syscall (mac-policy-name "Sandbox"))',
        command: [sandbox, '-p', '(version 1)(allow default)', '/bin/sh', '-c', 'printf nested-ok'],
      },
      {
        name: 'identical-inner-denials',
        profile: strict,
        command: [
          sandbox,
          '-p',
          strict,
          '/bin/sh',
          '-c',
          'if IFS= read -r value < "$1"; then printf read-escape; else printf read-denied; fi; if printf escaped > "$2"; then printf write-escape; else printf write-denied; fi; if /usr/bin/true; then printf exec-escape; else printf exec-denied; fi',
          'canary',
          deniedRead,
          deniedWrite,
        ],
      },
    ];
    const probes = variants.map(({ name, profile, command }) => {
      const argv = ['-p', profile, ...command];
      const result = spawnSync(sandbox, argv, { cwd, env, encoding: 'utf8', timeout: 3_000 });
      return {
        name,
        executable: sandbox,
        profile,
        argv,
        cwd,
        env,
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      };
    });
    // Preserve evidence even if the observed compatibility changes and assertions fail.
    mkdirSync('data/group-isolation-evidence', { recursive: true, mode: 0o700 });
    const fact = (executable: string, argv: string[]) => {
      const result = spawnSync(executable, argv, { env, encoding: 'utf8', timeout: 3_000 });
      return {
        executable,
        argv,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    writeFileSync(
      `data/group-isolation-evidence/nesting-${Date.now()}.json`,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          node: process.version,
          uname: fact('/usr/bin/uname', ['-a']),
          swVers: fact('/usr/bin/sw_vers', []),
          probes,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    expect(probes[0]).toMatchObject({ status: 0, stdout: 'shell-ok', stderr: '' });
    for (const probe of [probes[1], probes[3]])
      expect(probe).toMatchObject({
        status: 71,
        stdout: '',
        stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n',
      });
    expect(probes[2]).toMatchObject({ status: 0, stdout: 'nested-ok', stderr: '' });
    expect(probes[4]).toMatchObject({ status: 0, stdout: 'read-deniedwrite-deniedexec-denied' });
    expect(probes[4]!.stderr).toContain('Operation not permitted');
    expect(readFileSync(deniedRead, 'utf8')).toBe('fabricated-private-canary');
    expect(existsSync(deniedWrite)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
