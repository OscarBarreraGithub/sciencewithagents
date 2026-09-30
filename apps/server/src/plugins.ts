import { z } from 'zod';
import type { Provider } from './codex.js';
import { omitNullOptions } from './mcp.js';
import { Conflict } from './store.js';
import { setTimeout as delay } from 'node:timers/promises';

const record = z.record(z.string(), z.unknown());
const settings = (value: unknown): Record<string, unknown> =>
  value == null ? {} : record.parse(omitNullOptions(value));
const prompt = { default_tools_approval_mode: 'prompt', approvals_reviewer: 'user' };
type PluginConfig = Record<string, unknown> & {
  mcp_servers: Record<string, Record<string, unknown>>;
};
const tools = (value: unknown) =>
  Object.fromEntries(
    Object.entries(settings(value)).map(([name, options]) => [
      name,
      { ...settings(options), approval_mode: 'prompt' },
    ]),
  );

/** Private runtime overrides only. Installed plugins and credentials remain owned by Codex. */
export async function pluginPolicy(client: Provider, threadId?: string) {
  try {
    const raw = z
      .object({ config: record })
      .parse(await client.request('config/read', { includeLayers: false })).config;
    const plugins: Record<string, PluginConfig> = Object.fromEntries(
      Object.entries(settings(raw.plugins)).map(([id, value]) => {
        const config = settings(value);
        return [
          id,
          {
            ...config,
            mcp_servers: Object.fromEntries(
              Object.entries(settings(config.mcp_servers)).map(([name, value]) => {
                const server = settings(value);
                return [
                  name,
                  { ...server, default_tools_approval_mode: 'prompt', tools: tools(server.tools) },
                ];
              }),
            ),
          },
        ];
      }),
    );
    const appConfig = settings(raw.apps);
    const apps = {
      ...Object.fromEntries(
        Object.entries(appConfig)
          .filter(([id]) => id !== '_default')
          .map(([id, value]) => {
            const app = settings(value);
            return [
              id,
              {
                ...app,
                ...prompt,
                tools: tools(app.tools),
                links: Object.fromEntries(
                  Object.entries(settings(app.links)).map(([link, value]) => [
                    link,
                    { ...settings(value), ...prompt },
                  ]),
                ),
              },
            ];
          }),
      ),
      _default: { ...settings(appConfig._default), ...prompt },
    };
    const servers = new Set<string>();
    if (threadId) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      const deadline = Date.now() + 10_000;
      do {
        const schema = z.object({
          data: z.array(
            z.object({
              name: z.string().min(1).max(200),
              pluginId: z.string().nullable(),
              runtimeStatus: z.string().nullable().optional(),
              tools: z.record(z.string(), z.object({ name: z.string() }).passthrough()),
            }),
          ),
          nextCursor: z.string().nullable().optional(),
        });
        const read = async () =>
          schema.parse(
            await client.request('mcpServerStatus/list', {
              threadId,
              detail: 'toolsAndAuthOnly',
              limit: 50,
              ...(cursor ? { cursor } : {}),
            }),
          );
        let page = await read();
        while (
          page.data.some(
            (s) =>
              (s.pluginId || s.name === 'codex_apps') &&
              ['starting', 'notStarted'].includes(s.runtimeStatus ?? ''),
          ) &&
          Date.now() < deadline
        ) {
          await delay(200);
          page = await read();
        }
        for (const server of page.data) {
          if (!server.pluginId) {
            // Connected apps use MCP consent on this provider version, but have
            // their own approval configuration rather than a plugin ID.
            if (server.name === 'codex_apps' && server.runtimeStatus !== 'disabled') {
              if (server.runtimeStatus && server.runtimeStatus !== 'connected')
                throw new Error('Connected apps are not ready.');
              servers.add(server.name);
            }
            continue;
          }
          const plugin: PluginConfig = Object.hasOwn(plugins, server.pluginId)
            ? plugins[server.pluginId]
            : { mcp_servers: {} };
          if (plugin.enabled === false) continue;
          if (server.runtimeStatus && !['connected', 'disabled'].includes(server.runtimeStatus))
            throw new Error('An enabled plugin server is not ready.');
          const existing = Object.hasOwn(plugin.mcp_servers, server.name)
            ? plugin.mcp_servers[server.name]
            : {};
          plugin.mcp_servers = {
            ...plugin.mcp_servers,
            [server.name]: {
              ...existing,
              default_tools_approval_mode: 'prompt',
              tools: {
                ...tools(existing.tools),
                ...Object.fromEntries(
                  Object.values(server.tools).map((t) => [
                    t.name,
                    { ...settings(settings(existing.tools)[t.name]), approval_mode: 'prompt' },
                  ]),
                ),
              },
            },
          };
          Object.defineProperty(plugins, server.pluginId, {
            value: plugin,
            configurable: true,
            enumerable: true,
            writable: true,
          });
          servers.add(server.name);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && (seen.has(cursor) || seen.size >= 20))
          throw new Error('Plugin inventory did not converge.');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    // Per-thread feature tables replace the CLI table. Preserve all unrelated gates.
    return {
      config: { features: { ...settings(raw.features), plugins: true, apps: true }, plugins, apps },
      source: {
        features: settings(raw.features),
        plugins: settings(raw.plugins),
        apps: settings(raw.apps),
      },
      servers,
    };
  } catch {
    throw new Conflict(
      'Could not establish plugin approval policy. Return to chat and reconnect; no turn was started.',
    );
  }
}
