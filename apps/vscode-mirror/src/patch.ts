import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, type Class, type NewExpression } from 'acorn';
import { ancestor, simple } from 'acorn-walk';

export const bridgeSymbol = 'agent-dock.codex-mirror.connection.v1';
// Legacy restoration evidence, not an allowlist for newly installed versions.
export const supportedVersion = '26.908.40401';
export const originalHash = '820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f';
export const anchor = 'let b=new vI(t.extensionUri,c);e.push(b);';
export const hook = `${anchor}/*agent-dock-mirror:v1*/globalThis[Symbol.for("${bridgeSymbol}")]=b;e.push({dispose:()=>{delete globalThis[Symbol.for("${bridgeSymbol}")]}});/*end-agent-dock-mirror*/`;
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const marker = '/*agent-dock-mirror:v2*/';

export function patchedSource(source: string, version: string): string {
  const incompatible = () =>
    new Error(
      `Codex ${version} has an internal connection layout that is not supported. sciencewithagents could not locate one compatible connection. Nothing was changed; keep using Codex normally.`,
    );
  let tree;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs' });
  } catch {
    throw incompatible();
  }
  const candidates: { node: Class; name: string }[] = [];
  const names = new Set<string>();
  ancestor(tree, {
    Identifier(node) {
      names.add(node.name);
    },
    Class(node, _state, parents) {
      const members = node.body.body
        .filter((member) => member.type !== 'StaticBlock')
        .filter((member) => !member.static && !member.computed && member.key.type === 'Identifier');
      const named = (name: string) =>
        members.find((member) => member.key.type === 'Identifier' && member.key.name === name);
      const providers = named('providers');
      if (
        providers?.type !== 'PropertyDefinition' ||
        providers.value?.type !== 'NewExpression' ||
        providers.value.callee.type !== 'Identifier' ||
        providers.value.callee.name !== 'Map' ||
        named('initialized')?.type !== 'PropertyDefinition' ||
        !['registerProvider', 'sendRequest', 'sendProviderRequest'].every(
          (name) => named(name)?.type === 'MethodDefinition',
        )
      )
        return;
      const parent = parents.at(-2);
      const name =
        node.type === 'ClassDeclaration'
          ? node.id?.name
          : parent?.type === 'VariableDeclarator' &&
              parent.init === node &&
              parent.id.type === 'Identifier'
            ? parent.id.name
            : parent?.type === 'AssignmentExpression' &&
                parent.right === node &&
                parent.left.type === 'Identifier'
              ? parent.left.name
              : undefined;
      if (!name) throw incompatible();
      candidates.push({ node, name });
    },
  });
  if (candidates.length !== 1) throw incompatible();
  const name = candidates[0]!.name;
  const constructions: NewExpression[] = [];
  simple(tree, {
    NewExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === name) constructions.push(node);
    },
  });
  if (constructions.length !== 1) throw incompatible();
  const construction = constructions[0]!;
  const uri = construction.arguments[0];
  if (
    uri?.type !== 'MemberExpression' ||
    uri.computed ||
    uri.property.type !== 'Identifier' ||
    uri.property.name !== 'extensionUri' ||
    uri.object.type !== 'Identifier'
  )
    throw incompatible();
  // No minifier names, version pin, source execution or second provider process.
  // The native constructor/arguments are evaluated once. A failed optional hook
  // cannot interrupt native activation; disposal cannot erase a newer bridge.
  let reference = '__agentDockConnection';
  while (names.has(reference)) reference += '_';
  const symbol = `globalThis[Symbol.for("${bridgeSymbol}")]`;
  const replacement = `${marker}((${reference})=>{try{${uri.object.name}.subscriptions.push({dispose:()=>{if(${symbol}===${reference})delete ${symbol}}});${symbol}=${reference}}catch{}return ${reference}})(${source.slice(construction.start, construction.end)})/*end-agent-dock-mirror*/`;
  return source.slice(0, construction.start) + replacement + source.slice(construction.end);
}

function recognizedPatch(source: string, original: string, version: string) {
  if (
    hash(original) === originalHash &&
    original.split(anchor).length === 2 &&
    source === original.replace(anchor, hook)
  )
    return true;
  return source === patchedSource(original, version);
}

function hasPatch(source: string) {
  return source.includes('/*agent-dock-mirror:');
}

async function regular(path: string) {
  if (!(await lstat(path)).isFile())
    throw new Error('Refusing to modify a linked or non-regular extension file.');
  return readFile(path, 'utf8');
}
async function replace(path: string, expected: string, next: string) {
  if ((await regular(path)) !== expected)
    throw new Error('Codex changed during patching. Nothing was overwritten.');
  const temporary = `${path}.mirror-${randomUUID()}.tmp`;
  try {
    const mode = (await lstat(path)).mode & 0o777;
    await writeFile(temporary, next, { flag: 'wx', mode });
    // Updates never restore an old file over a newly installed extension version.
    if ((await regular(path)) !== expected)
      throw new Error('Codex changed during patching. The original was preserved.');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function patch(root: string): Promise<'patched' | 'already-patched'> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This preview supports macOS on Apple Silicon only. Nothing was patched.');
  const manifest = JSON.parse(await regular(join(root, 'package.json'))) as { version: string };
  const path = join(root, 'out', 'extension.js');
  const source = await regular(path);
  const backup = `${path}.agent-dock-mirror-original`;
  if (hasPatch(source)) {
    const original = await regular(backup);
    if (!recognizedPatch(source, original, manifest.version))
      throw new Error('The existing patch was modified. Refusing to overwrite it.');
    return 'already-patched';
  }
  const next = patchedSource(source, manifest.version);
  try {
    await writeFile(backup, source, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await regular(backup)) !== source)
      throw error;
  }
  await replace(path, source, next);
  return 'patched';
}
export async function restore(root: string): Promise<void> {
  const manifest = JSON.parse(await regular(join(root, 'package.json'))) as { version: string };
  const path = join(root, 'out', 'extension.js');
  const source = await regular(path);
  if (!hasPatch(source)) return;
  const original = await regular(`${path}.agent-dock-mirror-original`);
  if (!recognizedPatch(source, original, manifest.version))
    throw new Error('The Codex file no longer matches our patch. Nothing was restored over it.');
  await replace(path, source, original);
}
