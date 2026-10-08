import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

export type ProviderProcessIdentity = {
  pid: number;
  parent: number;
  started: string;
  executable: string;
  argv: string[];
};

export function providerProcessIdentity(pid: number, proc = '/proc'): ProviderProcessIdentity {
  const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const parent = Number(fields[1]),
    started = fields[19];
  if (!Number.isSafeInteger(parent) || !/^\d+$/.test(started ?? ''))
    throw new Error('Native process identity is unavailable.');
  return {
    pid,
    parent,
    started: started!,
    executable: readlinkSync(join(proc, String(pid), 'exe')),
    argv: readFileSync(join(proc, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(Boolean),
  };
}

const equalArgs = (actual: string[], expected: string[]) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

/** Capture only the fixed app-server launch before any model turn, never arbitrary descendants. */
export function captureCodexProcessIdentity(
  pid: number,
  node: string,
  host: string,
  binary: string,
  args: string[],
  proc = '/proc',
): ProviderProcessIdentity[] | null {
  try {
    const wrapper = providerProcessIdentity(pid, proc);
    if (
      wrapper.executable !== realpathSync(node) ||
      !equalArgs(wrapper.argv, [node, host, binary, JSON.stringify(args)])
    )
      return null;
    const child = (parent: number) => {
      const ids = readFileSync(
        join(proc, String(parent), 'task', String(parent), 'children'),
        'utf8',
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length !== 1 || !/^\d+$/.test(ids[0]!))
        throw new Error('Unknown native launch chain.');
      const value = providerProcessIdentity(Number(ids[0]), proc);
      if (value.parent !== parent) throw new Error('Native launch parent changed.');
      return value;
    };
    const launched = child(pid);
    if (launched.executable === realpathSync(binary) && equalArgs(launched.argv, [binary, ...args]))
      return [wrapper, launched];
    // npm's shebang launcher uses the inherited Node, then spawns one native Codex leaf.
    if (
      basename(launched.argv[0] ?? '') !== 'node' ||
      launched.executable !== wrapper.executable ||
      !equalArgs(launched.argv.slice(1), [binary, ...args])
    )
      return null;
    const native = child(launched.pid);
    if (
      basename(native.argv[0] ?? '') !== 'codex' ||
      basename(native.executable) !== 'codex' ||
      !equalArgs(native.argv.slice(1), args)
    )
      return null;
    return [wrapper, launched, native];
  } catch {
    // Missing /proc is metadata uncertainty, never a reason to break ordinary provider startup.
    return null;
  }
}

export function matchesProviderProcess(expected: ProviderProcessIdentity, proc = '/proc') {
  const actual = providerProcessIdentity(expected.pid, proc);
  return (
    actual.parent === expected.parent &&
    actual.started === expected.started &&
    actual.executable === expected.executable &&
    equalArgs(actual.argv, expected.argv)
  );
}
