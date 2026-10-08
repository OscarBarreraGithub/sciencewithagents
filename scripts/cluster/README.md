# Remote runtime infrastructure

The deployment packager and compute scratch helper support the cluster-resident app-runtime
integration candidate. They preserve native provider homes and durable app data;
only regenerable builds use a verified private node-local job directory. Scratch selection
tries native `SLURM_TMPDIR`, protected native `TMPDIR`, then `/scratch`, retaining filesystem,
ownership, capacity and allocation identity checks.

The staged services cover saved workspace metadata, an owned renewable SSH-client lease,
exact development-allocation receipts, private runtime connections, compute metadata and
recoverable project registration. The integration candidate wires controller and compute
startup, authenticated routes, and project-scoped admission into the current runtime.
Native Slurm observations remain advisory.
The optional model-based Slurm reviewer now checks fixed development proposals and recognized
managed-Claude submissions when enabled. Fresh policy starts Off; saved choices remain.
Owner review routes and typed manager tools use the ordinary model policy and work queue.
An explicit project open is the submission boundary; uncertain acknowledgements and queued
allocation checks retain their original identities instead of requesting replacement jobs.
The coordinator and idle release validate each private durable parent before native control.
Compute Codex startup records only its fixed provider launcher chain, including process start
identity, executable and arguments. Idle release revalidates that chain before closing it;
unknown tools or background descendants retain the allocation, as does unavailable process proof.
A local `srun` client exit alone cannot authorize another runtime: startup intent, locks and
history remain intact until compute-side termination can be independently verified. An
existing matching handshake may reconnect through the authenticated runtime gateway.
Readiness and its exact startup intent are verified inside the owned compute allocation;
login hosts can cache missing shared-file lookups. A bounded metadata wait never starts a
second runtime, and missing or unreadable readiness retains the original intent.
The cluster gateway gives identity and peer-proof requests one server-owned 15-second
connection-start bound because each connection verifies ownership and starts a Slurm pipe.
Ordinary hosts keep their 2-second identity and 5-second peer-proof bounds.
Cluster proofs and HTTP requests share a bounded private connection pool for the exact
allocation. Every forwarded request still verifies a fresh proof and the pinned host identity;
closing or replacing the transport closes its pooled pipes.
Slurm gateway pipes use unbuffered output so keepalive JSON, events, and socket frames
arrive before the native stream ends.
Startup uses a fixed compute-side shell to execute pinned node-local Node paths; native
Slurm can resolve the launcher on the login host while runtime files remain on compute.
Provider paths resolve the cluster's existing CLI unless the owner pins an executable in
the private deployment descriptor. The installer does not upgrade provider CLIs: verify the
target version and native model catalog before manager selection, as described in [setup](../../docs/CLUSTER.md#saved-project-setup).
Cluster folder registration validates the canonical path, inode and saved owner across hosts,
then binds consent to the compute host's local folder identity. Ordinary local folder guards
remain unchanged. Older descriptors without an owner snapshot require a runtime-user-owned
folder; new shared lab folder selections capture their owner during validation.
The staged admission inbox binds one short-lived grant to the verified native account and
prepared request, consumes it with the local reservation, and retains final receipts until
acknowledged. Reads never consume grants. Native ordinary-usage blocks remain authoritative;
transient Claude metadata failures remain distinct from native sign-out. The account ledger
shares allowance reservations across remote projects while each runtime owns its compute.
The prepared request includes the project's Follow QUARK preference, so switching it off
bypasses app pacing and reserve policy while native ordinary-usage blocks remain authoritative.
New native account ledgers start with pacing off. Explicit saved account policy survives restart;
only enabled account pacing on a project that follows QUARK requires fresh allowance telemetry.
The saved project registry creates a separate generated destination without allocating compute
or starting a model turn. Explicit open starts bounded preparation; cached progress reads do not.
Controller routes are registered and the runtime admission adapter is supplied by the candidate.
The remote admission service has a typed Runtime adapter: metadata-only account reads,
nonconsuming admission reasons, transactional grant consumption and verification before native
input. Its snapshot scans at most 128 conversation heads, returns at most 32 prepared requests,
keeps owner/recovery FIFO, and rotates past unprepared work. The internal gateway path allowlist
must remain unavailable through browser proxy routes.
Compute Codex socket startup has a bounded 65-second allowance for native history initialization;
ordinary local startup remains 20 seconds. Admission discovers accounts in the background, so
bootstrap health and gateway reads do not wait for provider startup. Failed identity checks retry
after the existing one-minute metadata cooldown, with one pending read per provider. Pending
checks remain unavailable, and account changes discard the old reader and allowance authority.
Idle drain pauses new background account reads and waits up to 15 seconds for owned pending
reads to close before strict native-process proof. Telemetry alone does not reset material idle
time or change saved account readiness; an unfinished read retains the allocation for a retry.
Native homes, SQLite paths, credentials and ordinary native permissions are inherited unchanged.
The executable `development-runtime.mjs` bootstrap is included with the server admission
consumers; packaging still rejects a missing bootstrap. Existing cluster observation and
native SSH workflows remain available.

Compute builds check the inherited C++20 compiler, falling back to the site's `gcc` module
in a child login shell when needed. Build flags retain static C++ runtime linkage; publication
still requires the native PTY and SQLite smoke check under the original environment.
No shell profile or native provider home is changed. See the
[FASRC compiler guide](https://docs.rc.fas.harvard.edu/kb/cpp-programming-language/).
Runtime archives are written to a private sibling of the build tree, keeping GNU tar's
input stable. Publication still verifies extracted files, native behavior and archive checksums;
failed build evidence is retained, and successful publication removes its temporary archive.

Run the local infrastructure checks with:

```sh
node --test scripts/cluster/deploy-runtime.test.mjs
pnpm --filter @dock/server exec vitest run src/cluster-compute.test.ts src/cluster-bootstrap-store.test.ts src/folder-picker.test.ts
pnpm --filter @dock/server exec vitest run src/cluster-workspace.test.ts src/cluster-development.test.ts src/cluster-runtime.test.ts src/cluster-transport.test.ts src/cluster.test.ts
pnpm --filter @dock/server exec vitest run src/cluster-native-accounts.test.ts src/cluster-admission-inbox.test.ts src/cluster-admission-ledger.test.ts src/cluster-admission-controller.test.ts src/cluster-projects.test.ts src/cluster-remote-admission.test.ts
pnpm --filter @dock/server exec vitest run src/cluster-native-startup.test.ts
```

These checks use owned local fixtures. Separate FASRC acceptance verified cold/warm startup,
native Continue and retained history with an owner-pinned side-by-side Codex CLI. The reviewed
idle implementation then naturally released one fresh allocation under an explicit one-minute
policy, with an exact private zero-work barrier and native cancellation. The default 20-minute
policy has local fake-clock coverage; earlier real 20-minute attempts were inconclusive.
Owner installation and native fixture archival remain separate. Released allocations stop
admission polling until reopen.
