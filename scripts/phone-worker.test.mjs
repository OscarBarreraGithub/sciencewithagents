import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import worker from '../deployment/phone-worker.ts';

const origin = 'https://my-phone.person.workers.dev';
const env = (fetch, publicOrigin = origin) => ({
  PHONE_PUBLIC_ORIGIN: publicOrigin,
  PAIRED_APP: { fetch },
});

test('only the canonical configured HTTPS phone origin can reach the fixed binding', async () => {
  let calls = 0;
  const binding = async () => {
    calls++;
    return new Response('unreachable');
  };
  for (const url of [
    'https://attacker.example/api',
    'http://my-phone.person.workers.dev/api',
    'https://my-phone.person.workers.dev:4330/api',
    'https://preview.my-phone.person.workers.dev/api',
  ]) {
    const response = await worker.fetch(new Request(url), env(binding));
    assert.equal(response.status, 421);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const configured of [
    '',
    `${origin}/path`,
    'https://user:password@my-phone.person.workers.dev',
    'https://custom.example',
  ]) {
    const response = await worker.fetch(new Request(origin), env(binding, configured));
    assert.equal(response.status, 503);
  }
  assert.equal(calls, 0);
});

test('uploads and SSE stream without buffering while host, cookies, Origin and response headers survive', async () => {
  let uploadController;
  const upload = new ReadableStream({
    start(controller) {
      uploadController = controller;
      controller.enqueue(new TextEncoder().encode('first-upload-chunk'));
    },
  });
  let eventController;
  const events = new ReadableStream({
    start(controller) {
      eventController = controller;
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    },
  });
  let forwarded;
  const response = await worker.fetch(
    new Request(`${origin}/api/upload?destination=http://127.0.0.1:4330`, {
      method: 'POST',
      headers: {
        Cookie: '__Host-dock_device=test-cookie',
        Origin: origin,
        'Content-Type': 'application/octet-stream',
        'X-Forwarded-Proto': 'http',
      },
      body: upload,
      duplex: 'half',
    }),
    env(async (request) => {
      forwarded = request;
      assert.equal(request.bodyUsed, false);
      return new Response(events, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Set-Cookie': '__Host-dock_device=next; Secure; HttpOnly; Path=/',
          'Cache-Control': 'public, max-age=3600',
          'CDN-Cache-Control': 'public',
          'Cloudflare-CDN-Cache-Control': 'public',
        },
      });
    }),
  );
  assert.equal(
    forwarded.url,
    'http://my-phone.person.workers.dev/api/upload?destination=http://127.0.0.1:4330',
  );
  assert.equal(forwarded.headers.get('Host'), new URL(origin).host);
  assert.equal(forwarded.headers.get('Origin'), origin);
  assert.equal(forwarded.headers.get('Cookie'), '__Host-dock_device=test-cookie');
  assert.equal(forwarded.headers.get('X-Forwarded-Proto'), 'https');
  assert.equal(forwarded.redirect, 'manual');
  assert.equal(forwarded.cache, 'no-store');
  const uploadReader = forwarded.body.getReader();
  assert.equal(new TextDecoder().decode((await uploadReader.read()).value), 'first-upload-chunk');
  const eventReader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await eventReader.read()).value), 'data: first\n\n');
  uploadController.enqueue(new TextEncoder().encode('second-upload-chunk'));
  uploadController.close();
  eventController.enqueue(new TextEncoder().encode('data: second\n\n'));
  eventController.close();
  assert.equal(new TextDecoder().decode((await uploadReader.read()).value), 'second-upload-chunk');
  assert.equal((await uploadReader.read()).done, true);
  assert.equal(new TextDecoder().decode((await eventReader.read()).value), 'data: second\n\n');
  assert.equal((await eventReader.read()).done, true);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(
    response.headers.get('Set-Cookie'),
    '__Host-dock_device=next; Secure; HttpOnly; Path=/',
  );
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control'])
    assert.equal(response.headers.get(name), 'no-store');
});

test('the app receives a mismatched Origin unchanged for its CSRF rejection', async () => {
  const response = await worker.fetch(
    new Request(origin, { headers: { Origin: 'https://attacker.example' } }),
    env(async (request) => {
      assert.equal(request.headers.get('Origin'), 'https://attacker.example');
      return new Response('App origin rejection', { status: 403 });
    }),
  );
  assert.equal(response.status, 403);
});

test('redirects remain browser responses and never trigger another credential-bearing fetch', async () => {
  let calls = 0;
  const response = await worker.fetch(
    new Request(origin, { headers: { Cookie: '__Host-dock_device=test-cookie' } }),
    env(async (request) => {
      calls++;
      assert.equal(request.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'https://external.example' } });
    }),
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://external.example');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('connector failure returns a retryable response without private exception details', async () => {
  const response = await worker.fetch(
    new Request(origin),
    env(async () => {
      throw new Error('private tunnel token and local details');
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(!(await response.text()).includes('private'));
});

test('workerd forwards an actual WebSocket upgrade and frames through the fixed service binding', async () => {
  // Use the existing group-service Wrangler toolchain; no additional package is needed.
  const require = createRequire(
    realpathSync(
      resolve(
        process.env.DOCK_WRANGLER_PACKAGE ??
          'apps/group-service/node_modules/wrangler/package.json',
      ),
    ),
  );
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const { buildSync } = require('esbuild');
  const built = buildSync({
    entryPoints: ['deployment/phone-worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      workers: [
        {
          name: 'phone-under-test',
          modules: true,
          script: built.outputFiles[0].text,
          compatibilityDate: '2026-10-07',
          bindings: { PHONE_PUBLIC_ORIGIN: origin },
          serviceBindings: { PAIRED_APP: 'paired-test-app' },
        },
        {
          name: 'paired-test-app',
          modules: true,
          compatibilityDate: '2026-10-07',
          script: `export default { fetch(request) {
          if (request.headers.get('Host') !== 'my-phone.person.workers.dev' ||
              request.headers.get('Origin') !== '${origin}' ||
              request.headers.get('Cookie') !== '__Host-dock_device=test-cookie' ||
              request.headers.get('X-Forwarded-Proto') !== 'https')
            return new Response('Missing app authentication context', { status: 403 });
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].addEventListener('message', (event) => pair[1].send(event.data));
          return new Response(null, { status: 101, webSocket: pair[0] });
        } };`,
        },
      ],
    }),
  );
  try {
    const response = await runtime.dispatchFetch(`${origin}/api/terminal/socket`, {
      headers: {
        Upgrade: 'websocket',
        Origin: origin,
        Cookie: '__Host-dock_device=test-cookie',
      },
    });
    assert.equal(response.status, 101);
    assert.ok(response.webSocket);
    response.webSocket.accept();
    const message = once(response.webSocket, 'message', { signal: AbortSignal.timeout(5000) });
    response.webSocket.send('paired-session-frame');
    assert.equal((await message)[0].data, 'paired-session-frame');
    response.webSocket.close(1000, 'Owned test complete');
  } finally {
    await runtime.dispose();
  }
});
