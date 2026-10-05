import { z } from 'zod';

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Use one short line for the app name.');
/** A web app the project already runs on its computer's loopback interface. */
export const appPortSchema = z.number().int().min(1024).max(65535);
/** Path on that port. Conservative characters only: no scheme, host, fragment or encoding. */
export const appPathSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9\-._~/?=&+,:@]*$/, 'Use a path such as / or /dashboard?view=today.')
  .refine((value) => !value.split(/[/?]/).includes('..'), 'Use a path without ..');
/** Optional HTTPS address the owner already set up for other devices. Not created here. */
export const appRemoteUrlSchema = z
  .string()
  .max(2000)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an https:// address without credentials.');

export const appStateSchema = z.enum(['running', 'stopped', 'not_responding']);
export const projectAppSchema = z
  .object({
    id,
    projectId: id,
    managerId: id.nullable(),
    name: z.string(),
    description: z.string(),
    port: appPortSchema,
    path: z.string(),
    remoteUrl: z.string().nullable(),
    revision: revision.min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Manager tool input (dock_app). Omit id to register; id with expectedRevision updates
 * or removes. Scope comes from the authenticated manager, never from this input.
 */
export const managerAppRequestSchema = z
  .object({
    action: z.enum(['save', 'remove']).default('save'),
    id: id.optional(),
    expectedRevision: revision.optional(),
    name: name.optional(),
    description: z.string().trim().max(280).optional(),
    port: appPortSchema.optional(),
    path: appPathSchema.optional(),
    remoteUrl: appRemoteUrlSchema.nullable().optional(),
  })
  .strict();

/** The local agent client's form: a saved receipt UUID and the calling manager. */
export const agentAppRequestSchema = managerAppRequestSchema
  .extend({ key: z.uuid(), managerId: id })
  .strict();

export const projectAppViewSchema = projectAppSchema.extend({
  projectName: z.string(),
  managerName: z.string().nullable(),
  /** Composed by the host from the validated port and path. */
  localUrl: z.string(),
  state: appStateSchema,
});
export const projectAppsStatusSchema = z
  .object({
    apps: z.array(projectAppViewSchema),
    /** True only when this browser runs on the computer that hosts the apps. */
    openHere: z.boolean(),
    checkedAt: z.string().datetime(),
  })
  .strict();
export const appRemoveRequestSchema = z
  .object({ key: id, expectedRevision: revision.min(1) })
  .strict();

export type ProjectApp = z.infer<typeof projectAppSchema>;
export type ProjectAppView = z.infer<typeof projectAppViewSchema>;
export type ProjectAppsStatus = z.infer<typeof projectAppsStatusSchema>;
export type AppState = z.infer<typeof appStateSchema>;
