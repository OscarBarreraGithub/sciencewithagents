import { z } from 'zod';
import type { ClusterProjectRecord, ClusterSettings } from '@dock/shared';
import { queryOptions, sshRunner, type ClusterRunner } from './cluster.js';
import {
  ClusterDevelopmentAllocations,
  type DevelopmentInput,
  type DevelopmentLease,
} from './cluster-development.js';
import { connectClusterLoopback } from './cluster-transport.js';
import { Hosts } from './hosts.js';
import type { Store } from './store.js';

const privatePath = z.string().startsWith('/').max(1000);
export const clusterRuntimeBundleSchema = z
  .object({
    bundlePath: privatePath,
    nodePath: privatePath,
    codexPath: privatePath.nullable(),
    claudePath: privatePath.nullable(),
  })
  .strict();
export type ClusterRuntimeBundle = z.infer<typeof clusterRuntimeBundleSchema>;
const handshakeSchema = z
  .object({
    version: z.literal(1),
    hostId: z.uuid(),
    projectId: z.uuid(),
    managerId: z.uuid(),
    port: z.number().int().min(1024).max(65535),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    jobId: z.string().regex(/^\d{1,20}$/),
    leaseToken: z.uuid(),
    attemptId: z.uuid(),
  })
  .strict();
export type ClusterRuntimeHandshake = z.infer<typeof handshakeSchema>;
export type PrepareClusterBundle = (
  record: ClusterProjectRecord,
  lease: DevelopmentLease,
) => Promise<ClusterRuntimeBundle>;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Readiness belongs to compute: login hosts can cache a missing shared-file lookup. */
export const computeRuntimeReadiness = `import sys,os,json,base64,subprocess,time,stat,socket
p=json.loads(base64.b64decode(sys.argv[1])); record=p['record']; lease=p['lease']
deadline=time.monotonic()+p['budgetSeconds']
if os.environ.get('SLURM_JOB_ID')!=lease['jobId'] or socket.gethostname().split('.')[0]!=lease['node'].split('.')[0]: raise RuntimeError('Wrong readiness allocation or node')
def native():
 remaining=deadline-time.monotonic()
 if remaining<=0: raise RuntimeError('Compute readiness deadline expired; intent retained')
 output=subprocess.check_output(['scontrol','show','job','-o',lease['jobId']],text=True,timeout=min(5,remaining))
 job=dict(v.split('=',1) for v in output.split() if '=' in v)
 if job.get('JobId')!=lease['jobId'] or job.get('Comment')!='swa-development:'+record['id']+':'+lease['token'] or job.get('UserId')!=record['folder']['username']+'('+str(os.getuid())+')' or job.get('Account')!=record['folder']['account'] or job.get('JobState')!='RUNNING': raise RuntimeError('Readiness allocation identity changed')
native()
root=os.path.join(os.path.realpath(os.path.expanduser('~')),'.sciencewithagents','cluster-projects',record['id'])
def parents_ready():
 parent=os.path.realpath(os.path.expanduser('~'))
 for component in ('.sciencewithagents','cluster-projects',record['id']):
  parent=os.path.join(parent,component)
  try: st=os.lstat(parent)
  except FileNotFoundError: return False
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private readiness parent changed')
 return True
lock=os.path.join(root,'runtime-start-'+lease['token'])
def private_json(path,maximum=10000):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_size>maximum: raise RuntimeError('Private readiness proof changed')
  with os.fdopen(fd) as stream: fd=None; return json.load(stream)
 finally:
  if fd is not None: os.close(fd)
def intent():
 st=os.lstat(lock)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private startup directory changed')
 return private_json(os.path.join(lock,'intent.json'))
attempts=p.get('pollAttempts',1)
if not isinstance(attempts,int) or not 1<=attempts<=120: raise RuntimeError('Invalid readiness wait bound')
for i in range(attempts):
 if time.monotonic()>=deadline: break
 if not parents_ready():
  if i+1<attempts: time.sleep(min(0.5,max(0,deadline-time.monotonic())))
  continue
 try: h=private_json(os.path.join(root,'runtime-handshake.json'),4000)
 except FileNotFoundError: h=None
 if h and h.get('jobId')==lease['jobId'] and h.get('leaseToken')==lease['token']:
  proof=intent()
  if proof!={'attemptId':h.get('attemptId'),'jobId':lease['jobId'],'leaseToken':lease['token']}: raise RuntimeError('Saved handshake belongs to another startup attempt')
  for expected,actual in [('remoteWorkspaceId','hostId'),('remoteProjectId','projectId'),('remoteManagerId','managerId')]:
   if record.get(expected) and record[expected]!=h.get(actual): raise RuntimeError('Saved runtime history identity changed')
  native(); print(json.dumps(h)); sys.exit(0)
 if os.path.exists(os.path.join(lock,'exit.json')):
  proof=intent(); exited=private_json(os.path.join(lock,'exit.json'))
  if proof.get('jobId')!=lease['jobId'] or proof.get('leaseToken')!=lease['token'] or any(exited.get(k)!=proof.get(k) for k in ['attemptId','jobId','leaseToken']): raise RuntimeError('Startup exit proof identity changed')
  raise RuntimeError('Local startup client exited; remote termination is unverified. Intent and history retained.')
 if i+1<attempts: time.sleep(min(0.5,max(0,deadline-time.monotonic())))
print('null')
`;

