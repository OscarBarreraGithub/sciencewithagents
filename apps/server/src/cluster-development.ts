import type { SlurmDevelopmentReviewResult } from '@dock/shared';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { queryOptions, sshRunner, type ClusterRunner } from './cluster.js';
import type { Store } from './store.js';

const uuid = z.uuid();
const jobId = z.string().regex(/^\d{1,20}$/);
const safeName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const developmentInputSchema = z
  .object({
    projectId: uuid,
    alias: safeName,
    username: safeName,
    account: safeName,
    path: z.string().startsWith('/').max(1000),
    resources: z
      .object({
        cpus: z.number().int().min(1).max(128),
        memoryMb: z.number().int().min(512).max(1048576),
        timeMinutes: z.number().int().min(1).max(720),
        idleMinutes: z.number().int().min(1).max(120),
        partition: safeName.nullable(),
        qos: safeName.nullable(),
      })
      .strict(),
  })
  .strict();
export type DevelopmentInput = z.infer<typeof developmentInputSchema>;
const leaseSchema = z
  .object({
    projectId: uuid,
    token: uuid,
    username: safeName,
    alias: safeName,
    configuration: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['allocating', 'uncertain', 'pending', 'ready', 'released', 'rejected', 'error']),
    jobId: jobId.nullable(),
    node: safeName.nullable(),
    createdAt: z.string().datetime(),
    observedAt: z.string().datetime().nullable(),
    message: z.string().max(500),
  })
  .strict();
export type DevelopmentLease = z.infer<typeof leaseSchema>;
const observationSchema = z
  .object({
    jobs: z
      .array(
        z
          .object({
            id: jobId,
            uid: z.number().int().nonnegative(),
            user: safeName,
            comment: z.string(),
            name: z.string(),
            state: z.string(),
            node: z.string().nullable(),
            reason: z.string().max(400).nullable().optional(),
          })
          .strict(),
      )
      .max(100),
    uid: z.number().int().nonnegative(),
    absent: z.boolean(),
  })
  .strict();
export type IdleProof = {
  observedAt: number;
  idleSince: number;
  activeTurns: number;
  queuedTurns: number;
  activeHelpers: number;
  activeWork: number;
  ownerTerminals: number;
  pendingAutomation: number;
  drainToken: string;
};
export type DrainRuntime = (
  input: DevelopmentInput,
  lease: DevelopmentLease,
) => Promise<IdleProof | null>;
export type AdmitDevelopment = (
  input: DevelopmentInput,
  lease: DevelopmentLease,
) => Promise<void | (() => void)>;
export class DevelopmentReviewHeld extends Error {
  constructor(
    readonly review: SlurmDevelopmentReviewResult,
    readonly plan?: DevelopmentLease,
  ) {
    super(review.message || 'The owned development allocation is waiting for submission review.');
  }
}
type NativeOperation = 'inspect' | 'submit' | 'release';

