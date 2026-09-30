import { expect, it, vi } from 'vitest';
import { DemoProvider } from './demo.js';
import { disabledMcpOverride, disabledMcpTable, managedMcpConfig } from './mcp.js';
const command = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: command }),
}));

it('reads the inventory with identical feature gates and never exposes credential-bearing failures', async () => {
  command.mockResolvedValue({
    stdout: JSON.stringify([
      { name: 'local.docs', transport: { env: { SECRET: 'fixture-secret' } } },
    ]),
  });
  expect(await disabledMcpOverride('codex', '/fixture', ['--disable', 'computer_use'])).toBe(
    'mcp_servers={"local.docs"={enabled=false}}',
  );
  expect(command).toHaveBeenLastCalledWith(
    'codex',
    ['mcp', 'list', '--json', '--disable', 'computer_use'],
    expect.objectContaining({ cwd: '/fixture', timeout: 10_000 }),
  );
  command.mockRejectedValue(new Error('fixture-secret'));
  await expect(disabledMcpOverride('codex', '/fixture', [])).rejects.toThrow(
    'Could not read Codex MCP configuration',
  );
});

it('disables quoted and dotted server names with a TOML table, not broken CLI path quoting', () => {
  expect(disabledMcpTable(['local.docs', 'worker-tools'])).toBe(
    'mcp_servers={"local.docs"={enabled=false},"worker-tools"={enabled=false}}',
  );
  expect(() => disabledMcpTable(['x}=true'])).toThrow();
});

it('selects only configured MCP servers and overrides per-tool automatic grants', async () => {
  const client = new DemoProvider();
  const original = {
    selected: {
      enabled: false,
      command: 'fixture',
      env: { PRIVATE: 'fixture-secret' },
      tool_timeout_sec: null,
      default_tools_approval_mode: 'approve',
      tools: { write: { approval_mode: 'approve', output_token_limit: 100, optional: null } },
    },
    unselected: { enabled: true, url: 'https://fixture.invalid' },
  };
  vi.spyOn(client, 'request').mockResolvedValue({ config: { mcp_servers: original } });
  const result = await managedMcpConfig(client, ['selected']);
  expect(result.selected).toMatchObject({
    enabled: true,
    default_tools_approval_mode: 'prompt',
    tools: { write: { approval_mode: 'prompt' } },
  });
  expect(result.unselected.enabled).toBe(false);
  expect(result.selected).toMatchObject({ command: 'fixture', env: { PRIVATE: 'fixture-secret' } });
  expect(result.selected).not.toHaveProperty('tool_timeout_sec');
  expect(result.selected.tools.write).toEqual({ approval_mode: 'prompt', output_token_limit: 100 });
  expect(original.selected.tools.write.approval_mode).toBe('approve');
  await expect(managedMcpConfig(client, ['unknown'])).rejects.toThrow('not available');
  vi.mocked(client.request).mockResolvedValue({
    config: { mcp_servers: { invalid: 'fixture-secret' } },
  });
  await expect(managedMcpConfig(client, [])).rejects.toThrow('unsupported MCP configuration');
});
