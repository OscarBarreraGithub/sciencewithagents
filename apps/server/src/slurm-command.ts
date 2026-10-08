/**
 * Best-effort recognition of Slurm submissions in one shell command string. This is a
 * policy-review trigger, not a shell implementation or a security boundary: scripts that
 * submit internally, eval of computed text, aliases and unusual quoting can evade it.
 * Nothing here executes, expands or reads anything.
 */
export type SlurmKind = 'sbatch' | 'salloc' | 'srun';
type Word = { value: string; expansion: boolean };
type Token =
  | ({ type: 'word' } & Word)
  | { type: 'op'; value: string }
  | { type: 'heredoc'; body: string | null }
  | { type: 'herestring'; word: Word | null }
  | { type: 'redirect' };

export type DetectedSubmission = {
  kind: SlurmKind;
  args: Word[];
  /** Heredoc or here-string body supplied on standard input. */
  stdin: string | null;
  /** Standard input comes from another command, so the script is not visible. */
  piped: boolean;
  opaque: string | null;
  location: 'cluster-local' | 'ssh';
  sshAlias: string | null;
  /** Literal directory after `cd` earlier in the same command, when determinable. */
  directory: string | null;
};

const kinds = new Set<SlurmKind>(['sbatch', 'salloc', 'srun']);
const prefixes = new Set([
  '!',
  '{',
  '}',
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'time',
  'exec',
  'command',
  'builtin',
  'nohup',
  'setsid',
  'caffeinate',
]);
const launchers = new Set(['xargs', 'parallel', 'watch', 'find']);
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const sshValueOptions = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
const noSubmission = new Set(['--test-only', '--help', '-h', '--usage', '-V', '--version']);