/** Fixed native control program. Inputs are server-derived JSON; never shell text from a browser. */
export const developmentControl = `import sys,json,base64,subprocess,os,re,fcntl
p=json.loads(base64.b64decode(sys.argv[1])); op=p['operation']; x=p['input']; lease=p['lease']
if __import__('pwd').getpwuid(os.getuid()).pw_name!=x['username']: raise RuntimeError('Saved cluster sign-in identity changed before native control')
def run(args,stdin=None):
 r=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=40)
 if r.returncode: raise RuntimeError((r.stderr or r.stdout or 'Native Slurm command failed')[:400])
 return r.stdout.strip()
comment='swa-development:'+lease['projectId']+':'+lease['token']
name='swa-dev-'+lease['projectId'][:8]
def readjob(jid):
 r=subprocess.run(['scontrol','show','job','-o',jid],text=True,capture_output=True,timeout=20)
 if r.returncode:
  if 'Invalid job id' in r.stderr or 'Invalid job id' in r.stdout: return None
  raise RuntimeError((r.stderr or r.stdout)[:400])
 fields=dict(re.findall(r'(\\w+)=([^ ]*)',r.stdout))
 user=re.fullmatch(r'([^()]+)\\((\\d+)\\)',fields.get('UserId',''))
 if not user: raise RuntimeError('Slurm did not report a verifiable job owner')
 if fields.get('Account')!=x['account']: raise RuntimeError('Saved development account changed')
 node=fields.get('NodeList',''); node=None if node in ('','(null)','None') else node
 return {'id':fields['JobId'],'uid':int(user[2]),'user':user[1],'comment':fields.get('Comment',''),'name':fields.get('JobName',''),'state':fields.get('JobState',''),'node':node,'reason':fields.get('Reason') if fields.get('Reason') not in (None,'None','(null)') else None}
def owned(job):
 return job and job['uid']==os.getuid() and job['user']==x['username'] and job['comment']==comment and job['name']==name
if op=='inspect':
 ids=[lease['jobId']] if lease['jobId'] else run(['squeue','--noheader','--user',x['username'],'--name',name,'--format=%A']).splitlines()
 if len(ids)>100: raise RuntimeError('Too many development job candidates')
 jobs=[j for j in (readjob(i.strip()) for i in ids if re.fullmatch(r'\\d{1,20}',i.strip())) if j]
 if not lease['jobId']: jobs=[j for j in jobs if owned(j)]
 print(json.dumps({'jobs':jobs,'uid':os.getuid(),'absent':bool(lease['jobId']) and not jobs}))
elif op=='submit':
 r=x['resources']; args=['sbatch','--parsable','--job-name='+name,'--comment='+comment,'--account='+x['account'],'--nodes=1','--ntasks=1','--cpus-per-task='+str(r['cpus']),'--mem='+str(r['memoryMb'])+'M','--time='+str(r['timeMinutes']),'--chdir='+x['path'],'--output=/dev/null','--error=/dev/null']
 if r['partition']: args+=['--partition='+r['partition']]
 if r['qos']: args+=['--qos='+r['qos']]
 if not os.path.isdir(x['path']) or os.path.realpath(x['path'])!=x['path']: raise RuntimeError('Project directory changed; refresh the saved folder')
 result=subprocess.run(args,input='#!/bin/sh\\nexec sleep '+str(r['timeMinutes']*60)+'\\n',text=True,capture_output=True,timeout=40)
 if result.returncode: print(json.dumps({'rejected':True,'message':(result.stderr or result.stdout or 'Native Slurm rejected submission')[:400]}))
 else: print(json.dumps({'jobId':result.stdout.strip().split(';')[0]}))
elif op=='release':
 root=os.path.realpath(os.path.expanduser('~'))
 for component in ('.sciencewithagents','cluster-projects',lease['projectId']):
  root=os.path.join(root,component); parent=os.lstat(root)
  if not __import__('stat').S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or parent.st_mode&0o077: raise RuntimeError('Private runtime parent changed before release')
 guard=os.open(os.path.join(root,'runtime-open.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 st=os.fstat(guard)
 if not __import__('stat').S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private runtime cancellation lock changed')
 try: fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: raise RuntimeError('Explicit project reopen is reconciling this allocation; cancellation retained')
 job=readjob(lease['jobId'])
 if not owned(job): raise RuntimeError('Development allocation identity changed; refusing cancellation')
 path=os.path.join(os.path.expanduser('~'),'.sciencewithagents','cluster-projects',lease['projectId'],'runtime-drained.json')
 st=os.lstat(path)
 if not __import__('stat').S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Remote drain barrier is not private')
 with open(path) as f: barrier=json.load(f)
 if barrier.get('jobId')!=lease['jobId'] or barrier.get('leaseToken')!=lease['token'] or barrier.get('drainToken')!=p.get('drainToken'): raise RuntimeError('Remote drain barrier identity changed')
 run(['scancel',lease['jobId']]); print(json.dumps({'released':True}))
else: raise RuntimeError('Unsupported development operation')
`;

