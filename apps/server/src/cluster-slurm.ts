/**
 * Read-only Slurm queries and parsers for the shared cluster collector.
 *
 * The scripts run in one SSH session per refresh. They only call native Slurm
 * status commands; they never submit, cancel, list directories or read files.
 */

/** Fields are separated by ASCII unit separator so paths and job names stay intact. */
export const fieldSeparator = '\x1f';
const sacctFields =
  'JobID,JobName,Partition,Account,State,ExitCode,Submit,Start,End,ElapsedRaw,TimelimitRaw,AllocCPUS,AllocTRES,TotalCPU,MaxRSS,WorkDir,StdOut,StdErr';

const prelude = String.raw`set +e -o pipefail
export LC_ALL=C
d=$(printf '\037')
if command -v timeout >/dev/null 2>&1; then T="timeout 25"; else T=""; fi
emit() { printf '@@swa-begin %s@@\n%s\n@@swa-end %s %s@@\n' "$1" "$3" "$1" "$2"; }
capture() { name="$1"; limit="$2"; shift 2; out=$($T "$@" 2>&1 | head -n "$limit"); emit "$name" "$?" "$out"; }
`;

/** Queue, pending priority and recent accounting; args: accounting days, tracked job IDs. */
export const fastScript = String.raw`${prelude}days="$1"; shift
case "$days" in [1-6]) ;; *) days=3 ;; esac
ids=""
for id in "$@"; do case "$id" in ''|*[!0-9]*) ;; *) ids="$ids${'$'}{ids:+,}$id" ;; esac; done
out=$($T squeue --me -h -o "%i$d%F$d%j$d%T$d%r$d%P$d%a$d%q$d%V$d%S$d%l$d%M$d%C$d%m$d%b$d%D$d%N$d%Q$d%Z" 2>&1); st=$?
emit squeue "$st" "$(printf '%s\n' "$out" | head -n 501)"
capture sprio 201 sprio -h -u "$USER" -o "%i$d%Y$d%A$d%F$d%J$d%P$d%Q"
capture sacct 3001 sacct -n -P --delimiter="$d" -u "$USER" -S "now-${'$'}{days}days" -E now -o ${sacctFields}
if [ -n "$ids" ]; then capture tracked 3001 sacct -n -P --delimiter="$d" -u "$USER" -j "$ids" -o ${sacctFields}; fi
`;

/**
 * Slow-changing version, fairshare, native association/QOS/partition limits and site caps.
 * Account-level rows follow this person's accounts up through their parents; other members'
 * rows are dropped on the cluster before anything is returned.
 */
