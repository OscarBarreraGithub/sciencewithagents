import { afterEach, expect, it, vi } from 'vitest';
import { NotebookDelegations } from './notebook-delegations.js';
import { notebookLifetimes } from './notebook-gateway.js';
afterEach(() => vi.useRealTimers());
it('renews only the original launch and revokes when its source phone is removed', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {}),
    unwatch = vi.fn();
  const delegations = new NotebookDelegations(send);
  let removePhone: () => void = () => {};
  delegations.track('selected-host', 'exact-receipt', (close) => {
    removePhone = close;
    return unwatch;
  });
  await vi.advanceTimersByTimeAsync(notebookLifetimes.renewalMs);
  expect(send).toHaveBeenCalledWith('selected-host', 'renew', 'exact-receipt');
  removePhone();
  expect(unwatch).toHaveBeenCalledOnce();
  expect(send).toHaveBeenLastCalledWith('selected-host', 'revoke', 'exact-receipt');
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(send).toHaveBeenCalledTimes(count);
  delegations.close();
});
it('stops renewal after a transport failure and safely absorbs failed revocation', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {
    throw Error('Disconnected');
  });
  const delegations = new NotebookDelegations(send),
    unwatch = vi.fn();
  delegations.track('selected-host', 'exact-receipt', () => unwatch);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(send.mock.calls).toEqual([
    ['selected-host', 'renew', 'exact-receipt'],
    ['selected-host', 'revoke', 'exact-receipt'],
  ]);
  expect(unwatch).toHaveBeenCalledOnce();
  delegations.close();
});
