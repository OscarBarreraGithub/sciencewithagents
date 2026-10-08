import { inspectSchema, sourceDispositionLengthMessage, type Entry } from '@dock/shared';

const inspection = inspectSchema.safeParse({ models: true, capacity: true });
const inspectionMessage = inspection.success ? '' : inspection.error.issues[0]!.message;
const inspectionMessages = new Set([
  inspectionMessage,
  // Retained history predates the coordination inspection target.
  inspectionMessage.replace(', coordination or cluster.', ' or cluster.'),
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only verified internal tool-input validation, never generic request/permission errors. */
export function internalToolValidation(entry: Entry): boolean {
  if (
    entry.kind !== 'system' ||
    entry.title !== 'Request failed' ||
    entry.status !== 'complete' ||
    !entry.runId ||
    entry.image ||
    entry.urlRequest ||
    entry.text.length > 4096
  )
    return false;
  if (entry.text === sourceDispositionLengthMessage) return true;
  try {
    const issues: unknown = JSON.parse(entry.text);
    return (
      Array.isArray(issues) &&
      issues.length > 0 &&
      issues.length <= 8 &&
      issues.every((issue) => {
        if (
          !record(issue) ||
          !Array.isArray(issue.path) ||
          typeof issue.message !== 'string' ||
          !Object.keys(issue).every((key) =>
            ['code', 'path', 'message', 'origin', 'maximum', 'minimum', 'inclusive'].includes(key),
          )
        )
          return false;
        const path = JSON.stringify(issue.path);
        return (
          (path === '["sourceDisposition"]' &&
            issue.code === 'too_big' &&
            issue.origin === 'string' &&
            issue.maximum === 2000 &&
            issue.inclusive === true &&
            [
              'Too big: expected string to have <=2000 characters',
              sourceDispositionLengthMessage,
            ].includes(issue.message)) ||
          (path === '["scheduling","tokenBudget"]' &&
            issue.code === 'too_small' &&
            issue.origin === 'number' &&
            issue.minimum === 100 &&
            issue.inclusive === true &&
            issue.message === 'Too small: expected number to be >=100') ||
          (path === '[]' &&
            issue.code === 'custom' &&
            !!inspectionMessage &&
            inspectionMessages.has(issue.message))
        );
      })
    );
  } catch {
    return false;
  }
}