export const slowScript = String.raw`${prelude}capture version 2 sinfo --version
capture groups 2 id -Gn
accounts=$($T sshare -U -P -n -o Account 2>/dev/null | sed 's/^ *//' | sort -u | head -n 50 | paste -sd, -)
if [ -n "$accounts" ]; then capture fairshare 400 sshare -P -n -A "$accounts" -o Account,User,RawShares,NormShares,RawUsage,EffectvUsage,FairShare,LevelFS; else emit fairshare 1 "No Slurm account associations were reported."; fi
assoc=$($T sacctmgr -nP show assoc user="$USER" format=Cluster,Account,Partition,GrpJobs,GrpSubmit,GrpTRES,GrpTRESRunMins,GrpWall,MaxJobs,MaxSubmit,MaxTRES,MaxTRESPerNode,MaxWall,QOS,DefaultQOS 2>&1 | head -n 51); st=$?
emit assoc "$st" "$assoc"
level=$(printf '%s\n' "$assoc" | awk -F'|' 'NF==15 && $2!="" {print $2}' | grep -E '^[A-Za-z0-9._-]+$' | sort -u | head -n 50 | paste -sd, -)
arows=""; ast=0; seen=","
for depth in 1 2 3 4 5 6; do
  [ -n "$level" ] || break
  seen="$seen$level,"
  out=$($T sacctmgr -nP show assoc account="$level" format=Cluster,Account,ParentName,Partition,GrpJobs,GrpSubmit,GrpTRES,GrpTRESRunMins,GrpWall,MaxJobs,MaxSubmit,MaxTRES,MaxTRESPerNode,MaxWall,QOS,DefaultQOS,User 2>&1); ast=$?
  if [ "$ast" -ne 0 ]; then arows=$(printf '%s\n' "$out" | head -n 1); break; fi
  rows=$(printf '%s\n' "$out" | awk -F'|' 'NF==17 && $17==""')
  arows="$arows$rows"$'\n'
  level=$(printf '%s\n' "$rows" | awk -F'|' '$3!="" {print $3}' | grep -E '^[A-Za-z0-9._-]+$' | sort -u | while read -r a; do case "$seen" in *",$a,"*) ;; *) printf '%s\n' "$a" ;; esac; done | head -n 50 | paste -sd, -)
done
emit accounts "$ast" "$(printf '%s\n' "$arows" | head -n 101)"
parts=$($T scontrol show partition -o 2>&1 | head -n 201); st=$?
emit partitions "$st" "$parts"
capture sinfo 201 sinfo -h -s -o "%R$d%a$d%l$d%F$d%C"
cfg=$($T scontrol show config 2>&1); st=$?
if [ "$st" -ne 0 ]; then cfg=$(printf '%s\n' "$cfg" | head -n 1); else cfg=$(printf '%s\n' "$cfg" | awk '/^(MaxArraySize|MaxJobCount|PriorityType|PriorityFlags|AccountingStorageEnforce) /' | head -n 10); fi
emit config "$st" "$cfg"
names=$( { printf '%s\n' "$assoc" | awk -F'|' 'NF>=15 { n=split($14,q,","); for(i=1;i<=n;i++) print q[i]; print $15 }'; printf '%s\n' "$arows" | awk -F'|' 'NF==17 { n=split($15,q,","); for(i=1;i<=n;i++) print q[i]; print $16 }'; printf '%s\n' "$parts" | grep -o 'QoS=[^ ]*' | cut -d= -f2; } | grep -E '^[A-Za-z0-9._-]+$' | grep -v '^N/A$' | sort -u | head -n 50 | paste -sd, -)
if [ -n "$names" ]; then capture qos 101 sacctmgr -nP show qos name="$names" format=Name,MaxJobsPU,MaxSubmitPU,MaxTRESPU,MaxJobsPA,MaxSubmitPA,MaxTRESPA,MaxTRES,MaxTRESPerNode,MaxWall,GrpJobs,GrpSubmit,GrpTRES,Flags; else emit qos 0 ""; fi
`;

export type Section = { status: number; lines: string[] };
/** Split marker-delimited script output. Unknown or unterminated sections are ignored. */
export function splitSections(raw: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: { name: string; lines: string[] } | null = null;
  for (const line of raw.split('\n')) {
    const begin = /^@@swa-begin ([a-z]+)@@$/.exec(line);
    if (begin) {
      current = { name: begin[1]!, lines: [] };
      continue;
    }
    const end = /^@@swa-end ([a-z]+) (\d+)@@$/.exec(line);
    if (end && current && end[1] === current.name) {
      sections.set(current.name, {
        status: Number(end[2]),
        lines: current.lines.filter((value) => value.trim() !== ''),
      });
      current = null;
      continue;
    }
    current?.lines.push(line.replace(/\r$/, ''));
  }
  return sections;
}

const blank = (value: string | undefined) =>
  !value || ['(null)', 'N/A', 'n/a', 'None', 'Unknown', 'UNLIMITED'].includes(value.trim());
export const textValue = (value: string | undefined, max = 200) =>
  blank(value) ? '' : value!.trim().slice(0, max);
export const intValue = (value: string | undefined) => {
  if (blank(value) || !/^\d+$/.test(value!.trim())) return null;
  const number = Number(value!.trim());
  return Number.isSafeInteger(number) ? number : null;
};
export const floatValue = (value: string | undefined) => {
  if (blank(value) || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value!.trim())) return null;
  const number = Number(value!.trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
};
/** Slurm local timestamps without zone are kept as given; ISO conversion would guess. */
export const timeValue = (value: string | undefined) =>
  blank(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value!.trim())
    ? null
    : value!.trim();

