import type { MirrorState } from './mirror.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface CodexTranscriptDisplayBudget {
  characters: number;
  values: number;
  depth: number;
}

/** Inspect bounded display work before JSON serialization, without changing native items. */
function toolFits(values: unknown[], budget: CodexTranscriptDisplayBudget): boolean {
  const pending = values.map((value) => ({ value, depth: 0 }));
  let characters = 0;
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++visited > budget.values || depth > budget.depth) return false;
    if (typeof value === 'string') characters += value.length;
    else if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value.length + visited + pending.length > budget.values) return false;
        for (const child of value) pending.push({ value: child, depth: depth + 1 });
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          characters += key.length;
          if (characters > budget.characters || visited + pending.length >= budget.values)
            return false;
          pending.push({ value: (value as ObjectValue)[key], depth: depth + 1 });
        }
      }
    }
    if (characters > budget.characters) return false;
  }
  return true;
}

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
export function codexTranscript(
  thread: ObjectValue,
  surface = 'VS Code',
  toolBudget?: CodexTranscriptDisplayBudget,
): MirrorState['entries'] {
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
      else if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
        const details = [
          item.arguments ?? {},
          item.result ?? item.contentItems ?? item.error ?? {},
        ];
        text = `${str(item.server)} ${str(item.tool)}\n${
          toolBudget && !toolFits(details, toolBudget)
            ? `[Tool details are too large to display here. View the original in ${surface}.]`
            : `${JSON.stringify(details[0])}\n${JSON.stringify(details[1])}`
        }`;
      } else if (type === 'plan') text = str(item.text);
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