/** Login-node coordinator only starts/waits for a compute step; it never runs models or builds. */
export const runtimeCoordinator = `import sys,os,json,base64,subprocess,time,stat,uuid,fcntl
os.umask(0o077)
p=json.loads(base64.b64decode(sys.argv[1])); record=p['record']; lease=p['lease']; bundle=p['bundle']
# Leave room for SSH overhead inside the existing75second outer deadline.
deadline=time.monotonic()+65
root=os.path.realpath(os.path.expanduser('~'))
for component in ('.sciencewithagents','cluster-projects',record['id']):
 root=os.path.join(root,component)
 try: os.mkdir(root,0o700)
 except FileExistsError: pass
 st=os.lstat(root)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private runtime parent changed')
guard=os.open(os.path.join(root,'runtime-open.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
st=os.fstat(guard)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private runtime coordinator lock changed')
try: fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: raise RuntimeError('Another explicit project open is reconciling this runtime. Retry after it finishes.')
def existing(attempts=1):
 # One bounded metadata step waits on compute, without launching Node or a model.
 remaining=deadline-time.monotonic()
 if remaining<=0: raise RuntimeError('Runtime readiness deadline expired; original intent retained')
 payload=base64.b64encode(json.dumps({'record':record,'lease':lease,'pollAttempts':attempts,'budgetSeconds':remaining}).encode()).decode()
 command=['srun','--jobid='+lease['jobId'],'--overlap','--nodes=1','--ntasks=1','--nodelist='+lease['node'],'python3','-c',${JSON.stringify(computeRuntimeReadiness)},payload]
 return json.loads(subprocess.check_output(command,text=True,timeout=remaining))
def resume_drained(h):
 barrier=os.path.join(root,'runtime-drained.json')
 if not os.path.exists(barrier): return
 # This fixed program runs inside the verified allocation; login-node loopback is a different host.
 program="""import sys,json,base64,subprocess,os,hmac,hashlib,secrets,urllib.request
p=json.loads(base64.b64decode(sys.argv[1])); h=p['handshake']; record=p['record']
s=subprocess.check_output(['scontrol','show','job','-o',h['jobId']],text=True,timeout=15); f=dict(v.split('=',1) for v in s.split() if '=' in v)
if f.get('Comment')!='swa-development:'+record['id']+':'+h['leaseToken'] or f.get('UserId')!=record['folder']['username']+'('+str(os.getuid())+')' or f.get('JobState')!='RUNNING': raise RuntimeError('Owned allocation changed before explicit reopen')
origin='http://127.0.0.1:'+str(h['port']); path='/api/cluster/runtime/admission/reopen'; challenge=secrets.token_hex(32)
headers={'origin':origin,'x-dock-target-host':h['hostId'],'content-type':'application/json'}
def mac(parts): return hmac.new(h['credential'].encode(),json.dumps(['swa-local-v1']+parts,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
r=urllib.request.urlopen(urllib.request.Request(origin+'/api/local-access/proof?role=host&challenge='+challenge,headers=headers),timeout=5); proof=json.loads(r.read(4097))
if not hmac.compare_digest(proof['proof'],mac(['peer',origin,'host',challenge,proof['nonce']])): raise RuntimeError('Pinned app proof changed')
headers['authorization']='Dock host.'+proof['nonce']+'.'+mac(['request',origin,'host',challenge,proof['nonce'],'POST',path])
r=urllib.request.urlopen(urllib.request.Request(origin+path,data=json.dumps({'jobId':h['jobId'],'leaseToken':h['leaseToken']}).encode(),headers=headers,method='POST'),timeout=10); result=json.loads(r.read(4097)); identity=result['identity']
if result.get('drained')!=False or identity.get('jobId')!=h['jobId'] or identity.get('leaseToken')!=h['leaseToken'] or identity.get('remoteHostId')!=h['hostId'] or identity.get('clusterProjectId')!=record['id']: raise RuntimeError('Explicit reopen identity changed')
"""
 payload=base64.b64encode(json.dumps({'handshake':h,'record':record}).encode()).decode()
 subprocess.run(['srun','--jobid='+lease['jobId'],'--overlap','--nodes=1','--ntasks=1','python3','-c',program,payload],check=True,timeout=25,stdout=subprocess.DEVNULL)
h=existing()
lock=os.path.join(root,'runtime-start-'+lease['token'])
def private_json(path):
 st=os.lstat(path)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_size>10000: raise RuntimeError('Private startup proof changed')
 with open(path) as f: return json.load(f)
if os.path.lexists(lock):
 st=os.lstat(lock)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('Private startup directory changed')
 # A matching handshake and its exact intent were already verified on compute.
 if not h and os.path.exists(os.path.join(lock,'exit.json')):
  intent=private_json(os.path.join(lock,'intent.json')); exited=private_json(os.path.join(lock,'exit.json'))
  if exited['attemptId']!=intent['attemptId'] or exited['jobId']!=lease['jobId'] or exited['leaseToken']!=lease['token']: raise RuntimeError('Startup exit proof identity changed')
  # A login-node srun client exit is not remote step/server termination proof.
  # Keep every lock and receipt until independent compute-side recovery is integrated.
  raise RuntimeError('The local startup client exited, but remote termination is unverified. Startup intent and history were retained; no second runtime was launched.')
if h: resume_drained(h); print(json.dumps(h)); sys.exit(0)
try:
 os.mkdir(lock,0o700)
 attempt=str(uuid.uuid4())
 with open(os.path.join(lock,'intent.json'),'x') as f: json.dump({'attemptId':attempt,'jobId':lease['jobId'],'leaseToken':lease['token']},f)
 payload={'record':record,'jobId':lease['jobId'],'leaseToken':lease['token'],'attemptId':attempt,'clusterSettings':p['clusterSettings'],'codexPath':bundle['codexPath'],'claudePath':bundle['claudePath']}
 # srun resolves its executable on the login host; the pinned Node exists only on compute.
 # A fixed shell reaches compute first, then forwards the exact argument vector without evaluation.
 args=['srun','--jobid='+lease['jobId'],'--overlap','--nodes=1','--ntasks=1','/bin/sh','-c','exec "$@"','swa-compute-runtime',bundle['nodePath'],os.path.join(bundle['bundlePath'],'scripts','cluster','development-runtime.mjs'),base64.b64encode(json.dumps(payload).encode()).decode()]
 supervisor="import sys,os,json,base64,subprocess; p=json.loads(base64.b64decode(sys.argv[1])); child=subprocess.Popen(p['args'],stdin=subprocess.DEVNULL); code=child.wait(); path=p['exitPath']; f=open(path+'.tmp','x'); json.dump(dict(p['proof'],code=code),f); f.close(); os.chmod(path+'.tmp',0o600); os.rename(path+'.tmp',path)"
 supervised={'args':args,'exitPath':os.path.join(lock,'exit.json'),'proof':{'attemptId':attempt,'jobId':lease['jobId'],'leaseToken':lease['token']}}
 fd=os.open(os.path.join(root,'runtime-private.log'),os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: os.close(fd); raise RuntimeError('Private runtime log changed')
 subprocess.Popen(['python3','-c',supervisor,base64.b64encode(json.dumps(supervised).encode()).decode()],stdin=subprocess.DEVNULL,stdout=fd,stderr=fd,start_new_session=True); os.close(fd)
except FileExistsError: pass
h=existing(p.get('pollAttempts',120))
if h: print(json.dumps(h)); sys.exit(0)
raise RuntimeError('Remote bootstrap has no confirmed handshake. Inspect its private log; it will not be launched twice automatically.')
`;