export class ClusterDevelopmentAllocations {
  private stopped = false;
  private readonly pending = new Map<string, Promise<DevelopmentLease>>();
  private readonly releasing = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly runner: ClusterRunner = sshRunner,
    private readonly now: () => number = Date.now,
    private readonly drain: DrainRuntime = async () => null,
    private readonly admit: AdmitDevelopment = async () => {
      throw new Error('Development allocation review needs setup.');
    },
  ) {}
  get(projectId: string): DevelopmentLease | null {
    const saved = this.store.getSetting(`cluster-development:${uuid.parse(projectId)}`);
    return saved ? leaseSchema.parse(saved) : null;
  }
  /** Read-only, pre-submission identity; an admitted/uncertain lease is never a review plan. */
  planned(value: DevelopmentInput): DevelopmentLease | null {
    const input = developmentInputSchema.parse(value);
    const configuration = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const saved = this.store.getSetting(
      `cluster-development-plan:${input.projectId}:${configuration}`,
    );
    return saved ? leaseSchema.parse(saved) : null;
  }
  stop() {
    this.stopped = true;
  }
  private save(lease: DevelopmentLease) {
    this.store.transaction(() => {
      this.store.setSetting(`cluster-development:${lease.projectId}`, leaseSchema.parse(lease));
      this.store.event('cluster.development.changed', null, null, lease);
    });
    return lease;
  }
  private async native(
    operation: NativeOperation,
    input: DevelopmentInput,
    lease: DevelopmentLease,
    drainToken?: string,
  ): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify({ operation, input, lease, drainToken })).toString(
      'base64',
    );
    const reply = await this.runner(
      [
        ...queryOptions,
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'PermitLocalCommand=no',
        '--',
        input.alias,
        'python3',
        '-c',
        "'" + developmentControl.replaceAll("'", "'\\''") + "'",
        payload,
      ],
      null,
      60000,
    );
    if (reply.code !== 0 || reply.timedOut)
      throw new Error(
        reply.timedOut
          ? 'Cluster development command timed out; its outcome must be reconciled.'
          : reply.stderr.slice(0, 400) || 'Cluster development command failed.',
      );
    return JSON.parse(reply.stdout) as unknown;
  }
  private async inspect(input: DevelopmentInput, lease: DevelopmentLease) {
    const result = observationSchema.parse(await this.native('inspect', input, lease));
    if (result.jobs.length > 1)
      throw new Error(
        'Multiple matching owned allocations; inspect native Slurm before continuing.',
      );
    const job = result.jobs[0];
    if (
      job &&
      (job.uid !== result.uid ||
        job.user !== lease.username ||
        job.comment !== `swa-development:${lease.projectId}:${lease.token}` ||
        job.name !== `swa-dev-${lease.projectId.slice(0, 8)}`)
    )
      throw new Error(
        'Development allocation identity changed; refusing adoption or cancellation.',
      );
    return { result, job };
  }
  /** Transport checks never submit or reacquire compute. Only an explicit project open calls ensure. */
  async verifyCurrent(input: DevelopmentInput, expected: DevelopmentLease) {
    const current = this.get(input.projectId);
    if (
      !current ||
      current.jobId !== expected.jobId ||
      current.token !== expected.token ||
      current.state !== 'ready'
    )
      return false;
    const { job } = await this.inspect(developmentInputSchema.parse(input), expected);
    return (
      !!job && job.id === expected.jobId && job.state === 'RUNNING' && job.node === expected.node
    );
  }
  /** Continue only an already submitted exact lease; this path can never submit or reacquire. */
  async observeExisting(value: DevelopmentInput, expected: DevelopmentLease) {
    const input = developmentInputSchema.parse(value),
      configuration = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const matches = () => {
      const current = this.get(input.projectId);
      return (
        current &&
        current.jobId === expected.jobId &&
        current.token === expected.token &&
        current.configuration === configuration &&
        expected.configuration === configuration &&
        current.alias === input.alias &&
        current.username === input.username &&
        ['pending', 'ready'].includes(current.state)
      );
    };
    if (!expected.jobId || !matches())
      throw new Error(
        'Saved allocation continuation identity changed. Explicitly reopen this project.',
      );
    const { result, job } = await this.inspect(input, expected);
    if (!matches())
      throw new Error(
        'Saved allocation changed during continuation. It will not be replaced automatically.',
      );
    if (job && job.id !== expected.jobId)
      throw new Error('Native allocation receipt changed. No replacement was requested.');
    const observedAt = new Date(this.now()).toISOString();
    if (!job)
      return this.save({
        ...expected,
        state: result.absent ? 'released' : 'uncertain',
        node: null,
        observedAt,
        message: result.absent
          ? 'The owned allocation ended before preparation. Explicitly reopen to request compute.'
          : 'The owned allocation could not be verified. Explicitly reopen to reconcile it.',
      });
    if (
      /^(COMPLETED|CANCELLED|FAILED|TIMEOUT|NODE_FAIL|OUT_OF_MEMORY|PREEMPTED|BOOT_FAIL|DEADLINE)/.test(
        job.state,
      )
    )
      return this.save({
        ...expected,
        state: 'released',
        node: null,
        observedAt,
        message: `The owned allocation ${job.state}. Explicitly reopen to request compute.`,
      });
    const node = job.node && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(job.node) ? job.node : null;
    return this.save({
      ...expected,
      state: job.state === 'RUNNING' && node ? 'ready' : 'pending',
      node,
      observedAt,
      message: job.state + (job.reason ? ` (${job.reason})` : ''),
    });
  }
  ensure(value: DevelopmentInput): Promise<DevelopmentLease> {
    const input = developmentInputSchema.parse(value);
    if (this.stopped)
      return Promise.reject(new Error('The controller stopped. Explicitly reopen after restart.'));
    if (!input.resources.partition)
      return Promise.reject(
        new Error('Choose and confirm a development partition before requesting compute.'),
      );
    if (this.releasing.has(input.projectId))
      return Promise.reject(
        new Error(
          'The idle development runtime is draining. Open it again after release completes.',
        ),
      );
    const existing = this.pending.get(input.projectId);
    if (existing) return existing;
    const promise = this.ensureOnce(input).finally(() => this.pending.delete(input.projectId));
    this.pending.set(input.projectId, promise);
    return promise;
  }
  private async ensureOnce(input: DevelopmentInput): Promise<DevelopmentLease> {
    let lease = this.get(input.projectId);
    const configuration = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (lease && (lease.alias !== input.alias || lease.username !== input.username))
      throw new Error('Saved development allocation belongs to another connection identity.');
    if (lease && !['released', 'rejected'].includes(lease.state)) {
      const { result, job } = await this.inspect(input, lease);
      if (
        job &&
        !/^(COMPLETED|CANCELLED|FAILED|TIMEOUT|NODE_FAIL|OUT_OF_MEMORY|PREEMPTED|BOOT_FAIL|DEADLINE)/.test(
          job.state,
        )
      ) {
        if (lease.configuration !== configuration)
          throw new Error(
            'Development resources, account or folder changed. The existing allocation must retain its saved configuration until released.',
          );
        const node =
          job.node && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(job.node) ? job.node : null;
        return this.save({
          ...lease,
          jobId: job.id,
          state: job.state === 'RUNNING' && node ? 'ready' : 'pending',
          node,
          observedAt: new Date(this.now()).toISOString(),
          message: job.state + (job.reason ? ` (${job.reason})` : ''),
        });
      }
      if (!job && !result.absent)
        return this.save({
          ...lease,
          state: 'uncertain',
          message: 'Submission has no confirmed receipt. It will not be repeated automatically.',
        });
      // The explicit open positively observed this old allocation ended. Retain that
      // proof before creating a new review plan, so continuation never mistakes it
      // for an active or uncertain submission that must not be replaced.
      this.save({
        ...lease,
        state: 'released',
        observedAt: new Date(this.now()).toISOString(),
        message: job
          ? `The previous owned allocation ${job.state}.`
          : 'The previous owned allocation ended.',
      });
    }
    const planKey = `cluster-development-plan:${input.projectId}:${configuration}`;
    const planned = this.store.getSetting(planKey);
    lease = planned
      ? leaseSchema.parse(planned)
      : leaseSchema.parse({
          projectId: input.projectId,
          token: randomUUID(),
          username: input.username,
          alias: input.alias,
          configuration,
          state: 'allocating',
          jobId: null,
          node: null,
          createdAt: new Date(this.now()).toISOString(),
          observedAt: null,
          message: 'Requesting an owned development allocation.',
        });
    this.store.setSetting(planKey, lease);
    const priorLease = JSON.stringify(this.get(input.projectId));
    let validate: void | (() => void);
    try {
      validate = await this.admit(input, lease);
    } catch (error) {
      if (error instanceof DevelopmentReviewHeld)
        throw new DevelopmentReviewHeld(error.review, lease);
      throw error;
    }
    if (this.stopped)
      throw new Error(
        'The controller stopped before submission. Its exact review plan remains saved.',
      );
    if (JSON.stringify(this.planned(input)) !== JSON.stringify(lease))
      throw new Error(
        'The saved allocation review plan changed. Explicitly reopen; nothing was submitted.',
      );
    if (JSON.stringify(this.get(input.projectId)) !== priorLease)
      throw new Error(
        'The saved allocation changed during review. Explicitly reopen; nothing was submitted.',
      );
    validate?.();
    lease = this.save(lease);
    this.store.setSetting(planKey, null);
    try {
      const receipt = z
        .union([
          z.object({ jobId }).strict(),
          z.object({ rejected: z.literal(true), message: z.string().max(400) }).strict(),
        ])
        .parse(await this.native('submit', input, lease));
      if ('rejected' in receipt)
        return this.save({ ...lease, state: 'rejected', message: receipt.message });
      lease = this.save({
        ...lease,
        jobId: receipt.jobId,
        state: 'pending',
        message: 'Waiting for native Slurm allocation.',
      });
      const { job } = await this.inspect(input, lease);
      if (!job) return lease;
      const node = job.node && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(job.node) ? job.node : null;
      return this.save({
        ...lease,
        state: job.state === 'RUNNING' && node ? 'ready' : 'pending',
        node,
        observedAt: new Date(this.now()).toISOString(),
        message: job.state + (job.reason ? ` (${job.reason})` : ''),
      });
    } catch (error) {
      return this.save({
        ...lease,
        state: 'uncertain',
        message: String(error instanceof Error ? error.message : error).slice(0, 500),
      });
    }
  }
  async releaseIdle(value: DevelopmentInput): Promise<boolean> {
    const input = developmentInputSchema.parse(value),
      lease = this.get(input.projectId),
      initialNow = this.now();
    if (
      !lease?.jobId ||
      this.pending.has(input.projectId) ||
      this.releasing.has(input.projectId) ||
      lease.state !== 'ready'
    )
      return false;
    this.releasing.add(input.projectId);
    try {
      // The remote runtime must fence new work before returning this proof. No configured
      // drain capability means retain the allocation; local disconnect never proves idle.
      const proof = await this.drain(input, lease);
      const now = this.now();
      if (!proof || !uuid.safeParse(proof.drainToken).success) return false;
      if (now < initialNow) return false;
      if (
        !Number.isFinite(proof.observedAt) ||
        !Number.isFinite(proof.idleSince) ||
        proof.observedAt > now + 5000 ||
        proof.idleSince > proof.observedAt ||
        now - proof.observedAt > 30000 ||
        now - proof.idleSince < input.resources.idleMinutes * 60000
      )
        return false;
      if (
        [
          proof.activeTurns,
          proof.queuedTurns,
          proof.activeHelpers,
          proof.activeWork,
          proof.ownerTerminals,
          proof.pendingAutomation,
        ].some((n) => n !== 0)
      )
        return false;
      await this.inspect(input, lease);
      if (this.get(input.projectId)?.token !== lease.token) return false;
      await this.native('release', input, lease, proof.drainToken);
      this.save({
        ...lease,
        state: 'released',
        observedAt: new Date(now).toISOString(),
        message: 'Released the owned idle development allocation.',
      });
      return true;
    } finally {
      this.releasing.delete(input.projectId);
    }
  }
}

