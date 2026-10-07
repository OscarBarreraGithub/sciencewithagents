import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ClaudeIdentity } from './claude-session.js';

/** Trusted adapter dependency, never a browser contract. Covers auth and the
 * supervisor itself, so tools/hooks/helpers inherit the same OS boundary.
 * A host admission receipt alone does not establish confinement compatibility.
 */
export interface NativeProviderBoundary {
  /** Native supervisor is owned by the outer process namespace. */
  readonly codexDirect?: boolean;
  readonly codexSocketManaged?: boolean;
  readonly claudeDirect?: boolean;
  readonly codexArgs?: readonly string[];
  check(provider: 'codex' | 'claude'): Promise<void>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  spawn(binary: string, args: string[], options: SpawnOptions): ChildProcess;
  verifyClaudeIdentity(binary: string): Promise<ClaudeIdentity>;
}
