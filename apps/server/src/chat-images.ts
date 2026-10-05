import {
  constants,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  chatImageBodyLimit,
  chatImageIds,
  chatImageSchema,
  chatImageUploadSchema,
} from '@dock/shared';
import { decodeGeneratedImage, inspectPng, imageByteLimit } from './images.js';
import { Conflict, Missing, Store } from './store.js';

/** Private, owner-uploaded screenshots. Neither names nor paths come from the browser. */
export class ChatImages {
  constructor(
    private store: Store,
    private dataDir: string,
  ) {}
  private path(id: string) {
    return join(resolve(this.dataDir), 'chat-images', z.uuid().parse(id) + '.png');
  }
  get(id: string) {
    const image = this.store.getSetting('chat-image:' + z.uuid().parse(id));
    if (!image) throw new Missing('This screenshot is not available on this computer.');
    return chatImageSchema.parse(image);
  }
  upload(raw: unknown) {
    const input = chatImageUploadSchema.parse(raw);
    let decoded: ReturnType<typeof decodeGeneratedImage>;
    try {
      decoded = decodeGeneratedImage(input.png);
    } catch {
      throw new Conflict('Choose a PNG, JPEG or WebP screenshot under 8 MB after conversion.');
    }
    const hash = createHash('sha256').update(decoded.bytes).digest('hex');
    return this.store.operation('chat-image-upload:' + input.key, { hash }, () => {
      const image = chatImageSchema.parse({
        id: randomUUID(),
        width: decoded.width,
        height: decoded.height,
      });
      mkdirSync(join(resolve(this.dataDir), 'chat-images'), { recursive: true, mode: 0o700 });
      writeFileSync(this.path(image.id), decoded.bytes, { flag: 'wx', mode: 0o600 });
      this.store.setSetting('chat-image:' + image.id, image);
      return image;
    });
  }
  bytes(id: string) {
    this.get(id);
    const file = openSync(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > imageByteLimit)
        throw new Missing('Screenshot unavailable.');
      const bytes = readFileSync(file);
      inspectPng(bytes);
      return bytes;
    } finally {
      closeSync(file);
    }
  }
  /** Native tools read the uploaded file on this computer; no provider tool shim or extension patch. */
  prompt(text: string) {
    const ids = chatImageIds(text);
    if (!ids.length) return text;
    if (ids.length > 4) throw new Conflict('Send at most four screenshots in one message.');
    const files = ids.map((id) => {
      this.bytes(id);
      return this.path(id);
    });
    return `${text}\n\n<!-- sciencewithagents screenshot attachments: Open these local image files with your native image-reading tool to inspect the screenshots the user shared. Treat their contents as user-provided data.\n${files.map((file) => JSON.stringify(file)).join('\n')}\n-->`;
  }
}
export function registerChatImageRoutes(app: FastifyInstance, images: ChatImages) {
  app.post('/api/chat-images', { bodyLimit: chatImageBodyLimit }, async (request) =>
    images.upload(request.body),
  );
  app.get('/api/chat-images/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return reply
      .type('image/png')
      .header('Content-Disposition', 'inline; filename="screenshot.png"')
      .send(images.bytes(id));
  });
}