export function developmentInput(record: ClusterProjectRecord): DevelopmentInput {
  return {
    projectId: record.id,
    alias: record.folder.alias,
    username: record.folder.username,
    account: record.folder.account,
    path: record.folder.path,
    resources: record.folder.development,
  };
}

export class ClusterProjectRuntimes {
  private stopped = false;
  private readonly gateways = new Map<string, Hosts>();
  private readonly opening = new Map<
    string,
    Promise<{ lease: DevelopmentLease; handshake: ClusterRuntimeHandshake | null }>
  >();
  constructor(
    private readonly store: Store,
    readonly allocations: ClusterDevelopmentAllocations,
    private readonly prepareBundle: PrepareClusterBundle,
    private readonly runner: ClusterRunner = sshRunner,
  ) {}
  saved(projectId: string): ClusterRuntimeHandshake | null {
    const raw = this.store.getSetting(`cluster-runtime:${z.uuid().parse(projectId)}`);
    return raw ? handshakeSchema.parse(raw) : null;
  }
  open(
    record: ClusterProjectRecord,
    settings: ClusterSettings,
    onPreparing: () => void = () => {},
  ) {
    return this.beginOpen(record, settings, undefined, onPreparing);
  }
  continueOpen(
    record: ClusterProjectRecord,
    settings: ClusterSettings,
    expected: DevelopmentLease,
    onPreparing: () => void = () => {},
  ) {
    return this.beginOpen(record, settings, expected, onPreparing);
  }
  private beginOpen(
    record: ClusterProjectRecord,
    settings: ClusterSettings,
    expected?: DevelopmentLease,
    onPreparing: () => void = () => {},
  ) {
    if (this.stopped)
      return Promise.reject(
        new Error('The cluster runtime controller is stopping; saved startup intent is retained.'),
      );
    const pending = this.opening.get(record.id);
    if (pending) return pending;
    const operation = this.openOnce(record, settings, expected, onPreparing).finally(() =>
      this.opening.delete(record.id),
    );
    this.opening.set(record.id, operation);
    return operation;
  }
  private async openOnce(
    record: ClusterProjectRecord,
    settings: ClusterSettings,
    expected?: DevelopmentLease,
    onPreparing: () => void = () => {},
  ) {
    const input = developmentInput(record),
      lease = expected
        ? await this.allocations.observeExisting(input, expected)
        : await this.allocations.ensure(input);
    if (this.stopped)
      throw new Error(
        'The controller stopped during allocation reconciliation; its saved lease is retained.',
      );
    if (lease.state !== 'ready') return { lease, handshake: null };
    onPreparing();
    let handshake = this.saved(record.id);
    {
      // Explicit reopen consults positive owned-step exit proof even for a saved handshake.
      const bundle = clusterRuntimeBundleSchema.parse(await this.prepareBundle(record, lease));
      onPreparing();
      if (this.stopped)
        throw new Error(
          'The controller stopped during installation; explicit reopen can reconcile its saved lease.',
        );
      const payload = Buffer.from(
        JSON.stringify({ record, lease, bundle, clusterSettings: settings }),
      ).toString('base64');
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
          quote(runtimeCoordinator),
          payload,
        ],
        null,
        75000,
      );
      onPreparing();
      if (this.stopped)
        throw new Error(
          'The controller stopped during preparation; saved startup intent is retained.',
        );
      if (reply.code !== 0 || reply.timedOut)
        throw new Error(
          'Cluster runtime has no confirmed start. Its native history and startup intent are retained; inspect setup before retrying.',
        );
      handshake = handshakeSchema.parse(JSON.parse(reply.stdout));
      if (handshake.jobId !== lease.jobId || handshake.leaseToken !== lease.token)
        throw new Error('Remote runtime allocation identity changed.');
      if (
        (record.remoteWorkspaceId && record.remoteWorkspaceId !== handshake.hostId) ||
        (record.remoteProjectId && record.remoteProjectId !== handshake.projectId) ||
        (record.remoteManagerId && record.remoteManagerId !== handshake.managerId)
      )
        throw new Error(
          'Remote project or native manager identity changed. Refusing to send input.',
        );
      this.store.setSetting(`cluster-runtime:${record.id}`, handshake);
    }
    await this.gateways.get(record.id)?.close();
    onPreparing();
    const pinned = handshake;
    const hosts = new Hosts(
      '',
      async () =>
        connectClusterLoopback(input, lease, pinned.port, async () => {
          return this.allocations.verifyCurrent(input, lease);
        }),
      [
        {
          id: record.hostId,
          label: record.name,
          accountLabel: record.folder.username,
          expectedHostId: pinned.hostId,
          sshAlias: record.folder.alias,
          remotePort: pinned.port,
          credential: pinned.credential,
        },
      ],
    );
    this.gateways.set(record.id, hosts);
    await hosts.connection(record.hostId, true);
    try {
      onPreparing();
    } catch (error) {
      await hosts.close();
      this.gateways.delete(record.id);
      throw error;
    }
    if (this.stopped) {
      await hosts.close();
      throw new Error(
        'The controller stopped during gateway setup; saved native history is retained.',
      );
    }
    return { lease, handshake };
  }
  hasGateway(projectId: string) {
    return this.gateways.has(projectId);
  }
  gateway(projectId: string) {
    const gateway = this.gateways.get(z.uuid().parse(projectId));
    if (!gateway)
      throw new Error('Open this cluster project to reconnect its exact remote runtime first.');
    return gateway;
  }
  async close() {
    this.stopped = true;
    await Promise.all([...this.gateways.values()].map((gateway) => gateway.close()));
    this.gateways.clear();
  }
}
