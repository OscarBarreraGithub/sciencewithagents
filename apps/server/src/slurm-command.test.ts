import { describe, expect, it } from 'vitest';
import {
  detectSlurmSubmissions,
  parseSlurmOptions,
  requestedFrom,
  scriptDirectives,
  slurmArrayTasks,
  slurmGigabytes,
  slurmGpus,
  slurmMinutes,
} from './slurm-command.js';

const kinds = (command: string, insideAllocation = false) =>
  detectSlurmSubmissions(command, { insideAllocation }).submissions.map((item) => ({
    kind: item.kind,
    args: item.args.map((arg) => arg.value),
    location: item.location,
    alias: item.sshAlias,
    opaque: item.opaque !== null,
    stdin: item.stdin,
    piped: item.piped,
    directory: item.directory,
  }));

describe('Slurm submission detection', () => {
  it('ignores commands that only mention Slurm or validate without submitting', () => {
    for (const command of [
      'ls -la',
      'squeue --me',
      'grep sbatch notes.md',
      'echo "run sbatch later"',
      'man sbatch',
      'sbatch --test-only job.sh',
      'srun --help',
      'find . -name "*.sbatch"',
      'cat job.sbatch # sbatch job.sbatch',
    ])
      expect(kinds(command), command).toEqual([]);
  });

  it('finds direct, wrapped, substituted and chained submissions with their arguments', () => {
    expect(kinds('cd runs && sbatch -p test --time=01:00:00 job.sh 3')).toEqual([
      expect.objectContaining({
        kind: 'sbatch',
        args: ['-p', 'test', '--time=01:00:00', 'job.sh', '3'],
        location: 'cluster-local',
        directory: 'runs',
        opaque: false,
      }),
    ]);
    expect(kinds('JOB=$(sbatch --parsable job.sh) && echo $JOB')[0]).toMatchObject({
      kind: 'sbatch',
      args: ['--parsable', 'job.sh'],
    });
    expect(kinds('OMP_NUM_THREADS=2 nohup time /usr/bin/srun -n 2 ./a.out')[0]).toMatchObject({
      kind: 'srun',
      args: ['-n', '2', './a.out'],
    });
    expect(kinds("bash -lc 'salloc -p test -c 2 --mem=8G'")[0]).toMatchObject({ kind: 'salloc' });
  });

  it('reads remote commands through ssh and keeps their alias', () => {
    expect(
      kinds(`ssh -o BatchMode=yes -p 22 cannon 'cd ~/proj && sbatch --account=lab run.sh'`),
    ).toEqual([
      expect.objectContaining({
        kind: 'sbatch',
        args: ['--account=lab', 'run.sh'],
        location: 'ssh',
        alias: 'cannon',
        directory: '~/proj',
      }),
    ]);
  });

  it('captures heredoc and here-string scripts as inline content', () => {
    const [heredoc] = kinds(
      "sbatch -p test <<'EOF'\n#!/bin/bash\n#SBATCH -t 10\necho hi\nEOF\necho done",
    );
    expect(heredoc).toMatchObject({ kind: 'sbatch', args: ['-p', 'test'] });
    expect(heredoc!.stdin).toBe('#!/bin/bash\n#SBATCH -t 10\necho hi');
    expect(kinds('cat job.sh | sbatch')[0]).toMatchObject({ piped: true, stdin: null });
  });

  it('marks loops, variables, globs and launchers as opaque instead of guessing', () => {
    expect(kinds('for f in a.sh b.sh; do sbatch $f; done')[0]).toMatchObject({ opaque: true });
    expect(kinds('for f in a.sh b.sh; do sbatch fixed.sh; done')[0]).toMatchObject({
      opaque: true,
    });
    expect(kinds('sbatch jobs/*.sh')[0]).toMatchObject({ opaque: true });
    expect(kinds('ls *.sh | xargs -n1 sbatch')[0]).toMatchObject({ kind: 'sbatch', opaque: true });
  });

  it('treats srun inside this runtime allocation as a step, but not remote or other commands', () => {
    expect(kinds('srun -n 1 hostname', true)).toEqual([]);
    expect(kinds('sbatch job.sh', true)).toHaveLength(1);
    expect(kinds("ssh login 'srun -p test hostname'", true)).toHaveLength(1);
  });

  it('bounds the number of recognized submissions', () => {
    const many = Array.from({ length: 6 }, (_, i) => `sbatch job${i}.sh`).join('; ');
    const result = detectSlurmSubmissions(many);
    expect(result.submissions).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });
});

describe('Slurm option and resource parsing', () => {
  it('splits options from the script and applies directives before command-line overrides', () => {
    const parsed = parseSlurmOptions('sbatch', [
      '-p',
      'test',
      '-c4',
      '--mem',
      '8G',
      'job.sh',
      '-p',
      'x',
    ]);
    expect(parsed.positional).toEqual(['job.sh', '-p', 'x']);
    const directives = scriptDirectives(
      '#!/bin/bash\n#SBATCH --account=lab # comment\n#SBATCH -t 0-02:00\n#SBATCH -p shared\necho run\n#SBATCH -p ignored',
    );
    const requested = requestedFrom([...directives, ...parsed.options]);
    expect(requested).toMatchObject({
      account: 'lab',
      time: '0-02:00',
      partition: 'test',
      cpusPerTask: '4',
      memory: '8G',
    });
  });

  it('converts Slurm time, memory, GPU and array formats', () => {
    expect(slurmMinutes('90')).toBe(90);
    expect(slurmMinutes('01:30:00')).toBe(90);
    expect(slurmMinutes('1-12')).toBe(2160);
    expect(slurmMinutes('2-00:30:00')).toBe(2910);
    expect(slurmMinutes('UNLIMITED')).toBe(Infinity);
    expect(slurmMinutes('soon')).toBeNull();
    expect(slurmGigabytes('8G')).toBe(8);
    expect(slurmGigabytes('4096')).toBe(4);
    expect(slurmGigabytes('0')).toBeNull();
    expect(slurmGpus('gpu:a100:2')).toBe(2);
    expect(slurmGpus('gpu')).toBe(1);
    expect(slurmGpus('4')).toBe(4);
    expect(slurmArrayTasks('0-99%10')).toBe(100);
    expect(slurmArrayTasks('1,3,5-9:2')).toBe(5);
    expect(slurmArrayTasks('x')).toBeNull();
  });
});
