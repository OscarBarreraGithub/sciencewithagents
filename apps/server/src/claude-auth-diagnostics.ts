import { z } from 'zod';

// Native messages observed in Claude Code 2.1.288. Generic HTTP, usage and
// network failures do not establish an authentication failure or a sign-out.
const markers = [
  ['refresh-invalid-grant', 'tengu_oauth_refresh_token_marked_dead_invalid_grant'],
  ['stored-token-cleared', 'tengu_oauth_refresh_token_cleared_on_disk'],
  ['refresh-failed', 'OAuth token refresh failed'],
  ['refresh-failed', 'OAuth token expired and refresh failed'],
  ['stored-token-clear-failed', 'OAuth dead-token disk clear: backend write failed'],
  ['stored-token-clear-failed', 'OAuth dead-token disk clear failed:'],
] as const;
const classificationSchema = z.enum(markers.map(([name]) => name));
const diagnosticSchema = z
  .object({
    classification: classificationSchema,
    observedAt: z.iso.datetime(),
    nativeProcessId: z.number().int().positive(),
  })
  .strict();
export type ClaudeAuthClassification = z.infer<typeof classificationSchema>;
export type ClaudeAuthDiagnostic = z.infer<typeof diagnosticSchema>;
export type ClaudeSessionAuthDiagnostic = ClaudeAuthDiagnostic & {
  sessionId: string;
  supervisorProcessId: number | null;
};

/** Inspect stderr in memory; emit only four fixed classifications at most once
 * each per invocation. No original text, URL, account or credential is emitted. */
export function claudeAuthScanner(emit: (classification: ClaudeAuthClassification) => void) {
  const seen = new Set<ClaudeAuthClassification>();
  const prefixes = new Uint8Array(markers.length);
  return (chunk: Buffer) => {
    for (const byte of chunk) {
      for (let i = 0; i < markers.length; i++) {
        const [classification, marker] = markers[i];
        if (seen.has(classification)) continue;
        const next =
          byte === marker.charCodeAt(prefixes[i])
            ? prefixes[i] + 1
            : byte === marker.charCodeAt(0)
              ? 1
              : 0;
        prefixes[i] = next;
        if (next === marker.length) {
          seen.add(classification);
          emit(classification);
        }
      }
    }
    // Prefix lengths preserve split markers without retaining any native text.
  };
}

/** The supervisor's private stderr contains sanitized JSON, never native text.
 * Reject malformed/extra fields and bound frames and duplicate observations. */
export function claudeAuthDiagnosticReader(emit: (diagnostic: ClaudeAuthDiagnostic) => void) {
  const seen = new Set<ClaudeAuthClassification>();
  let buffered = '';
  let oversized = false;
  return (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte !== 10) {
        if (oversized) continue;
        if (buffered.length >= 512) {
          buffered = '';
          oversized = true;
        } else buffered += String.fromCharCode(byte);
        continue;
      }
      if (!oversized) {
        try {
          const parsed = diagnosticSchema.safeParse(JSON.parse(buffered));
          if (parsed.success && !seen.has(parsed.data.classification)) {
            seen.add(parsed.data.classification);
            emit(parsed.data);
          }
        } catch {
          // Diagnostics must never affect a conversation or forward raw output.
        }
      }
      buffered = '';
      oversized = false;
    }
  };
}
