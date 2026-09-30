import { randomUUID } from 'node:crypto';
import { linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { phoneSetupRequestSchema, phoneSetupStatusSchema } from '@dock/shared';
import { type PhoneAccess, type PhoneConfig, phoneConfigSchema } from './phone-access.js';
import { Conflict } from './store.js';
import { inspectTailscale, type TailscaleRead } from './tailscale.js';

const previewSchema = z.object({
  id: z.uuid(),
  origin: z.string().url(),
  node: z.string(),
  expiresAt: z.number(),
});
/** First setup uses locally verified metadata, never a browser-supplied address or command. */
export class PhoneSetup {
  constructor(
    private phone: PhoneAccess,
    private root: string,
    private localPort: number,
    private activate: () => Promise<void>,
    private read?: TailscaleRead,
    private isOpen = () => true,
  ) {}
  async check() {
    if (this.phone.config || this.phone.setupIssue)
      return phoneSetupStatusSchema.parse({
        state: 'configured',
        origin: this.phone.config?.origin ?? null,
        previewId: null,
        message: 'This computer already has phone settings. Its connection will be kept.',
      });
    const result = await inspectTailscale(this.read);
    if (!this.isOpen())
      throw new Conflict('The app is closing. Reopen it before setting up phone access.');
    let previewId: string | null = null;
    if (result.state === 'ready') {
      previewId = randomUUID();
      this.phone.store.setSetting('phone:setup-preview', {
        id: previewId,
        origin: result.origin,
        node: result.node,
        expiresAt: Date.now() + 5 * 60_000,
      });
    }
    return phoneSetupStatusSchema.parse({
      state: result.state,
      origin: result.origin,
      message: result.message,
      previewId,
    });
  }
  async configure(raw: unknown) {
    const request = phoneSetupRequestSchema.parse(raw);
    return this.phone.store.externalOperation(`phone:setup:${request.key}`, request, async () => {
      if (this.phone.config || this.phone.setupIssue)
        throw new Conflict('Existing phone settings were not replaced. Return to Phone access.');
      const preview = previewSchema.safeParse(this.phone.store.getSetting('phone:setup-preview'));
      if (
        !preview.success ||
        preview.data.id !== request.previewId ||
        preview.data.expiresAt < Date.now()
      )
        throw new Conflict('Check this computer again before choosing its private address.');
      const current = await inspectTailscale(this.read);
      if (!this.isOpen()) throw new Conflict('The app is closing. No phone settings were written.');
      if (
        current.state !== 'ready' ||
        current.origin !== preview.data.origin ||
        current.node !== preview.data.node
      )
        throw new Conflict(
          'The private connection changed. Check this computer again; nothing was replaced.',
        );
      const config: PhoneConfig = phoneConfigSchema.parse({
        authentication: 'paired',
        transport: 'tailscale',
        origin: current.origin,
        tailscaleNode: current.node,
        port: this.localPort === 4331 ? 4332 : 4331,
      });
      const temporary = join(this.root, `phone-setup-${request.key}.json`);
      writeFileSync(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      try {
        linkSync(temporary, join(this.root, 'phone-access.json'));
      } finally {
        unlinkSync(temporary);
      }
      this.phone.configureInitial(config);
      this.phone.store.event('phone.configured', null, null, { transport: 'tailscale' });
      await this.activate();
      return this.phone.status(false);
    });
  }
}
