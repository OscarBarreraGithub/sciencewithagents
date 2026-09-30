import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, type Class, type NewExpression } from 'acorn';
import { simple } from 'acorn-walk';

export const claudeBridgeSymbol = 'agent-dock.claude-mirror.host.v1';
const marker = '/*agent-dock-claude-mirror:v2*/';
const hash = (source: string) => createHash('sha256').update(source).digest('hex');

// Locate executable structure, not a release number, minifier name or text that
// could occur inside a string/comment. Runtime checks validate the actual channel.
export function patchedClaudeSource(source: string, version: string) {
  const incompatible = () =>
    new Error(
      `Claude Code ${version} has changed its internal connection layout. sciencewithagents could not locate one compatible host. Nothing was changed; keep using Claude Code normally.`,
    );
  let tree;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs' });
  } catch {
    throw incompatible();
  }
  const hosts: Class[] = [];
  simple(tree, {
    Class(node) {
      if (
        node.id &&
        [
          ['allComms', 'Set'],
          ['sessionStates', 'Map'],
        ].every(([field, container]) =>
          node.body.body.some(
            (member) =>
              member.type === 'PropertyDefinition' &&
              !member.static &&
              !member.computed &&
              member.key.type === 'Identifier' &&
              member.key.name === field &&
              member.value?.type === 'NewExpression' &&
              member.value.callee.type === 'Identifier' &&
              member.value.callee.name === container,
          ),
        )
      )
        hosts.push(node);
    },
  });
  if (hosts.length !== 1) throw incompatible();
  const constructions: NewExpression[] = [];
  simple(tree, {
    NewExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === hosts[0]!.id!.name)
        constructions.push(node);
    },
  });
  if (constructions.length !== 1) throw incompatible();
  const construction = constructions[0]!;
  const [uri, context] = construction.arguments;
  if (
    uri?.type !== 'MemberExpression' ||
    uri.computed ||
    uri.property.type !== 'Identifier' ||
    uri.property.name !== 'extensionUri' ||
    uri.object.type !== 'Identifier' ||
    context?.type !== 'Identifier' ||
    uri.object.name !== context.name
  )
    throw incompatible();
  // Evaluate the original constructor exactly once with its original arguments.
  // A hook failure must not prevent native activation; no new process or network.
  const hook = `${marker}((__agentDockHost)=>{try{globalThis[Symbol.for("${claudeBridgeSymbol}")]=__agentDockHost;${context.name}.subscriptions.push({dispose:()=>{if(globalThis[Symbol.for("${claudeBridgeSymbol}")]===__agentDockHost)delete globalThis[Symbol.for("${claudeBridgeSymbol}")]}})}catch{}return __agentDockHost})(${source.slice(construction.start, construction.end)})/*end-agent-dock-claude-mirror*/`;
  return source.slice(0, construction.start) + hook + source.slice(construction.end);
}

function recognizedPatch(source: string, original: string, version: string) {
  // Preserve already-installed 0.2.0 hooks and their exact undo path. These hashes
  // are legacy restoration evidence, NOT an allowlist for new provider versions.
  const legacyAnchor = 'H5$=U,$.subscriptions.push(U),';
  if (
    hash(original) === '60bde6e451ab360d03cfc30f6ef19cb4c8d4e43c92b56861dd0d957f07836a25' &&
    source ===
      original.replace(
        legacyAnchor,
        `${legacyAnchor}/*agent-dock-claude-mirror:v1*/globalThis[Symbol.for("${claudeBridgeSymbol}")]=U,$.subscriptions.push({dispose:()=>{delete globalThis[Symbol.for("${claudeBridgeSymbol}")]}}),/*end-agent-dock-claude-mirror*/`,
      )
  )
    return true;
  return source === patchedClaudeSource(original, version);
}

function hasPatch(source: string) {
  return source.includes('/*agent-dock-claude-mirror:');
}
async function regular(path: string) {
  if (!(await lstat(path)).isFile())
    throw new Error('Refusing to modify a linked or non-regular extension file.');
  return readFile(path, 'utf8');
}
async function replace(path: string, expected: string, next: string) {
  if ((await regular(path)) !== expected)
    throw new Error('Claude Code changed during setup. Nothing was overwritten.');
  const temporary = `${path}.mirror-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: (await lstat(path)).mode & 0o777 });
    if ((await regular(path)) !== expected)
      throw new Error('Claude Code changed during setup. Its original was preserved.');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function patchClaude(root: string): Promise<'patched' | 'already-patched'> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This preview supports macOS on Apple Silicon only. Nothing was patched.');
  const manifest = JSON.parse(await regular(join(root, 'package.json'))) as { version: string };
  const path = join(root, 'extension.js');
  const source = await regular(path);
  const backup = `${path}.agent-dock-mirror-original`;
  if (hasPatch(source)) {
    if (!recognizedPatch(source, await regular(backup), manifest.version))
      throw new Error('The existing Claude Code patch was modified. Refusing to overwrite it.');
    return 'already-patched';
  }
  const next = patchedClaudeSource(source, manifest.version);
  try {
    await writeFile(backup, source, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await regular(backup)) !== source)
      throw error;
  }
  await replace(path, source, next);
  return 'patched';
}
export async function restoreClaude(root: string) {
  const manifest = JSON.parse(await regular(join(root, 'package.json'))) as { version: string };
  const path = join(root, 'extension.js');
  const source = await regular(path);
  if (!hasPatch(source)) return;
  const original = await regular(`${path}.agent-dock-mirror-original`);
  if (!recognizedPatch(source, original, manifest.version))
    throw new Error(
      'The Claude Code file no longer matches our patch. Nothing was restored over it.',
    );
  await replace(path, source, original);
}
