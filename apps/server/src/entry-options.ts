import type { createServer } from './server.js';

type EntryOptions = NonNullable<Parameters<typeof createServer>[2]>;
/** Services main creates once and both computer entries must receive. */
export type SharedEntryServices = Pick<
  EntryOptions,
  | 'groupHost'
  | 'clusterProjects'
  | 'phone'
  | 'notebookGateway'
  | 'terminals'
  | 'ownerTerminals'
  | 'mirrors'
  | 'backups'
  | 'hosts'
  | 'publishing'
  | 'notifications'
  | 'ready'
>;

/** The paired-phone entry shares the local runtime and services; only the local entry watches. */
export const phoneEntryOptions = (
  shared: SharedEntryServices,
  entry: { port: number; webDir?: string },
): EntryOptions => ({ ...shared, ...entry, remote: true, ownsRuntime: false });

export const localEntryOptions = (
  shared: SharedEntryServices,
  entry: Omit<EntryOptions, keyof SharedEntryServices | 'remote' | 'ownsRuntime'>,
): EntryOptions => ({ ...shared, ...entry, ownsRuntime: false });