/** [D-]HH:MM:SS, MM:SS(.mmm) or HH:MM:SS.mmm to whole seconds. */
export function durationSeconds(value: string | undefined): number | null {
  if (blank(value)) return null;
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/.exec(value!.trim());
  if (!match) return null;
  const [, days, hours, minutes, secs] = match;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(secs)
  );
}
/** Slurm sizes such as 5280372K, 16G or 4000M (binary units) to bytes. */
export function sizeBytes(value: string | undefined): number | null {
  if (blank(value)) return null;
  const match = /^(\d+(?:\.\d+)?)([KMGTP]?)[nc]?$/i.exec(value!.trim());
  if (!match) return null;
  const power = ['', 'K', 'M', 'G', 'T', 'P'].indexOf(match[2]!.toUpperCase());
  return Number(match[1]) * 1024 ** power;
}
/** TRES lists such as billing=8,cpu=8,gres/gpu=1,mem=16G,node=1. */
export function tresValues(value: string | undefined) {
  const values = new Map<string, string>();
  for (const part of textValue(value, 2000).split(','))
    if (part.includes('='))
      values.set(part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1));
  return values;
}
const fields = (line: string) => line.split(fieldSeparator);
const baseId = (jobId: string) => /^\d+/.exec(jobId)?.[0] ?? jobId;

export function parseQueue(lines: string[]) {
  return lines
    .map(fields)
    .filter((row) => row.length === 19 && /^\d/.test(row[0]!))
    .map((row) => ({
      jobId: textValue(row[0], 80),
      baseJobId: /^\d+$/.test(row[1]!.trim()) ? row[1]!.trim() : baseId(row[0]!),
      name: textValue(row[2]),
      state: textValue(row[3], 40),
      reason: textValue(row[4]),
      partition: textValue(row[5]),
      account: textValue(row[6], 100),
      qos: textValue(row[7], 100),
      submittedAt: timeValue(row[8]),
      startAt: timeValue(row[9]),
      timeLimit: textValue(row[10], 40),
      timeUsed: textValue(row[11], 40),
      cpus: intValue(row[12]),
      memory: textValue(row[13], 40),
      gres: textValue(row[14]),
      nodes: intValue(row[15]),
      nodeList: textValue(row[16], 400),
      priority: floatValue(row[17]),
      workDir: textValue(row[18], 1000),
    }));
}
export function parsePriority(lines: string[]) {
  return lines
    .map(fields)
    .filter((row) => row.length === 7 && /^\d/.test(row[0]!.trim()))
    .map((row) => ({
      jobId: textValue(row[0], 80),
      priority: floatValue(row[1]),
      age: floatValue(row[2]),
      fairshare: floatValue(row[3]),
      jobSize: floatValue(row[4]),
      partition: floatValue(row[5]),
      qos: floatValue(row[6]),
    }));
}

/** Expand the common filename patterns sacct reports literally; others stay visible. */
export function expandOutputPath(
  pattern: string,
  job: { jobId: string; name: string; workDir: string },
) {
  if (!pattern) return '';
  const [array, task] = /^(\d+)_(\d+)$/.exec(job.jobId)?.slice(1) ?? [baseId(job.jobId), ''];
  const expanded = pattern.replace(/%(%|j|A|a|x)/g, (whole, code: string) =>
    code === '%'
      ? '%'
      : code === 'x'
        ? job.name
        : code === 'A'
          ? array!
          : code === 'a'
            ? task || whole
            : baseId(job.jobId),
  );
  return expanded.startsWith('/') || !job.workDir
    ? expanded
    : `${job.workDir.replace(/\/$/, '')}/${expanded}`;
}

