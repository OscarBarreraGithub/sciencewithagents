import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostingApprovalHash } from '../src/crypto.js';
import worker from '../src/index.js';

const origin = 'https://groups.example';
const approval = 'a'.repeat(64);
async function configure() {
  Object.assign(env, {
    HOSTING_MODE: 'hosted',
    HOSTING_ORIGIN: origin,
    HOSTING_APPROVAL_HASH: await hostingApprovalHash(approval),
    GROUP_SETUP_HASH: '',
    GROUP_BETA_SERVICE_ID: '',
    GROUP_BETA_KEYS: '',
  });
  const lookup = vi.fn();
  const environment: Env = {
    ...env,
    GROUPS: new Proxy(env.GROUPS, {
      get(target, name, receiver) {
        return name === 'getByName' ? lookup : Reflect.get(target, name, receiver);
      },
    }),
  };
  return { environment, lookup };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  Object.assign(env, {
    HOSTING_MODE: 'disabled',
    HOSTING_ORIGIN: '',
    HOSTING_APPROVAL_HASH: '',
    GROUP_SETUP_HASH: '',
    GROUP_BETA_SERVICE_ID: '',
    GROUP_BETA_KEYS: '',
  });
});

describe('public invitation handoff boundary', () => {
  it('serves static GET/HEAD before API capability checks without network or DO calls', async () => {
    const { environment, lookup } = await configure();
    const outbound = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request(`${origin}/join`), environment);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('Groups → Join by invitation');
    expect(html).toContain('https://github.com/OscarBarreraGithub/sciencewithagents#groups-beta');
    expect(html).toContain('history.replaceState(history.state');
    expect(html).toContain('navigator.clipboard.writeText(invitation)');
    expect(html).toContain('field.setSelectionRange(0, field.value.length)');
    // Even irrelevant/invalid capabilities cannot make this static route call authority APIs.
    const same = await worker.fetch(
      new Request(`${origin}/join`, {
        headers: { 'X-Group-Admission': 'invalid', 'X-Hosting-Approval': 'invalid' },
      }),
      environment,
    );
    expect(await same.text()).toBe(html);
    const head = await worker.fetch(new Request(`${origin}/join`, { method: 'HEAD' }), environment);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect([...head.headers]).toEqual([...response.headers]);
    expect(lookup).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('retains valid hosted configuration and exact HTTPS origin requirements', async () => {
    const { environment, lookup } = await configure();
    for (const url of [
      'http://groups.example/join',
      'https://other.example/join',
      'https://groups.example:8443/join',
      'http://127.0.0.1/join',
    ]) {
      const response = await worker.fetch(new Request(url), environment);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'hosting_disabled' });
    }
    for (const change of [
      { HOSTING_MODE: 'disabled' },
      { HOSTING_MODE: 'local-test' },
      { HOSTING_APPROVAL_HASH: '' },
      { HOSTING_ORIGIN: `${origin}/` },
      { HOSTING_ORIGIN: 'https://groups.example/private' },
    ]) {
      const response = await worker.fetch(
        new Request(`${origin}/join`),
        Object.assign({}, environment, change),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'hosting_disabled' });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('opens no other unauthenticated endpoint and never reflects query or body data', async () => {
    const { environment, lookup } = await configure();
    const group = '11111111-1111-4111-a111-111111111111';
    const canary = 'PRIVATE-INVITATION-CANARY';
    for (const path of [
      '/',
      '/join/',
      '/favicon.ico',
      `/join?invite=${canary}`,
      `/join#${canary}`,
      '/v1/create',
      ...['', '/delivery', '/documents', '/actions', '/promotion'].map(
        (suffix) => `/v1/groups/${group}${suffix}`,
      ),
    ]) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
        const response = await worker.fetch(
          new Request(`${origin}${path}`, { method }),
          environment,
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('Content-Type')).not.toContain('text/html');
        expect(await response.text()).not.toContain(canary);
      }
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await worker.fetch(
        new Request(`${origin}/join`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invite: canary }),
        }),
        environment,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(canary);
    }
    // The existing API gate remains enforced after correct hosting approval.
    const api = await worker.fetch(
      new Request(`${origin}/v1/groups/${group}`, {
        method: 'POST',
        headers: {
          'X-Hosting-Approval': approval,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kind: 'status' }),
      }),
      environment,
    );
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ ok: false, error: 'denied' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('denies framing and external loads with exact hashes for the static inline content', async () => {
    const { environment } = await configure();
    const response = await worker.fetch(new Request(`${origin}/join`), environment);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const csp = response.headers.get('Content-Security-Policy');
    for (const rule of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(csp).toContain(rule);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    const html = await response.text();
    for (const tag of ['script', 'style']) {
      const inline = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
      expect(inline).toBeDefined();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inline));
      const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)));
      expect(csp).toContain(`${tag}-src 'sha256-${encoded}'`);
    }
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
    expect(html).not.toMatch(
      /innerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|console\./,
    );
    expect(html).not.toMatch(/<script[^>]+src=|<iframe|<form|<img|http:\/\//);
  });
});
