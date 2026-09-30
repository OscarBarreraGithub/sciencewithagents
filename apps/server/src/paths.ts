import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const dataDir = resolve(process.env.DOCK_DATA_DIR ?? join(repoRoot, 'data'));
export const binary = process.env.DOCK_CODEX_BIN ?? 'codex';
export const port = Number(process.env.DOCK_PORT ?? 4330);