type RecentJob = {
  jobId: string;
  baseJobId: string;
  name: string;
  partition: string;
  account: string;
  state: string;
  exitCode: string;
  submittedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  timeLimitSeconds: number | null;
  cpus: number | null;
  memoryBytes: number | null;
  gpus: number | null;
  cpuSeconds: number | null;
  maxRssBytes: number | null;
  cpuEfficiency: number | null;
  memoryEfficiency: number | null;
  workDir: string;
  stdout: string;
  stderr: string;
};
/** Allocation rows with their steps' largest MaxRSS. Steps are folded, not listed. */
export function parseAccounting(lines: string[]): RecentJob[] {
  const jobs = new Map<string, RecentJob>();
  const steps = new Map<string, { maxRss: number }>();
  for (const row of lines.map(fields)) {
    if (row.length !== 18 || !/^\d/.test(row[0]!)) continue;
    const id = row[0]!.trim();
    const dot = id.indexOf('.');
    if (dot > 0) {
      const rss = sizeBytes(row[14]);
      const parent = id.slice(0, dot);
      if (rss !== null)
        steps.set(parent, { maxRss: Math.max(rss, steps.get(parent)?.maxRss ?? 0) });
      continue;
    }
    const tres = tresValues(row[12]);
    const name = textValue(row[1]);
    const workDir = textValue(row[15], 1000);
    const job = { jobId: id, name, workDir };
    jobs.set(id, {
      jobId: id.slice(0, 80),
      baseJobId: baseId(id),
      name,
      partition: textValue(row[2]),
      account: textValue(row[3], 100),
      // "CANCELLED by <uid>" names an account identity; the state is enough.
      state: textValue(row[4], 80).replace(/ by \d+$/, ''),
      exitCode: textValue(row[5], 20),
      submittedAt: timeValue(row[6]),
      startedAt: timeValue(row[7]),
      endedAt: timeValue(row[8]),
      elapsedSeconds: intValue(row[9]),
      timeLimitSeconds: intValue(row[10]) === null ? null : intValue(row[10])! * 60,
      cpus: intValue(row[11]) ?? intValue(tres.get('cpu')),
      memoryBytes: sizeBytes(tres.get('mem')),
      gpus: intValue(tres.get('gres/gpu')),
      cpuSeconds: durationSeconds(row[13]),
      maxRssBytes: sizeBytes(row[14]),
      cpuEfficiency: null,
      memoryEfficiency: null,
      workDir,
      stdout: expandOutputPath(textValue(row[16], 1000), job).slice(0, 1000),
      stderr: expandOutputPath(textValue(row[17], 1000), job).slice(0, 1000),
    });
  }
  for (const job of jobs.values()) {
    const rss = Math.max(job.maxRssBytes ?? 0, steps.get(job.jobId)?.maxRss ?? 0);
    job.maxRssBytes = rss > 0 ? rss : null;
    if (job.cpuSeconds !== null && job.elapsedSeconds && job.cpus)
      job.cpuEfficiency =
        Math.round((job.cpuSeconds / (job.elapsedSeconds * job.cpus)) * 1000) / 1000;
    if (job.maxRssBytes !== null && job.memoryBytes)
      job.memoryEfficiency = Math.round((job.maxRssBytes / job.memoryBytes) * 1000) / 1000;
  }
  return [...jobs.values()];
}

/** Account rows plus this person's own row in each account; other users are not requested. */
export function parseFairshare(lines: string[]) {
  const accounts = new Map<
    string,
    {
      account: string;
      fairShare: number | null;
      levelFairShare: number | null;
      accountNormShares: number | null;
      accountEffectiveUsage: number | null;
      accountRawUsage: number | null;
      userRawUsage: number | null;
    }
  >();
  for (const row of lines.map((line) => line.split('|'))) {
    if (row.length !== 8) continue;
    const account = textValue(row[0], 100);
    if (!account || account === 'Account') continue;
    const value = accounts.get(account) ?? {
      account,
      fairShare: null,
      levelFairShare: null,
      accountNormShares: null,
      accountEffectiveUsage: null,
      accountRawUsage: null,
      userRawUsage: null,
    };
    if (textValue(row[1])) {
      const fairShare = floatValue(row[6]);
      value.fairShare = fairShare === null ? null : Math.min(1, fairShare);
      value.levelFairShare = floatValue(row[7]) ?? value.levelFairShare;
      value.userRawUsage = floatValue(row[4]);
    } else {
      value.accountNormShares = floatValue(row[3]);
      value.accountRawUsage = floatValue(row[4]);
      value.accountEffectiveUsage = floatValue(row[5]);
    }
    accounts.set(account, value);
  }
  return [...accounts.values()];
}

