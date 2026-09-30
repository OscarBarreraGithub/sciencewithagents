import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { mcpNameSchema } from '@dock/shared';
import type { Provider } from './codex.js';
import { Conflict } from './store.js';

const exec = promisify(execFile);
/** Read configuration, not tools. Never forward commands, environments or diagnostics to the UI. */
export async function disabledMcpOverride(binary: string, cwd: string, featureArgs: string[]) {
  let names: string[];
  try {
    const result = await exec(binary, ['mcp', 'list', '--json', ...featureArgs], {
      cwd,
      timeout: 10_000,
      maxBuffer: 2_000_000,
    });
    names = z
      .array(z.object({ name: mcpNameSchema }))
      .parse(JSON.parse(result.stdout))
      .map((s) => s.name);
  } catch {
    throw new Error(
      'Could not read Codex MCP configuration. Check it locally with codex mcp list.',
    );
  }
  // CLI dotted paths don't unquote key segments. Quote names inside a TOML table instead.
  return disabledMcpTable(names);
}
export function disabledMcpTable(names: string[]) {
  return (
    'mcp_servers={' +
    names.map((name) => `${JSON.stringify(mcpNameSchema.parse(name))}={enabled=false}`).join(',') +
    '}'
  );
}

const serverSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: z.record(z.string(), z.object({}).passthrough()).optional(),
  })
  .passthrough();
// config/read serializes absent options as null; thread overrides are converted to TOML,
// which has no null. Preserve transport settings privately without inventing empty values.
export function omitNullOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullOptions);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, omitNullOptions(item)]),
    );
  return value;
}
export async function managedMcpConfig(client: Provider, selected: string[]) {
  const raw = await client.request('config/read', { includeLayers: false });
  const parsed = z
    .object({
      config: z.object({ mcp_servers: z.record(mcpNameSchema, serverSchema).default({}) }),
    })
    .safeParse(raw);
  if (!parsed.success)
    throw new Conflict('Codex returned an unsupported MCP configuration. Inspect it locally.');
  const servers = parsed.data.config.mcp_servers;
  for (const name of selected)
    if (!Object.hasOwn(servers, name))
      throw new Conflict(`MCP server ${name} is not available in this Codex runtime.`);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        // Overrides replace CLI-injected server definitions: policy alone loses transport.
        // This object stays inside the private provider adapter, never in the public catalog.
        ...(omitNullOptions(server) as Record<string, unknown>),
        enabled: selected.includes(name),
        default_tools_approval_mode: 'prompt',
        tools: Object.fromEntries(
          Object.entries(server.tools ?? {}).map(([tool, settings]) => [
            tool,
            { ...(omitNullOptions(settings) as Record<string, unknown>), approval_mode: 'prompt' },
          ]),
        ),
      },
    ]),
  );
}
