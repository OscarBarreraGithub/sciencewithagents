import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { repoRoot } from './paths.js';
import { prepareLocalAccess, LocalAccess } from './local-access.js';
import { GroupsExternalClient } from './groups-external-client.js';
import { GroupsConversationJournal } from './groups-conversation-journal.js';

function directory() {
  const base = join(repoRoot, 'data/groups-external-tests');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, 'case-'));
}
it('authenticates the exact existing local companion and never sends its long-lived owner credential', async () => {
  const root = directory(),
    app = Fastify();
  let access: LocalAccess,
    owner = '',
    reads = 0;
  app.get('/api/local-access/proof', async (request) => access.proof(request.query));
  app.get('/api/groups', async (request, reply) => {
    expect(request.headers.authorization).not.toContain(owner);
    if (access.authenticate(request.headers.authorization, 'GET', '/api/groups') !== 'owner')
      return reply.code(401).send({ error: 'Denied' });
    reads++;
    return {
      groups: [],
      service: { configured: true, message: 'Configured fixture' },
      native: { available: false, message: 'No provider in fixture' },
    };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const config = prepareLocalAccess(root, port);
    owner = config.owner;
    access = new LocalAccess(config);
    const client = new GroupsExternalClient(root);
    expect(await client.call('groups_list', {})).toMatchObject({
      groups: [],
      service: { configured: true },
    });
    expect(reads).toBe(1);
    const stranger = directory();
    try {
      prepareLocalAccess(stranger, port);
      await expect(new GroupsExternalClient(stranger).call('groups_list', {})).rejects.toThrow(
        'does not match',
      );
      expect(reads).toBe(1);
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('runs the packaged hooks with durable selection and restores context after a compact event, excluding subagents', async () => {
  const root = directory(),
    configFile = join(root, 'connection.json'),
    sessionId = randomUUID(),
    handle = randomUUID();
  writeFileSync(
    configFile,
    JSON.stringify({ version: 1, installation: repoRoot, dataDirectory: root }),
    { mode: 0o600 },
  );
  let journal = new GroupsConversationJournal(root);
  async function hook(input: unknown, helper = false) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(repoRoot, 'plugins/groups/entry.mjs'), 'hook'], {
        env: {
          ...process.env,
          SWA_GROUPS_CONFIG: configFile,
          SWA_GROUPS_HELPER: helper ? '1' : '0',
        },
        stdio: 'pipe',
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (part) => {
        stdout += part;
      });
      child.stderr.on('data', (part) => {
        stderr += part;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0 && !stderr) resolve(stdout);
        else reject(new Error('Owned hook fixture failed'));
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  try {
    const off = JSON.parse(
      await hook({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' }),
    );
    expect(off.hookSpecificOutput.additionalContext).toContain('sharing is OFF');
    expect(off.hookSpecificOutput.additionalContext).toContain(sessionId);
    expect(journal.jobs()).toHaveLength(0);
    expect(
      await hook({
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'An unselected private prompt',
      }),
    ).toBe('');
    journal.select({ handle, sessionId, key: randomUUID() });
    expect(
      await hook({
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Chosen prompt',
      }),
    ).toBe('');
    await hook({
      session_id: sessionId,
      hook_event_name: 'Stop',
      last_assistant_message: 'Chosen final reply',
    });
    await hook({
      session_id: randomUUID(),
      hook_event_name: 'Stop',
      last_assistant_message: 'Unselected private text',
    });
    await hook({
      session_id: sessionId,
      hook_event_name: 'Stop',
      agent_id: 'worker',
      last_assistant_message: 'Private subagent text',
    });
    await hook(
      {
        session_id: sessionId,
        hook_event_name: 'Stop',
        last_assistant_message: 'Background summary helper text',
      },
      true,
    );
    const compact = JSON.parse(
      await hook({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'compact' }),
    );
    expect(compact.hookSpecificOutput.additionalContext).toContain('this exact conversation');
    journal.close();
    journal = new GroupsConversationJournal(root);
    expect(journal.jobs()).toHaveLength(1);
    expect(journal.jobs()[0].text).toContain('Chosen final reply');
    expect(JSON.stringify(journal.jobs())).not.toContain('Private subagent');
    await hook({ session_id: sessionId, hook_event_name: 'SessionStart', cwd: root });
    expect(journal.sessionFolder(sessionId)?.cwd).toBe(root);
    const beforeProof = journal.db.prepare('SELECT count(*) n FROM gc_session_folders').get()!.n;
    await hook({
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      agent_id: 'worker',
      cwd: join(root, 'missing'),
      prompt: 'Subagent folder must not enroll',
    });
    expect(journal.sessionFolder(sessionId)?.cwd).toBe(root);
    expect(journal.db.prepare('SELECT count(*) n FROM gc_session_folders').get()!.n).toBe(
      beforeProof,
    );
    await hook({
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Selected prompt with missing folder',
    });
    expect(journal.sessionFolder(sessionId)).toBeNull();
    await hook({
      session_id: sessionId,
      hook_event_name: 'Stop',
      cwd: join(root, 'not-present'),
      last_assistant_message: 'Selected final with invalid folder still journals',
    });
    expect(journal.sessionFolder(sessionId)).toBeNull();
    expect(
      journal
        .jobs()
        .some((job) => job.text.includes('Selected final with invalid folder still journals')),
    ).toBe(true);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