export function parseAssociations(lines: string[]) {
  return lines
    .map((line) => line.split('|'))
    .filter((row) => row.length === 15 && textValue(row[1]))
    .map((row) => ({
      cluster: textValue(row[0], 100),
      account: textValue(row[1], 100),
      partition: textValue(row[2], 100),
      grpJobs: intValue(row[3]),
      grpSubmit: intValue(row[4]),
      grpTres: textValue(row[5], 400),
      grpTresRunMins: textValue(row[6], 400),
      grpWall: textValue(row[7], 40),
      maxJobs: intValue(row[8]),
      maxSubmit: intValue(row[9]),
      maxTres: textValue(row[10], 400),
      maxTresPerNode: textValue(row[11], 400),
      maxWall: textValue(row[12], 40),
      qos: textValue(row[13], 4000)
        .split(',')
        .map((name) => name.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 100),
      defaultQos: textValue(row[14], 100),
    }));
}

/** Account-level rows (user field empty) of this person's accounts and their parents. */
export function parseAccountLimits(lines: string[]) {
  return lines
    .map((line) => line.split('|'))
    .filter((row) => row.length === 17 && textValue(row[1]) && !textValue(row[16]))
    .map((row) => ({
      cluster: textValue(row[0], 100),
      account: textValue(row[1], 100),
      parent: textValue(row[2], 100),
      partition: textValue(row[3], 100),
      grpJobs: intValue(row[4]),
      grpSubmit: intValue(row[5]),
      grpTres: textValue(row[6], 400),
      grpTresRunMins: textValue(row[7], 400),
      grpWall: textValue(row[8], 40),
      maxJobs: intValue(row[9]),
      maxSubmit: intValue(row[10]),
      maxTres: textValue(row[11], 400),
      maxTresPerNode: textValue(row[12], 400),
      maxWall: textValue(row[13], 40),
      qos: textValue(row[14], 4000)
        .split(',')
        .map((name) => name.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 100),
      defaultQos: textValue(row[15], 100),
    }));
}

export function parseQos(lines: string[]) {
  return lines
    .map((line) => line.split('|'))
    .filter((row) => row.length === 14 && textValue(row[0]))
    .map((row) => ({
      name: textValue(row[0], 100),
      maxJobsPerUser: intValue(row[1]),
      maxSubmitPerUser: intValue(row[2]),
      maxTresPerUser: textValue(row[3], 400),
      maxJobsPerAccount: intValue(row[4]),
      maxSubmitPerAccount: intValue(row[5]),
      maxTresPerAccount: textValue(row[6], 400),
      maxTres: textValue(row[7], 400),
      maxTresPerNode: textValue(row[8], 400),
      maxWall: textValue(row[9], 40),
      grpJobs: intValue(row[10]),
      grpSubmit: intValue(row[11]),
      grpTres: textValue(row[12], 400),
      flags: textValue(row[13], 400),
    }));
}

/** `Key = Value` lines from `scontrol show config`, already filtered on the cluster. */
export function parseSiteConfig(lines: string[]) {
  const value = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line.trim());
    if (match) value.set(match[1]!, match[2]!.trim());
  }
  return {
    maxArraySize: intValue(value.get('MaxArraySize')),
    maxJobCount: intValue(value.get('MaxJobCount')),
    enforce: textValue(value.get('AccountingStorageEnforce')),
    priorityType: textValue(value.get('PriorityType'), 80),
    priorityFlags: textValue(value.get('PriorityFlags')),
  };
}

