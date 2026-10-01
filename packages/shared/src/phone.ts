import { z } from 'zod';

export const phoneDeviceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export const phoneStatusSchema = z
  .object({
    mode: z.enum(['local', 'remote']),
    configured: z.boolean(),
    transport: z.enum(['cloudflare', 'tailscale']).nullable().default(null),
    setupIssue: z.enum(['configuration', 'listener']).nullable().default(null),
    enabled: z.boolean(),
    connection: z.enum(['external', 'off', 'connecting', 'connected', 'error']).default('external'),
    paired: z.boolean(),
    authentication: z.enum(['access', 'paired']).default('access'),
    enrolled: z.boolean().default(false),
    setupComplete: z.boolean().default(false),
    enrollmentOpen: z.boolean().default(false),
    enrollmentInProgress: z.boolean().default(false),
    pending: z
      .object({ id: z.string().uuid(), name: z.string(), confirmation: z.string() })
      .nullable()
      .default(null),
    origin: z.string().nullable(),
    devices: z.array(phoneDeviceSchema),
  })
  .strict();
export const phoneCodeRequestSchema = z.object({ key: z.string().uuid() }).strict();
export const phoneCodeSchema = z
  .object({ code: z.string(), expiresAt: z.string(), origin: z.string() })
  .strict();
export const phonePairSchema = z
  .object({
    code: z.string().min(1).max(64),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict();
export const phoneEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const phoneSetupCompleteSchema = z.object({ setupComplete: z.literal(true) }).strict();
const encoded = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(24_000);
export const phoneCredentialSchema = z
  .object({
    id: encoded,
    rawId: encoded,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: encoded,
        attestationObject: encoded.optional(),
        authenticatorData: encoded.optional(),
        signature: encoded.optional(),
        userHandle: encoded.nullable().optional(),
        transports: z
          .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
          .max(10)
          .optional(),
        publicKey: encoded.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
      })
      .strict(),
    clientExtensionResults: z
      .object({ credProps: z.object({ rk: z.boolean().optional() }).optional() })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  })
  .strict();
export const phoneConfirmSchema = z
  .object({ id: z.string().uuid(), confirmation: z.string().regex(/^\d{6}$/) })
  .strict();
export type PhoneStatus = z.infer<typeof phoneStatusSchema>;

export const phoneSetupStatusSchema = z
  .object({
    state: z.enum(['unavailable', 'connect', 'https', 'conflict', 'ready', 'configured']),
    message: z.string().max(500),
    origin: z.string().url().nullable(),
    previewId: z.uuid().nullable(),
  })
  .strict();
export const phoneSetupRequestSchema = z
  .object({
    key: z.uuid(),
    previewId: z.uuid(),
    confirm: z.literal(true),
  })
  .strict();
export type PhoneSetupStatus = z.infer<typeof phoneSetupStatusSchema>;
