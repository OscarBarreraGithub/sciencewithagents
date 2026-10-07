import { z } from 'zod';
import { digest, type ObserveRequest } from './group-git.js';

export interface ObservationSchedule {
  epoch: string;
  sequence: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
  pending: { request: ObserveRequest; attempts: number; blocked: boolean } | null;
}
const minInterval = 60_000;
/** Persist the returned schedule BEFORE executing request. Hints never bypass the one-minute
 * floor; uncertain outcomes retain the same request/ID even if newer tips are announced. */
export function planObservation(
  schedule: ObservationSchedule,
  now: number,
  candidate: Omit<ObserveRequest, 'operationId'>,
): { schedule: ObservationSchedule; request: ObserveRequest | null } {
  z.string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .parse(schedule.epoch);
  z.number().int().nonnegative().parse(schedule.sequence);
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(schedule.nextAttemptAt) ||
    (schedule.lastAttemptAt !== null && !Number.isSafeInteger(schedule.lastAttemptAt))
  )
    throw new Error('Invalid host clock');
  if (
    now < schedule.nextAttemptAt ||
    (schedule.lastAttemptAt !== null && now < schedule.lastAttemptAt + minInterval) ||
    schedule.pending?.blocked
  )
    return { schedule, request: null };
  const pending = schedule.pending ?? {
    request: { ...candidate, operationId: `observe_${schedule.epoch}_${schedule.sequence}` },
    attempts: 0,
    blocked: false,
  };
  return {
    schedule: { ...schedule, lastAttemptAt: now, nextAttemptAt: now + minInterval, pending },
    request: pending.request,
  };
}
export function settleObservation(
  schedule: ObservationSchedule,
  operationId: string,
  outcome: 'verified' | 'uncertain' | 'blocked',
  now: number,
): ObservationSchedule {
  if (!schedule.pending || schedule.pending.request.operationId !== operationId)
    throw new Error('Stale observation settlement');
  if (!Number.isSafeInteger(now) || schedule.lastAttemptAt === null || now < schedule.lastAttemptAt)
    throw new Error('Invalid host clock');
  if (outcome === 'verified')
    return {
      ...schedule,
      sequence: schedule.sequence + 1,
      pending: null,
      nextAttemptAt: Math.max(now, schedule.lastAttemptAt + minInterval),
    };
  const attempts = Math.min(schedule.pending.attempts + 1, 16);
  const delay = Math.min(3_600_000, minInterval * 2 ** Math.min(attempts - 1, 6));
  const jitter = parseInt(digest([operationId, attempts]).slice(0, 6), 16) % Math.floor(delay / 10);
  return {
    ...schedule,
    nextAttemptAt: now + delay + jitter,
    pending: { ...schedule.pending, attempts, blocked: outcome === 'blocked' },
  };
}
