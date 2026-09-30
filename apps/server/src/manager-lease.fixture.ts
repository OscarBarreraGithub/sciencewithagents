/** Admit a temporary manager turn for direct tool unit tests; no provider is launched. */
import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
export async function managerTool(runtime: Runtime, ...args: Parameters<Runtime['tool']>) {
  const [agentId, , name] = args;
  const store = runtime.store;
  const agent = store.agent(agentId);
  if (
    store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(args[1]) ||
    agent.role !== 'manager' ||
    ['dock_inspect', 'dock_local_job', 'dock_checkpoint', 'dock_pause_worker'].includes(name) ||
    store.runs().some((r) => r.agentId === agentId && r.status === 'running')
  )
    return runtime.tool(...args);
  const run = store.enqueue(agentId, randomUUID(), 'Fixture orchestration turn');
  if (!runtime.pulsar.reserve(store.run(run.id), new Set()))
    throw new Error('Fixture manager admission denied');
  runtime.quark.issueManagerLease(store.run(run.id));
  store.updateRun(run.id, { status: 'running' });
  try {
    return await runtime.tool(...args);
  } finally {
    store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(agentId, { status: agent.status });
  }
}
