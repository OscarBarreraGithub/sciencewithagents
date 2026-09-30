// Harmless URL elicitation fixture. Only a generated loopback page; no real sign-in.
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const requests = new Map();
const log = (event) =>
  appendFileSync(process.argv[2], JSON.stringify(event) + '\n', { mode: 0o600 });
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const finish = (request, marker) => {
  if (request.finished) return;
  request.finished = true;
  send({ id: request.callId, result: { content: [{ type: 'text', text: marker }] } });
};
let origin;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // The page's own POST needs its same-origin Origin header. The incoming link
  // separately suppresses Agent Dock's referrer with rel/referrerPolicy.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  const request = [...requests.values()].find((value) => value.path === req.url);
  if (!request || req.headers.host !== new URL(origin).host) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'GET') {
    log({ event: 'visit', id: request.id, referrer: req.headers.referer ?? null });
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><title>Agent Dock URL fixture</title><h1>Local URL fixture</h1><p>No credentials or external account. Opening this page has not completed the step.</p><form method="post"><button>Complete fixture step</button></form>',
    );
  } else if (req.method === 'POST' && req.headers.origin === origin && request.accepted) {
    if (!request.finished) {
      log({ event: 'completed', id: request.id });
      finish(request, 'DOCK-URL-COMPLETED');
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Fixture step completed</h1>');
  } else res.writeHead(403).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id == null) continue;
    if (!request.method && requests.has(request.id)) {
      const original = requests.get(request.id);
      if (original.answered) continue;
      original.answered = true;
      original.accepted = request.result?.action === 'accept';
      log({ event: 'reply', id: original.id, result: request.result ?? null });
      if (!original.accepted) finish(original, 'DOCK-URL-DECLINED');
      continue;
    }
    if (request.method === 'initialize')
      send({
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-dock-url-smoke', version: '1.0.0' },
        },
      });
    else if (request.method === 'tools/list')
      send({
        id: request.id,
        result: {
          tools: [
            {
              name: 'complete_local_step',
              description:
                'Ask the owner to complete a harmless local page step via URL elicitation, then return the result. No sign-in or external service.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            },
          ],
        },
      });
    else if (request.method === 'tools/call' && request.params.name === 'complete_local_step') {
      const id = randomUUID(),
        path = `/fixture/${randomUUID()}`;
      requests.set(id, {
        id,
        path,
        callId: request.id,
        accepted: false,
        answered: false,
        finished: false,
      });
      log({ event: 'requested', id });
      send({
        id,
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Complete a local fixture step — no sign-in',
          url: origin + path,
          elicitationId: id,
        },
      });
    } else if (request.method === 'ping') send({ id: request.id, result: {} });
    else send({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
} finally {
  server.closeAllConnections();
  server.close();
}
