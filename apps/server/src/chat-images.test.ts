import { it, expect } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  chatImageIds,
  chatImageReference,
  withoutChatImages,
  withChatImageText,
} from '@dock/shared';
import { Store } from './store.js';
import { ChatImages } from './chat-images.js';
import { proxyPath } from './hosts.js';
import { VscodeMirrors } from './vscode-mirror.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
it('retains private screenshots once, preserves typed whitespace and delivers readable files into the existing native chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-images-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const images = new ChatImages(store, root);
  try {
    const input = { key: randomUUID(), png };
    const image = images.upload(input);
    expect(images.upload(input)).toEqual(image);
    expect(readdirSync(join(root, 'chat-images'))).toHaveLength(1);
    expect(images.bytes(image.id)).toEqual(Buffer.from(png, 'base64'));
    expect(statSync(join(root, 'chat-images', image.id + '.png')).mode & 0o777).toBe(0o600);
    expect(() => images.upload({ ...input, png: png + 'bad' })).toThrow();
    expect(() => images.prompt(chatImageReference(randomUUID()))).toThrow(/not available/);
    const text = withChatImageText(chatImageReference(image.id), 'Look here \n');
    expect(withoutChatImages(text)).toBe('Look here \n');
    expect(withoutChatImages('typing ')).toBe('typing ');
    expect(chatImageIds(text)).toEqual([image.id]);
    expect(proxyPath('POST', '/chat-images')).toBe('/api/chat-images');
    expect(proxyPath('GET', '/chat-images/' + image.id)).toBe('/api/chat-images/' + image.id);
    expect(proxyPath('GET', '/chat-images/../../secret')).toBeNull();
    const windowId = randomUUID();
    const sent: string[] = [];
    const mirrors = new VscodeMirrors(
      store,
      {
        discover: async () => {},
        windows: () => [
          {
            windowId,
            threadId: 'same-thread',
            title: 'Existing chat',
            label: 'Native',
            status: 'idle',
            message: '',
            source: 'codex-daemon',
          },
        ],
        read: async () => {
          throw new Error('Unused');
        },
        control: async () => ({ state: 'not_sent', message: 'Unused' }),
        close: () => {},
        send: async (_id, input) => {
          sent.push(input.text);
          return { state: 'sent', message: 'Sent' };
        },
      },
      (value) => images.prompt(value),
    );
    const send = { key: randomUUID(), threadId: 'same-thread', text };
    expect((await mirrors.send(windowId, send)).state).toBe('sent');
    await mirrors.send(windowId, send);
    expect(sent).toHaveLength(1);
    const path = JSON.parse(sent[0]!.split('\n').find((line) => line.startsWith('"'))!);
    expect(readFileSync(path)).toEqual(Buffer.from(png, 'base64'));
    expect(sent[0]).toContain(chatImageReference(image.id));
    mirrors.close();
    unlinkSync(path);
    symlinkSync(join(root, 'dock.sqlite'), path);
    expect(() => images.bytes(image.id)).toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