function base(word: string) {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Small POSIX-like lexer: quotes, escapes, operators, comments, heredocs, substitutions. */
export function lexShell(input: string, nested: string[] = []): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: {
    delimiter: string;
    strip: boolean;
    token: Token & { type: 'heredoc' };
  }[] = [];
  let current = '';
  let expansion = false;
  let started = false;
  let i = 0;
  const push = () => {
    if (started) tokens.push({ type: 'word', value: current, expansion });
    current = '';
    expansion = false;
    started = false;
  };
  const readHeredocBodies = () => {
    for (const pending of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      while (i < input.length) {
        const end = input.indexOf('\n', i);
        const line = input.slice(i, end === -1 ? input.length : end);
        i = end === -1 ? input.length : end + 1;
        const compare = pending.strip ? line.replace(/^\t+/, '') : line;
        if (compare === pending.delimiter) break;
        lines.push(compare);
      }
      pending.token.body = lines.join('\n');
    }
  };
  /** Return the index after a balanced `$(`…`)`, honoring quotes. */
  const balanced = (start: number) => {
    let depth = 1;
    let j = start;
    while (j < input.length && depth) {
      const c = input[j]!;
      if (c === '\\') j += 2;
      else if (c === "'") j = Math.max(input.indexOf("'", j + 1), j) + 1;
      else if (c === '"') {
        j++;
        while (j < input.length && input[j] !== '"') j += input[j] === '\\' ? 2 : 1;
        j++;
      } else {
        if (c === '(') depth++;
        if (c === ')') depth--;
        j++;
      }
    }
    return j;
  };
  while (i < input.length) {
    const c = input[i]!;
    if (c === '\\') {
      if (input[i + 1] === '\n') i += 2;
      else {
        current += input[i + 1] ?? '';
        started = true;
        i += 2;
      }
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      current += input.slice(i + 1, end === -1 ? input.length : end);
      started = true;
      i = end === -1 ? input.length : end + 1;
    } else if (c === '"') {
      started = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && '"\\$`\n'.includes(input[i + 1] ?? '')) {
          if (input[i + 1] !== '\n') current += input[i + 1];
          i += 2;
        } else {
          if (input[i] === '$' || input[i] === '`') expansion = true;
          if (input[i] === '$' && input[i + 1] === '(') {
            const end = balanced(i + 2);
            nested.push(input.slice(i + 2, end - 1));
            current += input.slice(i, end);
            i = end;
            continue;
          }
          current += input[i];
          i++;
        }
      }
      i++;
    } else if (c === '$' && input[i + 1] === '(') {
      const end = balanced(i + 2);
      nested.push(input.slice(i + 2, end - 1));
      current += input.slice(i, end);
      expansion = true;
      started = true;
      i = end;
    } else if (c === '`') {
      const end = input.indexOf('`', i + 1);
      nested.push(input.slice(i + 1, end === -1 ? input.length : end));
      expansion = true;
      started = true;
      i = end === -1 ? input.length : end + 1;
    } else if (c === '#' && !started) {
      while (i < input.length && input[i] !== '\n') i++;
    } else if (c === '\n') {
      push();
      tokens.push({ type: 'op', value: '\n' });
      i++;
      readHeredocBodies();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      push();
      i++;
    } else if (c === '<' && input.startsWith('<<<', i)) {
      push();
      i += 3;
      const token: Token & { type: 'herestring' } = { type: 'herestring', word: null };
      tokens.push(token);
      // The next word becomes the here-string body.
    } else if (c === '<' && input[i + 1] === '<') {
      push();
      const strip = input[i + 2] === '-';
      i += strip ? 3 : 2;
      while (input[i] === ' ' || input[i] === '\t') i++;
      let delimiter = '';
      while (i < input.length && !/[\s;&|<>()]/.test(input[i]!)) {
        if (input[i] === "'" || input[i] === '"') {
          const quote = input[i]!;
          const end = input.indexOf(quote, i + 1);
          delimiter += input.slice(i + 1, end === -1 ? input.length : end);
          i = end === -1 ? input.length : end + 1;
        } else if (input[i] === '\\') {
          delimiter += input[i + 1] ?? '';
          i += 2;
        } else delimiter += input[i++];
      }
      const token: Token & { type: 'heredoc' } = { type: 'heredoc', body: null };
      tokens.push(token);
      pendingHeredocs.push({ delimiter, strip, token });
    } else if (c === '<' || c === '>') {
      // A file-descriptor number directly before the operator belongs to the redirect.
      if (started && /^\d+$/.test(current) && !expansion) {
        current = '';
        started = false;
      } else push();
      i++;
      while (input[i] === '>' || input[i] === '&' || input[i] === '|') i++;
      tokens.push({ type: 'redirect' });
    } else if (c === '&' && input[i + 1] === '>') {
      push();
      i += input[i + 2] === '>' ? 3 : 2;
      tokens.push({ type: 'redirect' });
    } else if (';&|()'.includes(c)) {
      push();
      const two = input.slice(i, i + 2);
      const op = ['&&', '||', ';;', '|&'].includes(two) ? two : c;
      tokens.push({ type: 'op', value: op });
      i += op.length;
    } else {
      if (
        c === '$' ||
        c === '*' ||
        c === '?' ||
        (c === '{' && /\{[^}]*(?:,|\.\.)/.test(input.slice(i)))
      )
        expansion = true;
      current += c;
      started = true;
      i++;
    }
  }
  push();
  readHeredocBodies();
  return tokens;
}

type Command = {
  words: Word[];
  stdin: string | null;
  piped: boolean;
  loop: boolean;
};

function commands(tokens: Token[]): Command[] {
  const result: Command[] = [];
  let words: Word[] = [];
  let stdin: string | null = null;
  let piped = false;
  let nextPiped = false;
  let loopDepth = 0;
  let skipRedirectTarget = false;
  let herestring = false;
  const flush = () => {
    if (words.length || stdin !== null) result.push({ words, stdin, piped, loop: loopDepth > 0 });
    words = [];
    stdin = null;
    piped = nextPiped;
    nextPiped = false;
  };
  for (const token of tokens) {
    if (token.type === 'op') {
      nextPiped = token.value === '|' || token.value === '|&';
      flush();
      continue;
    }
    if (token.type === 'redirect') {
      skipRedirectTarget = true;
      continue;
    }
    if (token.type === 'heredoc') {
      stdin = token.body ?? '';
      continue;
    }
    if (token.type === 'herestring') {
      herestring = true;
      continue;
    }
    if (skipRedirectTarget) {
      skipRedirectTarget = false;
      continue;
    }
    if (herestring) {
      herestring = false;
      stdin = token.value;
      continue;
    }
    if (!words.length && (token.value === 'do' || token.value === 'done')) {
      loopDepth = Math.max(0, loopDepth + (token.value === 'do' ? 1 : -1));
      if (token.value === 'done') continue;
    }
    words.push({ value: token.value, expansion: token.expansion });
  }
  flush();
  return result;
}