/** scontrol one-line partition records; group/account lists are used only for access. */
export function parsePartitions(
  lines: string[],
  summary: string[],
  groups: string[],
  accounts: string[],
) {
  const cpus = new Map<string, { allocated: number; idle: number; other: number; total: number }>();
  for (const row of summary.map(fields)) {
    const counts = row[4]?.trim().split('/').map(Number);
    if (row.length === 5 && counts?.length === 4 && counts.every(Number.isSafeInteger))
      cpus.set(row[0]!.trim(), {
        allocated: counts[0]!,
        idle: counts[1]!,
        other: counts[2]!,
        total: counts[3]!,
      });
  }
  const allowed = (list: string, mine: string[]) =>
    !list || list === 'ALL' ? true : list.split(',').some((name) => mine.includes(name));
  return lines
    .filter((line) => line.startsWith('PartitionName='))
    .map((line) => {
      const value = new Map<string, string>();
      for (const match of line.matchAll(/(?:^|\s)([A-Za-z]+)=(\S*)/g))
        value.set(match[1]!, match[2]!);
      const name = textValue(value.get('PartitionName'), 100);
      const denied = value.get('DenyAccounts') ?? '';
      return {
        name,
        state: textValue(value.get('State'), 40),
        maxTime: textValue(value.get('MaxTime'), 40) || 'unlimited',
        defaultTime: textValue(value.get('DefaultTime'), 40),
        maxNodes: textValue(value.get('MaxNodes'), 40) || 'unlimited',
        maxCpusPerNode: textValue(value.get('MaxCPUsPerNode'), 40) || 'unlimited',
        defMemPerCpu: textValue(value.get('DefMemPerCPU'), 40),
        defMemPerNode: textValue(value.get('DefMemPerNode'), 40),
        maxMemPerNode: textValue(value.get('MaxMemPerNode'), 40) || 'unlimited',
        qos: textValue(value.get('QoS'), 100),
        preemptMode: textValue(value.get('PreemptMode'), 40),
        priorityTier: intValue(value.get('PriorityTier')),
        totalCpus: intValue(value.get('TotalCPUs')),
        totalNodes: intValue(value.get('TotalNodes')),
        gres: [...tresValues(value.get('TRES')).entries()]
          .filter(([key]) => key === 'gres/gpu' || key.startsWith('gres/gpu:'))
          .map(([key, count]) => `${key.replace(/^gres\//, '')}=${count}`)
          .join(',')
          .slice(0, 400),
        cpus: cpus.get(name) ?? null,
        accessible:
          groups.length && accounts.length
            ? allowed(value.get('AllowGroups') ?? 'ALL', groups) &&
              allowed(value.get('AllowAccounts') ?? 'ALL', accounts) &&
              !(denied && denied.split(',').some((account) => accounts.includes(account)))
            : null,
      };
    })
    .filter((partition) => partition.name);
}

/** Native sbatch confirmation. Returns job IDs only; no other output is retained. */
export function submittedJobIds(text: string, command = ''): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/Submitted batch job (\d{1,20})\b/g)) ids.add(match[1]!);
  // `sbatch --parsable` prints only "<id>" or "<id>;<cluster>" for a visible command.
  if (!ids.size && /\bsbatch\b/.test(command) && /--parsable\b/.test(command))
    for (const match of text.matchAll(/(?:^|\\n|\n)\s*(\d{1,20})(?:;[\w.-]+)?\s*(?=$|\\n|\n)/g))
      ids.add(match[1]!);
  return [...ids].slice(0, 50);
}

/** Classify SSH failure output without retaining account or host names. */
export function connectionFailure(stderr: string, timedOut: boolean) {
  if (timedOut)
    return { state: 'unreachable' as const, message: 'The cluster did not answer in time.' };
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .*host key is known/i.test(
      stderr,
    )
  )
    return {
      state: 'host-key' as const,
      message:
        'The cluster host key is unknown or changed. Check it yourself before connecting; the app never accepts host keys.',
    };
  if (
    /Permission denied|Authentication failed|Too many authentication failures|keyboard-interactive/i.test(
      stderr,
    )
  )
    return {
      state: 'sign-in-needed' as const,
      message: 'Cluster sign-in is needed. Batch jobs already submitted keep running.',
    };
  if (
    /Could not resolve|timed out|Network is unreachable|No route to host|Connection refused|Connection closed|Connection reset/i.test(
      stderr,
    )
  )
    return {
      state: 'unreachable' as const,
      message: 'The cluster could not be reached from this computer.',
    };
  if (/Bad configuration option|Could not resolve hostname|no address associated/i.test(stderr))
    return { state: 'error' as const, message: 'The SSH host alias could not be used.' };
  const line =
    stderr
      .split('\n')
      .map((value) => value.trim())
      .find(Boolean) ?? '';
  return {
    state: 'error' as const,
    message: (line.replace(/\S+@\S+/g, 'account@host') || 'The cluster query failed.').slice(
      0,
      300,
    ),
  };
}
