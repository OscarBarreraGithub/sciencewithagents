import { DatabaseSync } from 'node:sqlite';
// Owned process fixture for real SQLite crash/enqueue races; never wired to the app.
import { groupScopeSchema } from '@dock/shared';
import { GroupEventRepository } from './group-events.js';
import { GroupPublicationController, GroupPublicationError } from './group-publication.js';
import {
  publicationBindingSchema,
  PUBLICATION_LIMITS as LIMITS,
} from './group-publication-protocol.js';
import { PublicationLoopbackFixture } from './group-publication-receiver.fixture.js';

const config = JSON.parse(process.env.GROUP_PUBLICATION_FIXTURE ?? '{}') as {
  events: string;
  journal: string;
  scope: unknown;
  binding: unknown;
  url: string;
  secret: string;
  eventId: string;
  now: number;
  mode:
    | 'enqueue'
    | 'enqueue-result'
    | 'offline'
    | 'before-effect'
    | 'after-effect'
    | 'after-receipt'
    | 'before-completion'
    | 'after-completion'
    | 'before-migration'
    | 'after-migration';
};
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 fixture required');
// Exit inside/after the real SQLite COMMIT boundary; no production crash hook.
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string): void {
  let window = false;
  if (sql === 'COMMIT') {
    try {
      if (config.mode.endsWith('migration')) {
        const row = this.prepare('SELECT version FROM gp_schema').get();
        window = row?.version === 3;
      } else if (config.mode.endsWith('completion')) {
        window = Boolean(
          this.prepare("SELECT 1 FROM gp_operations WHERE state='complete' AND compact=1").get(),
        );
      }
    } catch {
      /* Other fixture databases do not have publication tables. */
    }
    if (window && config.mode.startsWith('before-')) process.exit(80);
  }
  nativeExec.call(this, sql);
  if (window && config.mode.startsWith('after-')) process.exit(81);
};
const repo = new GroupEventRepository(config.events);
const access = repo.trustedHostScope(groupScopeSchema.parse(config.scope));
const binding = publicationBindingSchema.parse(config.binding);
const http = new PublicationLoopbackFixture(config.url, config.secret);
http.offline = config.mode === 'offline';
let now = config.now;
const controller = new GroupPublicationController(
  config.journal,
  repo,
  {
    async receipt(key, signal) {
      const response = await http.receipt(key, signal);
      if (config.mode === 'after-receipt') process.exit(79);
      return response;
    },
    async effect(packet, signal) {
      if (config.mode === 'before-effect') process.exit(77);
      const response = await http.effect(packet, signal);
      if (config.mode === 'after-effect') process.exit(78);
      return response;
    },
  },
  {
    now: () => now,
    deadline(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  },
);
const grant = controller.trustedHostRegister(binding, () => ({ access, binding }));
let operationId: string;
try {
  [operationId] = controller.enqueue(grant, [config.eventId]).operations;
} catch (error) {
  if (config.mode !== 'enqueue-result' || !(error instanceof GroupPublicationError)) throw error;
  process.stdout.write(error.code);
  controller.close();
  repo.close();
  process.exit(0);
}
if (config.mode === 'offline') {
  for (let i = 0; i < 110; i++) {
    if ((await controller.step(grant, operationId)).state !== 'offline')
      throw new Error('Definite offline fixture became terminal');
    now += LIMITS.maxBackoffMs;
  }
}
if (config.mode === 'enqueue' || config.mode === 'enqueue-result' || config.mode === 'offline') {
  process.stdout.write(operationId);
  controller.close();
  repo.close();
} else {
  await controller.step(grant, operationId);
  throw new Error('Crash fixture did not reach requested window');
}
