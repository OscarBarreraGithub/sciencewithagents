import type { MirrorState } from './mirror.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function contents(v: unknown, surface: string): string {
  return array(v)
    .map((x) => {
      const a = object(x);
      return (
        str(a.text) ||
        (a.type === 'image' || a.type === 'localImage' ? `[Image — view in ${surface}]` : '')
      );
    })
    .filter(Boolean)
    .join('\n');
}
export function codexTranscript(thread: ObjectValue, surface = 'VS Code'): MirrorState['entries'] {
  return array(thread.turns).flatMap((turn, ti) =>
    array(object(turn).items).map((value, ii) => {
      const item = object(value);
      const type = str(item.type);
      let text: string;
      let role: 'user' | 'assistant' | 'activity' = 'activity';
      if (type === 'userMessage') {
        role = 'user';
        text = contents(item.content, surface);
      } else if (type === 'agentMessage') {
        role = 'assistant';
        text = str(item.text);
      } else if (type === 'reasoning')
        text =
          contents(item.summary, surface) ||
          array(item.summary)
            .filter((x) => typeof x === 'string')
            .join('\n') ||
          '[Reasoning summary unavailable]';
      else if (type === 'commandExecution')
        text = [
          str(item.command),
          str(item.aggregatedOutput),
          item.exitCode === undefined ? '' : `Exit: ${item.exitCode}`,
        ]
          .filter(Boolean)
          .join('\n');
      else if (type === 'fileChange')
        text = array(item.changes)
          .map((x) => `${str(object(x).path)}\n${str(object(x).diff)}`)
          .join('\n');
      else if (type === 'mcpToolCall' || type === 'dynamicToolCall')
        text = `${str(item.server)} ${str(item.tool)}\n${JSON.stringify(item.arguments ?? {})}\n${JSON.stringify(item.result ?? item.contentItems ?? item.error ?? {})}`;
      else if (type === 'plan') text = str(item.text);
      else if (type === 'webSearch') text = str(item.query) || JSON.stringify(item.action ?? {});
      else if (type === 'contextCompaction')
        text =
          'Context compacted. Retained messages remain below/above; hidden context is not reconstructed.';
      else text = `[${type || 'Saved activity'} — view this item in ${surface}]`;
      return {
        id: `${str(object(turn).id) || ti}:${str(item.id) || ii}`,
        role,
        text: role === 'activity' ? `${type}\n${text}` : text,
      };
    }),
  );
}
