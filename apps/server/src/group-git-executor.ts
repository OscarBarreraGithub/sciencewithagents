import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath, stat } from 'node:fs/promises';
import { GroupGitBlocked } from './group-git.js';
import type { GitExecutor } from './group-git-journal.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
/** Only configuration-free builtin metadata commands. Network/pack/helper/hook commands
 * are never spawned. Process groups are also checked, not just the original child's PID.
 * A crash in the durable spawn-intent/PID window stays fenced (no uncertain replay). */
export class HostGitExecutor implements GitExecutor {
  readonly id = randomUUID();
  readonly #db: DatabaseSync;
  #binary: { path: string; hash: string } | null = null;
  private constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS gg_executors(id TEXT PRIMARY KEY,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gg_processes(token TEXT PRIMARY KEY,executor TEXT NOT NULL,repository TEXT NOT NULL,pid INTEGER,state TEXT NOT NULL);`);
    this.#db.prepare('INSERT INTO gg_executors VALUES (?,?)').run(this.id, process.pid);
  }
  static async open(path: string, gitExecutable: string): Promise<HostGitExecutor> {
    const executable = await realpath(gitExecutable);
    const info = await stat(executable);
    if (!info.isFile() || info.mode & 0o022 || info.size > 64 * 1024 * 1024)
      throw new GroupGitBlocked('Untrusted Git executable');
    const executor = new HostGitExecutor(path);
    executor.#binary = {
      path: executable,
      hash: createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
    };
    return executor;
  }
  async #groupAlive(pid: number): Promise<boolean> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/ps', ['-axo', 'pid=,pgid='], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let length = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Process census timeout'));
      }, 3000);
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          child.kill('SIGKILL');
          reject(new Error('Process census limit'));
        } else chunks.push(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error('Process census unavailable'));
        else resolve(Buffer.concat(chunks).toString());
      });
    });
    return output.split('\n').some((line) => Number(line.trim().split(/\s+/)[1]) === pid);
  }
  async quiescent(executorId: string, repositoryId: string): Promise<boolean> {
    const owner = this.#db.prepare('SELECT pid FROM gg_executors WHERE id=?').get(executorId);
    if (!owner || (executorId !== this.id && alive(owner.pid as number))) return false;
    const processes = this.#db
      .prepare('SELECT pid,state FROM gg_processes WHERE executor=? AND repository=?')
      .all(executorId, repositoryId);
    for (const row of processes) {
      if (row.state === 'closed') continue;
      if (
        row.pid === null ||
        alive(row.pid as number) ||
        (await this.#groupAlive(row.pid as number))
      )
        return false;
    }
    return true;
  }
  async run(
    repositoryId: string,
    directory: string,
    argv: readonly string[],
    input: Buffer | undefined,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<Buffer> {
    const binary = this.#binary!;
    if (
      createHash('sha256')
        .update(await readFile(binary.path))
        .digest('hex') !== binary.hash
    )
      throw new GroupGitBlocked('Git executable changed');
    const command = argv.find((value) =>
      [
        'rev-parse',
        'ls-files',
        'status',
        'for-each-ref',
        'cat-file',
        'rev-list',
        'ls-tree',
      ].includes(value),
    );
    if (!command) throw new GroupGitBlocked('Unsupported host Git builtin');
    const token = randomUUID();
    if ((this.#db.prepare('SELECT count(*) AS n FROM gg_processes').get()!.n as number) >= 65536)
      throw new GroupGitBlocked('Git process journal capacity');
    this.#db
      .prepare('INSERT INTO gg_processes VALUES (?,?,?,?,?)')
      .run(token, this.id, repositoryId, null, 'spawn-intent');
    return new Promise<Buffer>((resolve, reject) => {
      let child;
      try {
        child = spawn(binary.path, argv, {
          cwd: directory,
          detached: true,
          env: {
            PATH: '/nonexistent',
            HOME: directory,
            LANG: 'C',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_LFS_SKIP_SMUDGE: '1',
            GIT_EXEC_PATH: '/nonexistent',
            GIT_PAGER: 'cat',
            GIT_OPTIONAL_LOCKS: '0',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (child.pid)
          this.#db
            .prepare('UPDATE gg_processes SET pid=?,state=? WHERE token=?')
            .run(child.pid, 'running', token);
      } catch (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const timer = setTimeout(
        () => stop(new Error('Host Git deadline')),
        Math.min(30000, Math.max(1, timeoutMs)),
      );
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxOutputBytes) stop(new Error('Host Git output limit'));
        else chunks.push(chunk);
      });
      // Errors remain local and never contain raw private paths/argv in shared events.
      child.stderr.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxOutputBytes) stop(new Error('Host Git output limit'));
      });
      child.on('error', (error) => {
        failure = error;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.on('close', async (code) => {
        clearTimeout(timer);
        try {
          if (child.pid && (await this.#groupAlive(child.pid)))
            throw new Error('Git descendants are not quiescent');
          this.#db.prepare('UPDATE gg_processes SET state=? WHERE token=?').run('closed', token);
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error('Host Git metadata unavailable'));
          else resolve(Buffer.concat(chunks));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  close(): void {
    this.#db.close();
  }
}