function sshTarget(words: Word[], start: number) {
  let i = start;
  while (i < words.length) {
    const word = words[i]!.value;
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    const letters = word.slice(1);
    const valueAt = [...letters].findIndex((letter) => sshValueOptions.has(letter));
    i += valueAt !== -1 && valueAt === letters.length - 1 ? 2 : 1;
  }
  const alias = words[i];
  return alias ? { alias, rest: words.slice(i + 1) } : null;
}

type Context = {
  location: 'cluster-local' | 'ssh';
  sshAlias: string | null;
  insideAllocation: boolean;
  depth: number;
};

function scan(command: string, context: Context, found: DetectedSubmission[]) {
  if (context.depth > 4 || found.length > 8) return;
  const nested: string[] = [];
  const parsed = commands(lexShell(command, nested));
  let directory: string | null = null;
  for (const item of parsed) {
    const words = item.words;
    let i = 0;
    while (i < words.length) {
      const word = words[i]!.value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || prefixes.has(word)) i++;
      else if (word === 'env') {
        i++;
        while (i < words.length && (/^-/.test(words[i]!.value) || words[i]!.value.includes('=')))
          i++;
      } else if (word === 'timeout' || word === 'nice' || word === 'sudo' || word === 'stdbuf') {
        i++;
        while (i < words.length && words[i]!.value.startsWith('-')) i++;
        if (word === 'timeout' && i < words.length) i++;
      } else break;
    }
    const head = words[i];
    if (!head) continue;
    const name = base(head.value);
    if (name === 'cd') {
      const target = words[i + 1];
      directory = target && !target.expansion ? target.value : null;
      continue;
    }
    if (kinds.has(name as SlurmKind)) {
      const args = words.slice(i + 1);
      if (args.some((arg) => noSubmission.has(arg.value))) continue;
      const kind = name as SlurmKind;
      // srun inside this runtime's own allocation launches a step, not a new job.
      if (kind === 'srun' && context.insideAllocation && context.location === 'cluster-local')
        continue;
      found.push({
        kind,
        args,
        stdin: item.stdin,
        piped: item.piped,
        opaque: item.loop
          ? 'The submission repeats inside a shell loop.'
          : args.some((arg) => arg.expansion)
            ? 'An argument uses a variable, glob or command substitution.'
            : head.expansion
              ? 'The command name is computed.'
              : null,
        location: context.location,
        sshAlias: context.sshAlias,
        directory,
      });
      continue;
    }
    if (name === 'ssh') {
      const target = sshTarget(words, i + 1);
      if (target && target.rest.length)
        scan(
          target.rest.map((word) => word.value).join(' '),
          {
            ...context,
            location: 'ssh',
            sshAlias: target.alias.expansion ? null : target.alias.value,
            depth: context.depth + 1,
          },
          found,
        );
      continue;
    }
    if (shells.has(name)) {
      const flag = words.findIndex(
        (word, index) => index > i && /^-[a-z]*c[a-z]*$/.test(word.value),
      );
      if (flag !== -1 && words[flag + 1])
        scan(words[flag + 1]!.value, { ...context, depth: context.depth + 1 }, found);
      continue;
    }
    if (name === 'eval') {
      scan(
        words
          .slice(i + 1)
          .map((word) => word.value)
          .join(' '),
        { ...context, depth: context.depth + 1 },
        found,
      );
      continue;
    }
    if (launchers.has(name)) {
      const inner = words.findIndex(
        (word, index) => index > i && kinds.has(base(word.value) as SlurmKind),
      );
      if (inner !== -1)
        found.push({
          kind: base(words[inner]!.value) as SlurmKind,
          args: words.slice(inner + 1),
          stdin: null,
          piped: true,
          opaque: `The submission is launched through ${name}.`,
          location: context.location,
          sshAlias: context.sshAlias,
          directory,
        });
    }
  }
  for (const inner of nested) scan(inner, { ...context, depth: context.depth + 1 }, found);
}

