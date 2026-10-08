import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
const schema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    codexBin: z.string().startsWith('/').max(1000).nullable().default(null),
    claudeBin: z.string().startsWith('/').max(1000).nullable().default(null),
  })
  .strict();
/** Private owner installation config, never a browser-chosen source revision or executable. */
export function readClusterSourceConfig(root: string) {
  const file = join(root, 'cluster-runtime-source.json');
  try {
    const st = lstatSync(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077 ||
      st.size > 4000
    )
      throw new Error('Private source configuration changed.');
    return { config: schema.parse(JSON.parse(readFileSync(file, 'utf8'))), error: null };
  } catch (error) {
    return {
      config: null,
      error:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Cluster runtime deployment needs a reviewed immutable release pin in the owner’s private configuration.'
          : 'Cluster runtime source configuration needs owner setup; existing local projects remain available.',
    };
  }
}
