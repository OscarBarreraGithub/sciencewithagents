import { queryOptions, sshRunner, type ClusterRunner } from './cluster.js';

/**
 * Fixed, bounded, read-only reader for one submission script on the configured SSH alias.
 * It runs only this program through the owner's existing shared sign-in (BatchMode, strict
 * host keys, never a new master). It never submits, cancels, lists or writes anything.
 */
export type RemoteScriptReader = (
  alias: string,
  path: string,
  directory: string | null,
) => Promise<{ content: string } | { error: string }>;

export const remoteScriptProgram = `d=$1
f=$2
case "$d" in "~") d=$HOME ;; "~/"*) d=$HOME/\${d#??} ;; esac
case "$f" in "~/"*) f=$HOME/\${f#??} ;; esac
if [ -n "$d" ]; then cd -- "$d" 2>/dev/null || exit 65; fi
[ -f "$f" ] && [ -r "$f" ] || exit 66
s=$(wc -c < "$f") || exit 66
[ "$s" -le 65536 ] || exit 67
cat -- "$f"
`;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const unsafe = /[\0\r\n]/;

export function sshScriptReader(runner: ClusterRunner = sshRunner, timeoutMs = 3000) {
  const read: RemoteScriptReader = async (alias, path, directory) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(alias))
      return { error: 'The SSH alias is not a configured host alias.' };
    if (!path || path.length > 1000 || unsafe.test(path) || unsafe.test(directory ?? ''))
      return { error: 'The script path cannot be read safely.' };
    const result = await runner(
      [...queryOptions, '--', alias, 'sh', '-s', '--', quote(directory ?? ''), quote(path)],
      remoteScriptProgram,
      timeoutMs,
    );
    if (result.timedOut) return { error: 'The cluster did not return the script in time.' };
    if (result.code === 65) return { error: 'The remote working directory does not exist.' };
    if (result.code === 66) return { error: 'The remote script is missing or unreadable.' };
    if (result.code === 67) return { error: 'The remote script is larger than 64 KB.' };
    if (result.code !== 0) return { error: 'The cluster could not be reached to read the script.' };
    if (Buffer.byteLength(result.stdout) > 65_536)
      return { error: 'The remote script is larger than 64 KB.' };
    return { content: result.stdout };
  };
  return read;
}