export function detectSlurmSubmissions(
  command: string,
  options: { insideAllocation?: boolean } = {},
): { submissions: DetectedSubmission[]; truncated: boolean } {
  const found: DetectedSubmission[] = [];
  // Cheap prefilter: most commands never mention Slurm.
  if (!/\b(?:sbatch|salloc|srun)\b/.test(command)) return { submissions: [], truncated: false };
  scan(
    command,
    {
      location: 'cluster-local',
      sshAlias: null,
      insideAllocation: options.insideAllocation ?? false,
      depth: 0,
    },
    found,
  );
  return { submissions: found.slice(0, 4), truncated: found.length > 4 };
}

const valueShort: Record<SlurmKind, string> = {
  sbatch: 'AabcCDdeFGiJLMmNnopqStwx',
  srun: 'AbcCDdeGiJLMmNnopqStTWwx',
  salloc: 'AbcCDdFGJLMmNnpqStWwx',
};
const valueLong = new Set(
  (
    'account acctg-freq array batch bb bbf begin chdir cluster-constraint clusters comment ' +
    'constraint container core-spec cores-per-socket cpu-bind cpu-freq cpus-per-gpu cpus-per-task ' +
    'deadline delay-boot dependency distribution error exclude export export-file extra-node-info ' +
    'gid gpu-bind gpu-freq gpus gpus-per-node gpus-per-socket gpus-per-task gres gres-flags hint ' +
    'het-group input job-name jobid licenses mail-type mail-user mcs-label mem mem-bind mem-per-cpu ' +
    'mem-per-gpu mincpus mpi network nodefile nodelist nodes ntasks ntasks-per-core ntasks-per-gpu ' +
    'ntasks-per-node ntasks-per-socket open-mode output partition power prefer priority profile ' +
    'qos reservation signal sockets-per-node switches task-epilog task-prolog thread-spec ' +
    'threads-per-core time time-min tmp uid wait-all-nodes wckey wrap'
  ).split(' '),
);
const fieldOptions: Record<string, keyof RequestedFields> = {
  A: 'account',
  account: 'account',
  p: 'partition',
  partition: 'partition',
  q: 'qos',
  qos: 'qos',
  t: 'time',
  time: 'time',
  c: 'cpusPerTask',
  'cpus-per-task': 'cpusPerTask',
  n: 'ntasks',
  ntasks: 'ntasks',
  N: 'nodes',
  nodes: 'nodes',
  mem: 'memory',
  'mem-per-cpu': 'memoryPerCpu',
  G: 'gpus',
  gpus: 'gpus',
  gres: 'gpus',
  'gpus-per-node': 'gpus',
  a: 'array',
  array: 'array',
  J: 'jobName',
  'job-name': 'jobName',
};
export type RequestedFields = {
  account: string | null;
  partition: string | null;
  qos: string | null;
  time: string | null;
  cpusPerTask: string | null;
  ntasks: string | null;
  nodes: string | null;
  memory: string | null;
  memoryPerCpu: string | null;
  gpus: string | null;
  array: string | null;
  jobName: string | null;
};
export const emptyRequested = (): RequestedFields => ({
  account: null,
  partition: null,
  qos: null,
  time: null,
  cpusPerTask: null,
  ntasks: null,
  nodes: null,
  memory: null,
  memoryPerCpu: null,
  gpus: null,
  array: null,
  jobName: null,
});

