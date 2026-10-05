import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  chatFileIds,
  chatFileReference,
  chatImageReference,
  withoutChatAttachments,
  withChatAttachmentText,
} from '@dock/shared';
import { Store } from './store.js';
import { ChatImages, registerChatImageRoutes } from './chat-images.js';
import { proxyPath } from './hosts.js';
import { VscodeMirrors } from './vscode-mirror.js';

it('stores private immutable general files once and passes native-readable paths/content through the same bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-files-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const uploads = new ChatImages(store, root);
  try {
    const bytes = Buffer.from('\\section{Private fixture}\nUnicode α and user content.\n');
    const input = { key: randomUUID(), name: 'research notes.tex', data: bytes.toString('base64') };
    const file = uploads.uploadFile(input);
    expect(uploads.uploadFile(input)).toEqual(file);
    expect(() => uploads.uploadFile({ ...input, name: 'changed.tex' })).toThrow();
    expect(() =>
      uploads.uploadFile({ ...input, key: randomUUID(), name: '../secret.txt' }),
    ).toThrow();
    expect(() => uploads.uploadFile({ ...input, key: randomUUID(), data: 'malformed' })).toThrow();
    expect(file).toMatchObject({ name: input.name, mimeType: 'text/plain', size: bytes.length });
    const text = withChatAttachmentText(chatFileReference(file.id), 'Please read this. \n');
    expect(withoutChatAttachments(text)).toBe('Please read this. \n');
    expect(chatFileIds(text)).toEqual([file.id]);
    const prompt = uploads.prompt(text);
    const attachment = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{'))!);
    expect(attachment).toMatchObject({
      name: input.name,
      textExcerpt: bytes.toString(),
      excerptTruncated: false,
    });
    expect(readFileSync(attachment.path)).toEqual(bytes);
    expect(statSync(attachment.path).mode & 0o777).toBe(0o600);
    const windowId = randomUUID();
    const sent: string[] = [];
    const mirrors = new VscodeMirrors(
      store,
      {
        discover: async () => {},
        windows: () => [
          {
            windowId,
            threadId: 'existing',
            title: 'Native',
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
      (value) => uploads.prompt(value),
    );
    const send = { key: randomUUID(), threadId: 'existing', text };
    expect((await mirrors.send(windowId, send)).state).toBe('sent');
    await mirrors.send(windowId, send);
    expect(sent).toEqual([prompt]);
    mirrors.close();
    unlinkSync(attachment.path);
    symlinkSync(join(root, 'dock.sqlite'), attachment.path);
    expect(() => uploads.fileBytes(file.id)).toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('bounds excerpts/files, retains legacy image references and exposes safe metadata/download routes on selected hosts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-file-routes-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const uploads = new ChatImages(store, root);
  const app = Fastify();
  registerChatImageRoutes(app, uploads);
  try {
    const content = Buffer.from('x'.repeat(7000));
    const file = uploads.uploadFile({
      key: randomUUID(),
      name: 'data.html',
      data: content.toString('base64'),
    });
    const excerpt = JSON.parse(
      uploads
        .prompt(chatFileReference(file.id))
        .split('\n')
        .find((line) => line.startsWith('{'))!,
    );
    expect(excerpt.textExcerpt).toHaveLength(4096);
    expect(excerpt.excerptTruncated).toBe(true);
    const legacy = uploads.upload({
      key: randomUUID(),
      png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    });
    const mixed = withChatAttachmentText(chatImageReference(legacy.id), chatFileReference(file.id));
    expect(uploads.prompt(mixed)).toContain('screenshot attachments:');
    expect(() =>
      uploads.prompt(mixed + [1, 2, 3].map(() => chatFileReference(randomUUID())).join('\n')),
    ).toThrow(/four files/);
    expect(() =>
      uploads.uploadFile({
        key: randomUUID(),
        name: 'oversized.txt',
        data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
      }),
    ).toThrow();
    const info = await app.inject('/api/chat-files/' + file.id + '/info');
    expect(info.json()).toEqual(file);
    const download = await app.inject('/api/chat-files/' + file.id);
    expect(download.rawPayload).toEqual(content);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    for (const suffix of ['', '/info', '/preview'])
      expect(proxyPath('GET', '/chat-files/' + file.id + suffix)).toBe(
        '/api/chat-files/' + file.id + suffix,
      );
    expect(proxyPath('POST', '/chat-files')).toBe('/api/chat-files');
    expect(proxyPath('GET', '/chat-files/../../secret')).toBeNull();
  } finally {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
