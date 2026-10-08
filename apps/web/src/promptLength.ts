import { promptTextLimit } from '@dock/shared';

/** Writing surfaces retain oversized text; only delivery and remote saving are bounded. */
export function promptLengthError(text: string, limit = promptTextLimit) {
  return text.length > limit
    ? `Message limit: ${limit.toLocaleString('en-US')} characters. Shorten or split this draft; use Notepad options to download the full text.`
    : '';
}
