import { expect, it, vi } from 'vitest';
import { DemoProvider } from './demo.js';
import { pluginPolicy } from './plugins.js';

it('forces plugin, app, account and per-tool prompts while preserving disabled capabilities and feature gates', async () => {
  const client = new DemoProvider();
  const raw = {
    config: {
      features: {
        plugins: false,
        apps: false,
        hooks: false,
        multi_agent: false,
        shell_tool: false,
      },
      plugins: {
        'fixture@local': {
          enabled: true,
          mcp_servers: {
            docs: {
              disabled_tools: ['delete'],
              tools: { write: { approval_mode: 'approve', enabled: false } },
            },
          },
        },
        'disabled@local': { enabled: false },
      },
      apps: {
        _default: {
          enabled: true,
          destructive_enabled: false,
          default_tools_approval_mode: 'approve',
        },
        fixture: {
          enabled: false,
          default_tools_approval_mode: 'approve',
          tools: { write: { approval_mode: 'approve', enabled: false } },
          links: {
            account: { approvals_reviewer: 'auto_review', default_tools_approval_mode: 'approve' },
          },
        },
      },
    },
  };
  const original = JSON.stringify(raw);
  vi.spyOn(client, 'request').mockImplementation(async (method) =>
    method === 'config/read'
      ? raw
      : {
          data: [
            {
              name: 'docs',
              pluginId: 'fixture@local',
              tools: { write: { name: 'write' }, read: { name: 'read' } },
            },
            { name: 'other', pluginId: 'fixture@local', tools: {} },
            { name: 'disabled', pluginId: 'disabled@local', tools: {} },
            { name: 'codex_apps', pluginId: null, tools: {} },
            { name: 'unselected', pluginId: null, tools: {} },
          ],
          nextCursor: null,
        },
  );
  const result = await pluginPolicy(client, 'thread');
  expect(result.config.features).toEqual({ ...raw.config.features, plugins: true, apps: true });
  expect(result.config.plugins['fixture@local'].mcp_servers.docs).toMatchObject({
    disabled_tools: ['delete'],
    default_tools_approval_mode: 'prompt',
    tools: {
      write: { approval_mode: 'prompt', enabled: false },
      read: { approval_mode: 'prompt' },
    },
  });
  expect(result.config.apps).toMatchObject({
    _default: {
      enabled: true,
      destructive_enabled: false,
      default_tools_approval_mode: 'prompt',
      approvals_reviewer: 'user',
    },
    fixture: {
      enabled: false,
      default_tools_approval_mode: 'prompt',
      tools: { write: { enabled: false, approval_mode: 'prompt' } },
      links: { account: { approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' } },
    },
  });
  expect([...result.servers]).toEqual(['docs', 'other', 'codex_apps']);
  expect(JSON.stringify(raw)).toBe(original);
});

it('waits for plugin inventory readiness and refuses failed enabled transports', async () => {
  const client = new DemoProvider();
  let reads = 0;
  vi.spyOn(client, 'request').mockImplementation(async (method) =>
    method === 'config/read'
      ? { config: {} }
      : {
          data: [
            {
              name: 'docs',
              pluginId: 'fixture@local',
              runtimeStatus: ++reads === 1 ? 'starting' : 'connected',
              tools: { read: { name: 'read' } },
            },
          ],
          nextCursor: null,
        },
  );
  expect((await pluginPolicy(client, 'thread')).servers.has('docs')).toBe(true);
  expect(reads).toBe(2);
  vi.mocked(client.request).mockImplementation(async (method) =>
    method === 'config/read'
      ? { config: {} }
      : {
          data: [{ name: 'codex_apps', pluginId: null, runtimeStatus: 'failed', tools: {} }],
          nextCursor: null,
        },
  );
  await expect(pluginPolicy(client, 'thread')).rejects.toThrow(
    'Could not establish plugin approval policy',
  );
});

it('fails closed on malformed or looping plugin inventory without exposing diagnostic values', async () => {
  const client = new DemoProvider();
  vi.spyOn(client, 'request').mockImplementation(async (method) =>
    method === 'config/read' ? { config: {} } : { data: [], nextCursor: 'repeat' },
  );
  await expect(pluginPolicy(client, 'thread')).rejects.toThrow(
    'Could not establish plugin approval policy',
  );
  vi.mocked(client.request).mockRejectedValue(new Error('private-fixture-value'));
  await expect(pluginPolicy(client, 'thread')).rejects.not.toThrow('private-fixture-value');
});
