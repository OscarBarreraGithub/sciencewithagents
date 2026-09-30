// Harmless MCP fixture. No network, credentials, arbitrary paths or command execution.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const input = createInterface({ input: process.stdin });
const forms = process.argv.includes('--forms');
const pendingForms = new Map();
let nextForm = 0;
const formSchema = {
  type: 'object',
  properties: {
    displayName: { type: 'string', title: 'Display name', minLength: 2, maxLength: 40 },
    count: { type: 'integer', title: 'Result count', minimum: 0, maximum: 5 },
    ratio: { type: 'number', title: 'Sample ratio', minimum: 0, maximum: 1, default: 0.5 },
    enabled: { type: 'boolean', title: 'Include details' },
    mode: {
      type: 'string',
      title: 'Theme',
      oneOf: [
        { const: '', title: 'No theme' },
        { const: 'dark', title: 'Dark' },
      ],
    },
    channels: {
      type: 'array',
      title: 'Channels',
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: 'web', title: 'Web' },
          { const: 'cli', title: 'Terminal' },
        ],
      },
    },
    memo: { type: 'string', title: 'Optional note' },
  },
  required: ['displayName', 'count', 'ratio', 'enabled', 'mode', 'channels'],
};
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id == null) continue;
  if (!request.method && pendingForms.has(request.id)) {
    const call = pendingForms.get(request.id);
    pendingForms.delete(request.id);
    const reply = request.result ?? { action: 'cancel', content: null };
    if (process.argv[2])
      appendFileSync(process.argv[2], JSON.stringify({ form: reply }) + '\n', { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: call,
        result: {
          content: [
            {
              type: 'text',
              text:
                reply.action === 'accept'
                  ? 'DOCK-FORM-ACCEPTED: ' + JSON.stringify(reply.content)
                  : 'DOCK-FORM-DECLINED',
            },
          ],
        },
      }) + '\n',
    );
    continue;
  }
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-dock-smoke', version: '1.0.0' },
    };
  else if (request.method === 'tools/list')
    result = {
      tools: [
        ...(forms
          ? [
              {
                name: 'collect_preferences',
                description:
                  'Ask the owner for non-sensitive fixture preferences using one MCP form, then return a verification marker.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
              },
            ]
          : []),
        {
          name: 'ping',
          description: 'Return the fixed Agent Dock MCP verification marker.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
      ],
    };
  else if (
    forms &&
    request.method === 'tools/call' &&
    request.params.name === 'collect_preferences'
  ) {
    const id = `dock-form-${++nextForm}`;
    pendingForms.set(id, request.id);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Local fixture preferences — no external action',
          requestedSchema: formSchema,
        },
      }) + '\n',
    );
    continue;
  } else if (request.method === 'tools/call' && request.params.name === 'ping') {
    if (process.argv[2]) appendFileSync(process.argv[2], 'ping\n', { mode: 0o600 });
    result = {
      content: [{ type: 'text', text: 'DOCK-MCP-READY' }],
    };
  } else if (request.method === 'ping') result = {};
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Unsupported fixture method' },
      }) + '\n',
    );
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
