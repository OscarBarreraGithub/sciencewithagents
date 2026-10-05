import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { BrowserSetup, checkNativeBrowser } from './browser-setup.js';
import { proxyPath } from './hosts.js';
import type { Provider } from './codex.js';
function client({
  missing = false,
  fail = false,
  state = { browsers: [] } as unknown,
  servers = [{ name: 'cua_repl', runtimeStatus: 'connected', tools: { js: {} } }],
} = {}) {
  const p = new EventEmitter() as Provider;
  p.ready = true;
  p.close = vi.fn(async () => {});
  p.respond = vi.fn();
  p.request = vi.fn(async (method: string) => {
    if (method === 'thread/start') return { thread: { id: 'diagnostic' } };
    if (method === 'thread/archive') return {};
    if (method === 'mcpServerStatus/list')
      return {
        data: missing ? [] : servers,
      };
    if (method === 'mcpServer/tool/call') {
      if (fail) throw new Error('Bearer private-token never returned');
      return {
        content: [
          { type: 'text', text: 'Native documentation' },
          { type: 'text', text: JSON.stringify(state) },
        ],
      };
    }
    throw new Error('Unexpected request');
  });
  return p;
}
describe('native browser discovery', () => {
  it('only reports extension connections and does not leak tabs, credentials or app inventory', async () => {
    const p = client({
      state: {
        browsers: [
          { type: 'extension', tabs: [{ url: 'private-url', title: 'secret-title' }] },
          { type: 'iab' },
        ],
        apps: [{ displayName: 'private-app' }],
      },
    });
    const result = await checkNativeBrowser(p);
    expect(result).toMatchObject({ state: 'connected', connectedBrowsers: 1, nativeTools: true });
    expect(JSON.stringify(result)).not.toMatch(/private-url|secret-title|private-app/);
    expect(p.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(p.request).toHaveBeenCalledWith('thread/archive', { threadId: 'diagnostic' });
    expect(p.request).toHaveBeenCalledWith(
      'mcpServer/tool/call',
      expect.objectContaining({
        arguments: { code: 'await cua.getState();', title: 'Check connected browsers' },
      }),
    );
  });
  it('distinguishes a missing extension from a failed or incompatible native inventory', async () => {
    expect((await checkNativeBrowser(client())).state).toBe('setup-needed');
    const failed = await checkNativeBrowser(
      client({ state: { browsers: [], errors: ['Missing turn metadata'] } }),
    );
    expect(failed.state).toBe('unavailable');
    expect(failed.message).toContain('outside a conversation');
    expect((await checkNativeBrowser(client({ missing: true }))).nativeTools).toBe(false);
    const p = client({ fail: true });
    const result = await checkNativeBrowser(p);
    expect(result.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(p.request).toHaveBeenCalledWith('thread/archive', { threadId: 'diagnostic' });
  });
  it('coalesces checks, never launches on a status read, and closes owned providers', async () => {
    const p = client();
    const connect = vi.fn(async () => p);
    const setup = new BrowserSetup(connect);
    expect(setup.status().state).toBe('unchecked');
    expect(connect).not.toHaveBeenCalled();
    await Promise.all([setup.check(), setup.check()]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(p.close).toHaveBeenCalledTimes(1);
    await setup.close();
    await expect(setup.check()).rejects.toThrow('stopping');
  });
  it('does not mistake modern native tools for missing browser setup or a verified connection', async () => {
    const p = client({
      servers: [{ name: 'node_repl', runtimeStatus: 'connected', tools: { js: {} } }],
    });
    expect(await checkNativeBrowser(p)).toMatchObject({
      state: 'unavailable',
      nativeTools: true,
      connectedBrowsers: 0,
      message: expect.stringContaining('in this conversation'),
    });
    expect(p.request).not.toHaveBeenCalledWith('mcpServer/tool/call', expect.anything());
    expect(p.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(p.request).toHaveBeenCalledWith('thread/archive', { threadId: 'diagnostic' });
  });
  it('keeps mixed native inventories unverified unless an extension connection is observed', async () => {
    const servers = [
      { name: 'cua_repl', runtimeStatus: 'connected', tools: { js: {} } },
      { name: 'node_repl', runtimeStatus: 'connected', tools: { js: {} } },
    ];
    expect((await checkNativeBrowser(client({ servers }))).state).toBe('unavailable');
    expect(
      await checkNativeBrowser(client({ servers, state: { browsers: [{ type: 'extension' }] } })),
    ).toMatchObject({ state: 'connected', nativeTools: true, connectedBrowsers: 1 });
    expect(
      await checkNativeBrowser(
        client({ servers: [{ name: 'node_repl', runtimeStatus: 'disabled', tools: { js: {} } }] }),
      ),
    ).toMatchObject({ state: 'setup-needed', nativeTools: false });
  });
  it('only proxies the fixed authenticated setup endpoints', () => {
    expect(proxyPath('GET', '/browser/setup')).toBe('/api/browser/setup');
    expect(proxyPath('POST', '/browser/check')).toBe('/api/browser/check');
    expect(proxyPath('POST', '/browser/open-setup')).toBe('/api/browser/open-setup');
    expect(proxyPath('POST', '/browser/execute')).toBeNull();
    expect(proxyPath('GET', '/browser/check?command=anything')).toBeNull();
  });
});
