import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { groupScopeSchema } from '@dock/shared';
import { GroupNativeIntents } from './group-native-production.js';
import { GroupEventRepository } from './group-events.js';

it('unit host handoff stays bound across restart and never accepts changed identity/input', () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/native-intents-'));
  const events = new GroupEventRepository(join(root, 'events.sqlite'));
  let index = new GroupNativeIntents(join(root, 'intents.sqlite'));
  try {
    const group = events.createGroup('Unit'),
      context = events.createContext({
        groupId: group.groupId,
        memberId: group.memberId,
        installationId: group.installationId,
        visibility: 'shared',
        provider: 'owner',
        nativeSessionId: randomUUID(),
      });
    const input = {
      requestId: randomUUID(),
      key: randomUUID(),
      enrollmentHandle: randomUUID(),
      context,
      text: 'exact unit input',
    };
    const nativeContext = randomUUID();
    index.bind(input, nativeContext);
    expect(index.claim(input, nativeContext)).toBe(true);
    expect(index.claim(input, nativeContext)).toBe(false);
    expect(() => index.claim({ ...input, text: 'changed' }, nativeContext)).toThrow(/idempotency/);
    expect(
      index.findBinding({ ...input, context: { ...context, visibility: 'private' } }),
    ).toBeNull();
    index.close();
    index = new GroupNativeIntents(join(root, 'intents.sqlite'));
    expect(index.find(input.requestId)).toBe(nativeContext);
    expect(index.findBinding(input)).toBe(nativeContext);
    const scope = groupScopeSchema.parse({
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: context.visibility,
      source: {
        sessionId: context.sessionId,
        nativeSessionId: context.nativeSessionId,
        provider: context.provider,
        messageId: randomUUID(),
      },
      causalRefs: [],
    });
    expect(index.ownsAnchor(scope, nativeContext)).toBe(true);
    expect(
      index.ownsAnchor(
        { ...scope, source: { ...scope.source, nativeSessionId: randomUUID() } },
        nativeContext,
      ),
    ).toBe(false);
    expect(index.ownsAnchor({ ...scope, visibility: 'private' }, nativeContext)).toBe(false);
    expect(index.claim(input, nativeContext)).toBe(false);
    expect(() => index.claim(input, randomUUID())).toThrow(/idempotency/);
  } finally {
    index.close();
    events.close();
    rmSync(root, { recursive: true, force: true });
  }
});
