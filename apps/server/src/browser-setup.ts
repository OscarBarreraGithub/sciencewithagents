import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { browserSetupSchema, type BrowserSetupStatus } from '@dock/shared';
import type { Provider } from './codex.js';
import { Conflict } from './store.js';

const empty: BrowserSetupStatus = {
  checkedAt: null,
  checking: false,
  state: 'unchecked',
  nativeTools: false,
  connectedBrowsers: 0,
  message: 'Check browser setup on the selected computer.',
};
const inventory = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullish(),
      tools: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});
const observation = z.object({
  browsers: z.array(z.object({ type: z.string().optional() })),
  errors: z.array(z.string()).optional(),
});

/** Only discovery: no model turn, navigation, permission changes, or user tab contents in the response. */
export async function checkNativeBrowser(client: Provider): Promise<BrowserSetupStatus> {
  let threadId: string | undefined;
  let nativeTools = false;
  const result = (state: BrowserSetupStatus['state'], message: string, count = 0) =>
    browserSetupSchema.parse({
      ...empty,
      checkedAt: new Date().toISOString(),
      state,
      message,
      nativeTools,
      connectedBrowsers: count,
    });
  try {
    const started = z.object({ thread: z.object({ id: z.string() }) }).parse(
      await client.request('thread/start', {
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      }),
    );
    threadId = started.thread.id;
    let server;
    let modernTools = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const status = inventory.parse(
        await client.request('mcpServerStatus/list', {
          threadId,
          limit: 100,
          detail: 'toolsAndAuthOnly',
        }),
      );
      server = status.data.find((item) => item.name === 'cua_repl');
      modernTools = status.data.some(
        (item) =>
          item.name === 'node_repl' && item.runtimeStatus === 'connected' && !!item.tools.js,
      );
      if (!server || !['starting', 'notStarted'].includes(server.runtimeStatus ?? '')) break;
      await delay(500);
    }
    const legacyTools = server?.runtimeStatus === 'connected' && !!server.tools.js;
    nativeTools = legacyTools || modernTools;
    const modernUnverified = () =>
      result(
        'unavailable',
        'This check could not verify the browser connection. Ask your agent to check Chrome in this conversation.',
      );
    // Node REPL also supports the newer native Browser integration. Its presence
    // is not proof of a connected browser, and absence of legacy CUA is not proof
    // that the owner needs to install or change native permissions.
    if (!legacyTools && modernTools) return modernUnverified();
    if (!legacyTools)
      return result(
        'setup-needed',
        'Codex browser tools are not connected. Open ChatGPT’s Computer Use settings to install or reconnect the browser integration.',
      );
    const response = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })
      .parse(
        await client.request('mcpServer/tool/call', {
          threadId,
          server: 'cua_repl',
          tool: 'js',
          arguments: { code: 'await cua.getState();', title: 'Check connected browsers' },
        }),
      );
    if (response.isError)
      return result(
        'unavailable',
        'The native browser check could not run. Check the integration in Codex; existing chats are unchanged.',
      );
    for (const block of response.content) {
      if (block.type !== 'text' || !block.text?.trim().startsWith('{')) continue;
      let state;
      try {
        state = observation.safeParse(JSON.parse(block.text));
      } catch {
        continue;
      }
      if (!state.success) continue;
      const count = state.data.browsers.filter((browser) => browser.type === 'extension').length;
      if (count)
        return result(
          'connected',
          `${count} browser connection${count === 1 ? '' : 's'} reported by Codex. Individual sites may still need permission or sign-in.`,
          count,
        );
      if (modernTools) return modernUnverified();
      // Native releases can require an actual model turn for inventory. Do not invent
      // turn metadata or report an empty inventory as a verified disconnected browser.
      if (state.data.errors?.length)
        return result(
          'unavailable',
          'Browser tools are installed, but this provider could not verify the browser outside a conversation. Use the native connection check below.',
        );
      return result(
        'setup-needed',
        'No browser extension is connected to Codex. Open the browser profile with the ChatGPT extension, then check again.',
      );
    }
    return result(
      'unavailable',
      'This provider returned an unfamiliar browser status. Use its native connection check below.',
    );
  } catch {
    return result(
      'unavailable',
      'Could not verify Codex browser setup. Check that Codex is installed and its browser integration is available on this computer.',
    );
  } finally {
    if (threadId) await client.request('thread/archive', { threadId }).catch(() => {});
  }
}

/** Explicit checks are coalesced; viewing Chats never creates provider conversations. */
export class BrowserSetup {
  private value = { ...empty };
  private pending: Promise<BrowserSetupStatus> | null = null;
  private closed = false;
  constructor(private connect: () => Promise<Provider>) {}
  status() {
    const stale = this.value.checkedAt && Date.now() - Date.parse(this.value.checkedAt) > 60_000;
    return browserSetupSchema.parse({
      ...this.value,
      checking: !!this.pending,
      ...(stale
        ? {
            state: 'unchecked',
            message:
              'The previous check is over a minute old. Check again to verify the current connection.',
          }
        : {}),
    });
  }
  async check() {
    if (this.closed) throw new Conflict('Browser checks are stopping. Reconnect to try again.');
    if (this.pending) return this.pending;
    if (this.value.checkedAt && Date.now() - Date.parse(this.value.checkedAt) < 5_000)
      return this.status();
    const pending = (async () => {
      let client: Provider | undefined;
      try {
        client = await this.connect();
        // This diagnostic cannot approve native tool or app access on the owner's behalf.
        client.on('request', (id: string | number) => client?.respond(id, { decision: 'decline' }));
        this.value = await checkNativeBrowser(client);
      } catch {
        this.value = {
          ...empty,
          checkedAt: new Date().toISOString(),
          state: 'unavailable',
          message: 'Codex could not start its browser check. Use the setup instructions below.',
        };
      } finally {
        await client?.close();
      }
      return this.status();
    })();
    this.pending = pending;
    try {
      return { ...(await pending), checking: false };
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async close() {
    this.closed = true;
    await this.pending;
  }
}

export async function openBrowserSetup(action: 'codex' | 'claude') {
  if (process.platform !== 'darwin')
    throw new Conflict(
      'Use the setup instructions on the selected computer. Automatic opening is available on Mac.',
    );
  try {
    await promisify(execFile)(
      '/usr/bin/open',
      action === 'codex' ? ['-b', 'com.openai.codex'] : ['https://code.claude.com/docs/en/chrome'],
      { timeout: 10_000, maxBuffer: 8192 },
    );
  } catch {
    throw new Conflict(
      'Could not open browser setup on this computer. Use the instructions below.',
    );
  }
  return {
    message:
      action === 'codex'
        ? 'Opened ChatGPT on the selected Mac. Open Settings → Computer Use to connect your browser.'
        : 'Opened Claude’s browser setup guide on the selected Mac.',
  };
}
