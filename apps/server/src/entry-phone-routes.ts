import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id, phoneCodeRequestSchema, phoneEnabledSchema } from '@dock/shared';
import { Conflict } from './store.js';
import type { PhoneAccess, PhoneSession, PhoneIdentity } from './phone-access.js';
import type { PhoneSetup } from './phone-setup.js';
import type { PhoneTunnel } from './phone-tunnel.js';
/** Phone authorization and device receipts without agent or terminal hosting. */
export function registerEntryPhoneRoutes(
  app: FastifyInstance,
  options: {
    phone?: PhoneAccess;
    remote?: boolean;
    demo?: boolean;
    phoneSetup?: PhoneSetup;
    repairPhoneListener?: () => Promise<void>;
    tunnel?: Pick<PhoneTunnel, 'retry'>;
    withLock<T>(key: string, body: () => Promise<T>): Promise<T>;
  },
  phoneSessions: WeakMap<FastifyRequest, PhoneSession>,
  identities: WeakMap<FastifyRequest, PhoneIdentity>,
) {
  const phone = options.phone;
  const agentId = (params: unknown) => z.object({ id }).parse(params).id;
  if (phone) {
    app.post('/api/phone/setup/check', async (request, reply) => {
      if (options.remote || options.demo || !options.phoneSetup)
        return reply.code(403).send({ error: 'Set up the phone connection on its computer.' });
      z.object({}).strict().parse(request.body);
      return options.phoneSetup.check();
    });
    app.post('/api/phone/setup/confirm', async (request, reply) => {
      if (options.remote || options.demo || !options.phoneSetup)
        return reply.code(403).send({ error: 'Set up the phone connection on its computer.' });
      return options.withLock('phone:setup', () => options.phoneSetup!.configure(request.body));
    });
    app.post('/api/phone/reconnect', async (_request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Manage phone access on your computer.' });
      if (phone.setupIssue === 'listener') await options.repairPhoneListener?.();
      await options.tunnel?.retry();
      return phone.status(false);
    });
    app.get('/api/phone/status', async (request, reply) => {
      if (options.remote) {
        const renewed = phone.pairedDevices?.renewedCookies(request.headers.cookie);
        if (renewed?.length) reply.header('Set-Cookie', renewed);
      }
      return phone.status(!!options.remote, phoneSessions.has(request), request.headers.cookie);
    });
    {
      const paired = () => {
        if (!phone.pairedDevices) throw new Conflict('Finish passkey phone setup first.');
        return phone.pairedDevices;
      };
      app.post('/api/phone/setup/complete', async (request, reply) => {
        if (!options.remote)
          return reply.code(403).send({ error: 'Change these settings on your paired phone.' });
        const devices = paired();
        const cookies = request.headers.cookie;
        const renewed = devices.completeSetup(request.body, cookies, phoneSessions.get(request));
        return reply
          .header('Set-Cookie', renewed)
          .send(phone.status(true, !!devices.session(cookies), cookies));
      });
      for (const action of ['enroll/options', 'enroll/finish']) {
        app.post(`/api/phone/${action}`, async (request, reply) => {
          if (!options.remote)
            return reply
              .code(403)
              .send({ error: 'Use your phone address for device verification.' });
          const devices = paired();
          const cookies = request.headers.cookie;
          if (action === 'enroll/options') {
            const result = await devices.begin(request.body, cookies);
            return reply.header('Set-Cookie', result.cookie).send(result.options);
          }
          return devices.finish(request.body, cookies);
        });
      }
      app.post('/api/phone/confirm', async (request, reply) => {
        if (options.remote)
          return reply.code(403).send({ error: 'Confirm pairing on your computer.' });
        paired().confirm(request.body);
        return phone.status(false);
      });
      app.post('/api/phone/enrollment/close', async (request, reply) => {
        if (options.remote)
          return reply.code(403).send({ error: 'Manage pairing on your computer.' });
        z.object({}).strict().parse(request.body);
        paired().closeEnrollment();
        return phone.status(false);
      });
    }
    app.post('/api/phone/pair', async (request, reply) => {
      if (!options.remote)
        return reply.code(403).send({ error: 'Open your phone address to pair a device.' });
      const result = phone.pair(identities.get(request)!, request.body);
      return reply.header('Set-Cookie', result.cookie).send({ ok: true });
    });
    app.post('/api/phone/code', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Create pairing codes on your computer.' });
      return phone.issueCode(phoneCodeRequestSchema.parse(request.body).key);
    });
    app.post('/api/phone/enabled', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Manage phone access on your computer.' });
      phone.setEnabled(phoneEnabledSchema.parse(request.body).enabled);
      return phone.status(false);
    });
    app.post('/api/phone/devices/:id/revoke', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Disconnect devices on your computer.' });
      z.object({}).strict().parse(request.body);
      phone.revoke(agentId(request.params));
      return phone.status(false);
    });
  }
}
