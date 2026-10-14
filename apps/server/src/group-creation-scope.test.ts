import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const state = vi.hoisted(() => ({
  scope: 'original',
  api: vi.fn(),
  ApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../../web/src/api', () => ({
  apiScope: () => state.scope,
  api: state.api,
  ApiError: state.ApiError,
}));
import { bindCreatedGroup } from '../../web/src/groups/group-creation-binding';
import { groupJoinHandoffPrompt } from '../../web/src/groups/group-join-prompt';
afterEach(() => {
  vi.unstubAllGlobals();
  state.api.mockReset();
  state.scope = 'original';
});
function setup() {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}
it.each(['host', 'unmount'])(
  'never sends a dependent binding after %s changes during status',
  async (change) => {
    const values = setup(),
      key = randomUUID(),
      handle = randomUUID(),
      selectionKey = randomUUID();
    values.set('original-create-receipt', key);
    let current = true,
      reply!: (value: unknown) => void;
    state.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const result = bindCreatedGroup(key, handle, selectionKey, 'original', () => current);
    if (change === 'host') state.scope = 'other';
    else current = false;
    reply({
      revision: 0,
      selectionKey: null,
      workspacePath: null,
      available: false,
      message: 'Choose',
    });
    await expect(result).rejects.toThrow('computer or setup view changed');
    expect(state.api).toHaveBeenCalledTimes(1);
    expect(values.get('original-create-receipt')).toBe(key);
  },
);
it('retains the exact original binding receipt when its reply arrives after a host change', async () => {
  const values = setup(),
    key = randomUUID(),
    handle = randomUUID(),
    selectionKey = randomUUID();
  let reply!: (value: unknown) => void;
  state.api
    .mockResolvedValueOnce({
      revision: 0,
      selectionKey: null,
      workspacePath: null,
      available: false,
      message: 'Choose',
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
  const result = bindCreatedGroup(key, handle, selectionKey);
  await vi.waitFor(() => expect(state.api).toHaveBeenCalledTimes(2));
  const storage = `swa:groups:original:create-bind:${key}`,
    exact = values.get(storage);
  state.scope = 'other';
  reply({
    revision: 1,
    selectionKey,
    workspacePath: '/private/project',
    available: true,
    message: 'Selected',
  });
  await expect(result).rejects.toThrow('computer or setup view changed');
  expect(values.get(storage)).toBe(exact);
  expect([...values.keys()]).not.toContain(`swa:groups:other:create-bind:${key}`);
});
it('quotes the supplied join values and names the existing trusted no-network helper', () => {
  const invitation = 'https://creator.example/#private-invitation',
    displayName = 'Name "quoted"';
  const prompt = groupJoinHandoffPrompt(displayName, invitation);
  expect(prompt).toContain(JSON.stringify({ displayName, invitation }));
  expect(prompt).toContain('join <existing-app-data> <private-invitation-file>');
  expect(prompt).toContain('without a network request');
  expect(prompt).toContain('same-owner 0600');
  expect(prompt).toContain('Do not ask me to name/recreate a group or choose a folder');
});

it('finishes only a definite refused folder while retaining its exact original binding receipt', async () => {
  const values = setup(),
    key = randomUUID(),
    handle = randomUUID(),
    selectionKey = randomUUID();
  state.api
    .mockResolvedValueOnce({
      revision: 0,
      selectionKey: null,
      workspacePath: null,
      available: false,
      message: 'Choose',
    })
    .mockRejectedValueOnce(
      new state.ApiError(
        'The folder moved; repair in Manage.',
        409,
        'GROUP_FOLDER_BINDING_REFUSED',
      ),
    );
  expect(await bindCreatedGroup(key, handle, selectionKey)).toContain('folder moved');
  expect(values.has(`swa:groups:original:create-bind:${key}`)).toBe(true);
  state.api.mockRejectedValueOnce(new state.ApiError('Uncertain delivery', 503));
  await expect(bindCreatedGroup(key, handle, selectionKey)).rejects.toThrow('Uncertain delivery');
  expect(values.has(`swa:groups:original:create-bind:${key}`)).toBe(true);
});
