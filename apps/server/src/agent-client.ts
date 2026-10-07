import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  agentAppRequestSchema,
  agentManagedGoalUpdateRequestSchema,
  managedGoalSchema,
  agentTaskRequestSchema,
  agentTaskResultSchema,
  projectAppSchema,
  projectSchema,
  capacityStatusSchema,
  resourceStatusSchema,
  clusterStatusSchema,
  pulsarStatusSchema,
  quarkStatusSchema,
  localJobsStatusSchema,
} from '@dock/shared';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from './runtime.js';
import { Conflict, publicTask } from './store.js';

const configurationSchema = z
  .object({
    version: z.literal(1),
    origin: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{4,5}$/)
      .refine((value) => {
        const port = Number(new URL(value).port);
        return port >= 1024 && port <= 65535;
      }),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Configuration = z.infer<typeof configurationSchema>;
const file = (root: string) => join(root, 'agent-client.json');

/** Host-owned capability, never a provider token. Refuse links/shared files. */
export function readAgentClient(root: string): Configuration {
  const fd = openSync(file(root), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('The QUARK client file must be private and owned by this account.');
    return configurationSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
export function prepareAgentClient(root: string, port: number) {
  let existing: Configuration | undefined;
  try {
    existing = readAgentClient(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = configurationSchema.parse({
    version: 1,
    origin: `http://127.0.0.1:${port}`,
    secret: existing?.secret ?? randomBytes(32).toString('hex'),
  });
  if (existing?.origin !== config.origin) {
    const temporary = `${file(root)}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file(root));
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return config;
}
export function acceptsAgentClient(config: Configuration, authorization: unknown) {
  if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization))
    return false;
  return timingSafeEqual(Buffer.from(authorization.slice(7)), Buffer.from(config.secret));
}

const query = z.object({ projectId: z.string().uuid().optional() }).strict();
const jobsSchema = z.object({
  scheduling: pulsarStatusSchema,
  accounting: quarkStatusSchema,
  localJobs: localJobsStatusSchema,
});
export function registerAgentClient(
  app: FastifyInstance,
  runtime: Runtime,
  config?: Configuration,
) {
  const store = runtime.store;
  app.register(async (client) => {
    client.addHook('onRequest', async (request, reply) => {
      if (!config)
        return reply.code(404).send({ error: 'Agent client access is unavailable on this entry.' });
      if (!acceptsAgentClient(config, request.headers.authorization))
        return reply.code(401).send({ error: 'Use the private local QUARK client.' });
    });
    client.get('/api/agent-client/projects', async () =>
      store
        .projects()
        .filter(
          (p) =>
            p.id !== runtime.frontdesk.status().projectId && p.id !== runtime.resources.projectId(),
        )
        .map((p) => projectSchema.parse(p)),
    );
    client.get('/api/agent-client/usage', async () => runtime.capacity.status());
    client.get('/api/agent-client/resources', async () => runtime.resources.status());
    client.get('/api/agent-client/cluster', async () => runtime.cluster.status());
    client.get('/api/agent-client/jobs', async (request) => {
      const { projectId } = query.parse(request.query);
      if (projectId) store.project(projectId);
      return jobsSchema.parse({
        scheduling: runtime.pulsar.status(projectId),
        accounting: runtime.quark.status(projectId),
        localJobs: runtime.localJobs.status(projectId),
      });
    });
    client.post('/api/agent-client/apps', async (request) => {
      const body = z
        .object({ request: agentAppRequestSchema, file: z.string().min(1).max(4096) })
        .strict()
        .parse(request.body);
      const { key, managerId, ...input } = body.request;
      return runtime.saveAppFromClient(managerId, key, input, body.file);
    });
    client.post('/api/agent-client/goal-updates', async (request) => {
      const body = z
        .object({ request: agentManagedGoalUpdateRequestSchema, file: z.string().min(1).max(4096) })
        .strict()
        .parse(request.body);
      const { key, managerId, runId, ...input } = body.request;
      return runtime.updateGoalFromClient(managerId, runId, key, input, body.file);
    });
    client.post('/api/agent-client/tasks', async (request, reply) => {
      const input = agentTaskRequestSchema.parse(request.body);
      if (
        [runtime.frontdesk.status().projectId, runtime.resources.projectId()].includes(
          input.projectId,
        )
      )
        throw new Conflict('Choose a work project, not an internal assistant.');
      store.project(input.projectId);
      // Synchronize before the transaction; no async gap exists before caps and enqueue.
      runtime.quark.sync();
      const result = store.operation(input.key, { kind: 'agent-client.task', ...input }, () => {
        if (input.task.parentId && store.task(input.task.parentId).projectId !== input.projectId)
          throw new Conflict('Parent task is outside this project.');
        const task = store.addTask(input.projectId, {
          ...input.task,
          managerId: input.managerId,
          parentId: input.task.parentId ?? null,
        });
        const allowances = input.allowances.map((cap) =>
          runtime.quark.createTaskBudget({
            key: input.key,
            projectId: task.projectId,
            taskId: task.id,
            ...cap,
          }),
        );
        const run = store.enqueue(
          task.managerId,
          `agent-client:${input.key}`,
          `Please manage task ${task.id}: ${task.title}. Outcome: ${task.goal}. Acceptance: ${task.acceptance}. This request arrived through the local QUARK client. Inspect its task caps before delegating. Each cap covers only its named provider/window. Inherit the task and its caps for all follow-up work; do not create replacement tasks to avoid them. Delegate bounded work and bring back reviewed results.`,
        );
        store.setSetting(`pulsar:task:${run.id}`, task.id);
        return agentTaskResultSchema.parse({ task: publicTask(task), runId: run.id, allowances });
      });
      runtime.kick();
      return reply.code(201).send(result);
    });
  });
}

/** Only fixed, typed operations. No arbitrary URL, path, shell or RPC forwarding. */
export async function agentClientCommand(
  root: string,
  command: string | undefined,
  args: string[],
) {
  if (!command || command === 'help')
    return {
      commands: [
        'quark projects',
        'quark usage',
        'quark resources',
        'quark cluster',
        'quark jobs [project-id]',
        'quark dispatch <request.json>',
        'quark app <request.json>',
        'quark goal-update <request.json>',
      ],
      guide: 'docs/AGENT_USAGE_ACCESS.md',
    };
  const reads = ['projects', 'usage', 'resources', 'cluster', 'jobs'];
  const writes = ['dispatch', 'app', 'goal-update'];
  if (!reads.includes(command) && !writes.includes(command))
    throw new Error('Unknown QUARK command. Use quark help.');
  if (args.length > (['jobs', ...writes].includes(command) ? 1 : 0))
    throw new Error('Unexpected QUARK arguments.');
  let body: unknown;
  if (writes.includes(command)) {
    if (!args[0]) throw new Error(`${command} needs a JSON request file with a saved UUID key.`);
    const fd = openSync(args[0], constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024)
        throw new Error('Use a JSON request file under 64 KB.');
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      body =
        command === 'app' || command === 'goal-update'
          ? {
              request: (command === 'app'
                ? agentAppRequestSchema
                : agentManagedGoalUpdateRequestSchema
              ).parse(value),
              file: realpathSync(args[0]),
            }
          : agentTaskRequestSchema.parse(value);
    } finally {
      closeSync(fd);
    }
  }
  const projectId = command === 'jobs' && args[0] ? z.string().uuid().parse(args[0]) : undefined;
  let config: Configuration;
  try {
    config = readAgentClient(root);
  } catch {
    throw new Error(
      'The private QUARK client is unavailable. Open sciencewithagents on this computer and use its configured data directory.',
    );
  }
  const path =
    command === 'app'
      ? 'apps'
      : command === 'goal-update'
        ? 'goal-updates'
        : body
          ? 'tasks'
          : command;
  let response: Response;
  try {
    response = await fetch(
      `${config.origin}/api/agent-client/${path}${projectId ? `?projectId=${projectId}` : ''}`,
      {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${config.secret}`,
          Origin: config.origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  } catch {
    throw new Error(
      body
        ? 'QUARK could not confirm the request. Keep the same file and UUID; retry to check its receipt, never invent a new key.'
        : 'QUARK is unavailable. Open sciencewithagents and retry.',
    );
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      `QUARK ${response.status}: ${typeof payload?.error === 'string' ? payload.error.slice(0, 1000) : 'Request unavailable.'}`,
    );
  }
  const value: unknown = await response.json();
  if (command === 'usage') {
    const status = capacityStatusSchema.parse(value);
    return {
      ...status,
      providers: status.providers.map((provider) => ({
        ...provider,
        windows: provider.windows.map((window) => ({
          ...window,
          remainingPercent: 100 - window.usedPercent,
        })),
      })),
    };
  }
  if (command === 'resources') return resourceStatusSchema.parse(value);
  if (command === 'cluster') return clusterStatusSchema.parse(value);
  if (command === 'projects') return z.array(projectSchema).parse(value);
  if (command === 'jobs') return jobsSchema.parse(value);
  if (command === 'goal-update') return managedGoalSchema.parse(value);
  if (command === 'app')
    return z
      .union([projectAppSchema, z.object({ removed: z.literal(true), id: z.string() }).strict()])
      .parse(value);
  return agentTaskResultSchema.parse(value);
}
