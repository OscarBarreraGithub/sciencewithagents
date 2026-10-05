import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

const template = readFileSync(
  new URL('../../../scripts/cluster/notebook.sbatch', import.meta.url),
  'utf8',
);
const selection = template.match(/port="\$\([\s\S]*?\n\)"/)![0];
function selectPort(min?: string, max?: string) {
  const env = { ...process.env };
  delete env.SWA_NOTEBOOK_PORT_MIN;
  delete env.SWA_NOTEBOOK_PORT_MAX;
  if (min !== undefined) env.SWA_NOTEBOOK_PORT_MIN = min;
  if (max !== undefined) env.SWA_NOTEBOOK_PORT_MAX = max;
  // Execute the actual template selection without starting Jupyter or writing home files.
  return spawnSync('bash', ['-c', `set -e\n${selection}\nprintf '%s' "$port"`], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
}

it('selects a FASRC-range port and binds Jupyter on all compute-node IPv4 interfaces', () => {
  const result = selectPort();
  expect(result.status, result.stderr).toBe(0);
  expect(Number(result.stdout)).toBeGreaterThanOrEqual(6818);
  expect(Number(result.stdout)).toBeLessThanOrEqual(11845);
  expect(template).toContain('sock.bind(("0.0.0.0", candidate))');
  expect(template).toContain('jupyter lab --no-browser --ip=0.0.0.0 --port="$port"');
});

it('honors owner-configured bounds and fails when none is free', async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const port = address.port;
    const unavailable = selectPort(String(port), String(port));
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('No available notebook port');
    const min = Math.min(port, 65515);
    const available = selectPort(String(min), String(min + 20));
    expect(available.status, available.stderr).toBe(0);
    expect(Number(available.stdout)).not.toBe(port);
    expect(Number(available.stdout)).toBeGreaterThanOrEqual(min);
    expect(Number(available.stdout)).toBeLessThanOrEqual(min + 20);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  ['1023', '11845'],
  ['6818', '65536'],
  ['11845', '6818'],
  ['6818.5', '11845'],
  ['invalid', '11845'],
])('rejects invalid notebook port bounds %s..%s before starting Jupyter', (min, max) => {
  const result = selectPort(min, max);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Notebook port bounds must be integers');
  expect(result.stdout).toBe('');
});