/** Split options from the first positional word (the script or program) and its arguments. */
export function parseSlurmOptions(kind: SlurmKind, args: string[]) {
  const options: { name: string; value: string | null }[] = [];
  let i = 0;
  while (i < args.length) {
    const word = args[i]!;
    if (word === '--') {
      i++;
      break;
    }
    if (word.startsWith('--')) {
      const [name, ...rest] = word.slice(2).split('=');
      if (rest.length) options.push({ name: name!, value: rest.join('=') });
      else if (valueLong.has(name!)) {
        options.push({ name: name!, value: args[i + 1] ?? null });
        i++;
      } else options.push({ name: name!, value: null });
      i++;
    } else if (word.startsWith('-') && word.length > 1) {
      const letters = word.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const letter = letters[j]!;
        if (valueShort[kind].includes(letter)) {
          const attached = letters.slice(j + 1);
          options.push({ name: letter, value: attached || (args[i + 1] ?? null) });
          if (!attached) i++;
          break;
        }
        options.push({ name: letter, value: null });
      }
      i++;
    } else break;
  }
  return { options, positional: args.slice(i) };
}

export function requestedFrom(options: { name: string; value: string | null }[]) {
  const requested = emptyRequested();
  for (const option of options) {
    const field = fieldOptions[option.name];
    if (!field || option.value === null) continue;
    const value = option.value.slice(0, 200);
    requested[field] =
      option.name === 'gpus-per-node'
        ? `per-node:${value}`
        : option.name === 'gres' && !/gpu/i.test(value)
          ? requested[field]
          : value;
  }
  return requested;
}

/** #SBATCH directives before the first executable line, as Slurm reads them. */
export function scriptDirectives(content: string) {
  const options: { name: string; value: string | null }[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#!')) continue;
    if (!line.startsWith('#')) break;
    const match = /^#SBATCH\s+(.*)$/.exec(line);
    if (!match) continue;
    const words = lexShell(match[1]!.replace(/\s#.*$/, ''))
      .filter((token): token is Token & { type: 'word' } => token.type === 'word')
      .map((token) => token.value);
    options.push(...parseSlurmOptions('sbatch', words).options);
  }
  return options;
}

/** Slurm time strings → minutes; null when unparseable; Infinity for UNLIMITED. */
export function slurmMinutes(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim().toUpperCase();
  if (text === 'UNLIMITED' || text === 'INFINITE') return Infinity;
  const match = /^(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const [, days, a, b, c] = match;
  const d = Number(days ?? 0);
  if (days !== undefined) {
    // D-HH, D-HH:MM, D-HH:MM:SS
    return d * 1440 + Number(a) * 60 + Number(b ?? 0) + Number(c ?? 0) / 60;
  }
  if (c !== undefined) return Number(a) * 60 + Number(b) + Number(c) / 60;
  if (b !== undefined) return Number(a) + Number(b) / 60;
  return Number(a);
}
/** Slurm memory strings (default unit MB) → GB; null when unparseable or 0 (whole node). */
export function slurmGigabytes(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)B?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!amount) return null;
  const unit = (match[2] || 'M').toUpperCase();
  return amount * { K: 1 / 1048576, M: 1 / 1024, G: 1, T: 1024 }[unit as 'K' | 'M' | 'G' | 'T'];
}
/** GPU count from --gres/--gpus text; null when none was requested or it is unparseable. */
export function slurmGpus(value: string | null): number | null {
  if (!value) return null;
  const text = value.replace(/^per-node:/, '');
  let total = 0;
  for (const part of text.split(',')) {
    const pieces = part.trim().split(':');
    if (pieces[0] && /gpu/i.test(pieces[0])) {
      const last = pieces.length > 1 ? Number(pieces.at(-1)) : 1;
      total += Number.isFinite(last) ? last : 1;
    } else if (/^\d+$/.test(part.trim())) total += Number(part.trim());
    else if (pieces.length >= 2 && /^\d+$/.test(pieces.at(-1)!)) total += Number(pieces.at(-1));
  }
  return total || null;
}
export function slurmArrayTasks(value: string | null): number | null {
  if (!value) return null;
  let total = 0;
  for (const part of value.replace(/%\d+$/, '').split(',')) {
    const match = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    const step = Number(match[3] ?? 1) || 1;
    if (end < start) return null;
    total += Math.floor((end - start) / step) + 1;
  }
  return total || null;
}
