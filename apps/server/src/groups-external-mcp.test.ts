import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGroupsMcp } from './groups-external-mcp.js';
import { groupExternalInputs } from '@dock/shared/dist/group-external.js';
it('negotiates native MCP, exports only object-root group tools and refuses unknown capabilities', async () => {
  let calls = 0;
  const server = createGroupsMcp({
    async call(name, raw) {
      groupExternalInputs[name].parse(raw);
      calls++;
      return { groups: [] };
    },
  });
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const catalog = await client.listTools();
    expect(catalog.tools.length).toBe(17);
    expect(catalog.tools.map((tool) => tool.name)).toContain('groups_files_propose');
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('groups_files_approve');
    for (const tool of catalog.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.name).toMatch(/^groups_/);
    }
    await client.callTool({ name: 'groups_list', arguments: {} });
    expect(calls).toBe(1);
    const refused = await client.callTool({
      name: 'groups_post',
      arguments: { handle: 'invalid' },
    });
    expect(refused.isError).toBe(true);
    expect(calls).toBe(1);
    await expect(client.callTool({ name: 'dock_work_item', arguments: {} })).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