/** The exact fixed sbatch proposal, shared with the controller's submission review. */
export function developmentProposal(input: DevelopmentInput, lease: DevelopmentLease) {
  const r = input.resources,
    quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const args = [
    'sbatch',
    '--parsable',
    '--job-name=swa-dev-' + lease.projectId.slice(0, 8),
    '--comment=swa-development:' + lease.projectId + ':' + lease.token,
    '--account=' + input.account,
    '--nodes=1',
    '--ntasks=1',
    '--cpus-per-task=' + r.cpus,
    '--mem=' + r.memoryMb + 'M',
    '--time=' + r.timeMinutes,
    '--chdir=' + input.path,
    '--output=/dev/null',
    '--error=/dev/null',
  ];
  if (r.partition) args.push('--partition=' + r.partition);
  if (r.qos) args.push('--qos=' + r.qos);
  return {
    command: 'ssh ' + quote(input.alias) + ' ' + quote(args.map(quote).join(' ')),
    script: '#!/bin/sh\nexec sleep ' + r.timeMinutes * 60 + '\n',
    purpose: `Owned development allocation for cluster project ${lease.projectId}. The sleep batch script only holds this ${r.cpus}-CPU, ${r.memoryMb}-MiB allocation for at most ${r.timeMinutes} minutes; subsequent owned srun steps build the app, start its private loopback runtime, and execute the selected native project manager and tools on compute. Persistent app/native history stays in the cluster home; runtime diagnostics are in ~/.sciencewithagents/cluster-projects/${lease.projectId}/runtime-private.log. Batch holder stdout/stderr are discarded because the holder produces no work output. This is development work, not a production experiment. Only this exact app-owned allocation may be released after verified idle fencing; unavailable idle proof, active work/PTYs, and future automation without a proven wake path retain it until explicit cleanup or the native time limit.`,
  };
}
