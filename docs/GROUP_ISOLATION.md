# Group native process isolation

> Retained isolation implementation. Groups v1 now uses normal host-native agents with
> separate shared/private conversations; this Linux route is not a setup prerequisite.
> Existing isolated receipts remain separate and are never silently migrated. See
> [current Groups setup](GROUP_NATIVE_OWNER_SETUP.md) and [status](STATUS.md#groups).

Production group agents remain denied until independently reviewed real acceptance.
The host-only full execution route is now `Runtime.queueGroupExecutionProbe` →
`GroupNativeBridge.probeExecution` → existing Codex/Claude adapters in an owned
Linux process namespace. It can sign in natively and immediately run a real tool
turn in the same admitted capability. The older authentication-only route remains
available as evidence, **not an owner sign-in endpoint or the deliverable**.
No browser launch switch, credential import, unmanaged CLI fallback or tool-by-tool
replacement exists. The normal app uses this connector through protected owner setup.
Actual local Engine/tool/compiler checks are recorded separately from provider sign-in,
per-artifact native readiness and two-installed-computer acceptance. Use the final reviewed
public image and matching loaded host source; old image/build receipts cannot enable a
changed artifact. See [native owner setup](GROUP_NATIVE_OWNER_SETUP.md) and [Status](STATUS.md#groups).

## Trusted native bridge

`GroupNativeJournal` uses the existing group repository's generated group/member/
installation identity and fresh shared/private contexts. Host-issued opaque handles
recheck persisted active membership on each use. A forged browser object is rejected.
The group repository receives fresh opaque source aliases; real native conversation and
message IDs stay in a private local SQLite journal. Claude reserves a fresh UUID before
startup; Codex must bind its actual `thread/start` result afterward. No personal/native-source fork or identity adoption is performed. Production may
resume only the already bound group native identity in its original owned guest volume. Shared message aliases are durable and scoped; private contexts cannot
produce a publication source. Nothing uploads raw Store/SSE/native history.

Preparation checks the actual running host run, executing set, QUARK run ledger and
reservation and current QUARK reason, then uses central
`ModelPolicy.prepare` and rechecks admission after asynchronous work. Explicit native
pins are retained. Global scheduler pause blocks new admissions; already admitted native
work retains live authority. Actual project/manual/QUARK holds, native stop intents,
revoked membership and expired grants still revoke that authority. The local journal permanently claims each preparation before touching
native state; even a failed attempt cannot reuse that context after restart or with another
state root. Canonical broker paths also have permanent unique journal claims across state
roots/restart. Inspect an uncertain attempt; a new authorized context is a separate action.
Journal identities/mappings/claims/events are append-only. This API is not exposed to peers.

`NativeProviderBoundary` is an internal dependency of `CodexRpc` and `ClaudeSession`.
It covers the native supervisor spawn and Claude's auth identity check, which otherwise
runs `auth status` using ambient state. Existing ordinary launches keep their existing
behavior. Group adapters retain native inheritance switches; no tool-by-tool shim is
introduced. Fresh homes do not establish access to existing native skills/hooks/MCP/plugin
configuration or authentication. Their actual compatibility is **unverified**, not preserved
by a test fixture. The full Linux route obtains a sanitized Claude affinity through native guest
`auth status`; the old macOS preparation seam still requires its pinned host affinity.
Neither is proof of actual provider/tool compatibility.

Keep the local journal and Store under private host data outside group resource/state
roots. The bridge explicitly forbids their parent directories and existing native account
homes/config paths. Group state needs a separate owned root, not a child of a forbidden
host-data directory. Host inventory must still include other private resources/control
sockets; this is not automatic discovery of every resource on the computer.

## Production host connector and durable recovery

`createGroupNativeConnector(runtime, {directory, events})` in
`apps/server/src/group-native-connector.ts` shares the normal GroupHost's exact
`GroupEventRepository`. Normal-host code owns enrollment validation, its request/result
ledger, UI and source projection. The native connector owns fresh context/native identity,
resource admission, guest lifecycle and exact native result receipts. Its local methods are
`availability()`, `submit({requestId,key,context,enrollmentHandle,text})`,
`inspect({requestId})` and `close()`. The input context must be a persisted active owner
anchor already validated by GroupHost; it is never resumed as a native conversation.
The private native binding includes installation/member/group/visibility **and** owner
anchor identities. Different anchors/shared/private contexts cannot silently share history.
`availability()` returns the finite normal-host auth state: an unconfigured or unverified
route is `unavailable`; a reviewed execution route is `per-context`. This does not assert a
globally signed-in account: each isolated context still verifies its own native auth at
admission. The bootstrap injects the same runtime/events/directory factory; readiness is
neither an auth-only probe nor permission to bypass real acceptance gates.

The protected setup command registers `configureGroupNativeRoute(runtime, {projectId,provider,image,resources})`.
This stores a typed host grant, not an available flag. Browser requests supply no paths,
commands, executables, image, provider, RPC method or runtime configuration. A chat-first
route may use `workspace:null` with no read grants: its only writable workspace/native
state is the guest volume, and it mounts no host input. Resource inputs
must be immutable, exclusively owned approved snapshots; inode/canonical checks cannot
make an actively hostile ancestor swap atomic. The complete private inventory includes
Store/journal/host-control data and all feature owners' Git/history/document control state.

`Runtime.queueGroupNativeRequest` uses ordinary central ModelPolicy/Pulsar/QUARK per
actual execution, serializing requests for the same dedicated context. Its permanent lane
marker prevents any ordinary unconfined provider restart. The connector persists request
input hashes/context mappings before enqueue and append-only submission intent before
native input. Codex binds the observed/acknowledged actual turn; Claude uses the supplied
native user-message UUID and saves its typed native final result **inside the same guest
volume before host forwarding**. Completed exact text/tool count/shared source is immutable.
Shared aliases must exist in the local native message journal; private results have no
publication source. No raw native frames or Store/SSE history enter this return contract.

Same-ID retries call `inspect`, never send input again. Recovery gets a new real QUARK
admission, inspects/retires each exact locally reserved namespace/manifest, verifies the
original local volume's ownership/driver/options, and reattaches that volume without
reading/copying/relocating credentials. Codex uses `thread/read` for the recorded turn;
Claude reads its exact session/delivery final-result receipt through a fixed guest helper.
Missing result/acknowledgement remains `unknown`; one completed inspection never repeats
uncertain tools. A partial create is inspected by its permanently reserved generated name,
with full ownership/manifest checks before any cleanup. Unverified namespace stop retains
its actual admission/hold. Interrupt and shutdown persist a stop intent before closing:
the run and QUARK/Pulsar ledgers remain unfinished until verified namespace close. Failed
close survives host recovery and occupies its existing slot; it cannot admit replacement
work. Missing or conflicting guest state cannot be adopted as new auth.

The protected `ownerAcceptance({context,enrollmentHandle})` creates the intended fresh
normal binding and returns `{context,runId,admitted,approve}`. It invokes the supported
full-execution probe, preserving that same guest's auth/workspace/native identities for
later normal requests. There is no separate auth-only sign-in or credential import.
`ownerExecution(requestId)` and `continueAfterConsent(requestId)` are local owner-service
methods for an already admitted pending real request; consent/device codes never enter the
group feed. Closing the connector interrupts only its own dedicated agents and stops their
owned namespaces before closing private journals.

`registerGroupNativeCapabilities(runtime, kind, factory)` supplies the separate feature
owners' scoped `ClaudeHostTool[]` catalog for `coordination`, `private-history` and
`documents`. Existing Codex dynamic-tool and Claude SDK MCP transports receive these
additions; handlers recheck admission around execution. Normal feature adapters connect
coordination, private history and explicit artifact grants. Their local integration checks
do not establish external provider/platform acceptance or provide a generic Runtime RPC.

The owning connector's `gitExports(authorize)` returns the Git adapter's concrete
`acquire(request)` / `inspect(exportId)` immutable export port. The protected Git owner
resolves the exact review/grant/history/resource tuple to `{contextId,guestRepository,
revalidate}`. Only an existing shared native context bound to the same owner anchor or
native source is accepted. Guest paths are host-selected under `/workspace`; browsers
cannot configure this port. It reuses the live admitted native capability when called by
a native tool, or admits a read-only inspection of the original guest volume through
ordinary ModelPolicy/Pulsar/QUARK, with verified namespace cleanup afterward.

Fixed public Python/Git plumbing inspects every reachable commit, tree and blob for the
reviewed `sourceOid`, checks exact content paths and byte/object limits, and rejects private
history, symlinks, submodules and LFS before emitting any object bytes. Dirty worktree bytes,
index, repository config, hooks, credentials and unrelated objects are not exported. It
retains validated bytes in memory rather than rescanning mutable input to build a pack.
The host independently verifies the same exact closure and writes a new bare snapshot
plus append-only attestation beneath the private native journal root, outside guest mounts.
Read-only modes and identities are checked along with the complete object manifest; the
existing whole-process boundary, not a Node pathname check, denies guest writes there.
Same-ID recovery inspects the retained snapshot and current authority/admission receipts;
an uncertain export intent never launches another export. Public Git/Python canaries run
on synthetic local repositories prove plumbing compatibility and denial order only. Actual
guest checks are separate from real provider acceptance and actual GitHub publication.

Production readiness requires current real guest privacy+nested/browser, native tool/nonce,
**both** fork/setsid/double-fork crash and explicit-stop observations, plus the owner's exact
independent-review disposition accepting Linux-native scope. Receipts bind immutable image,
public image source, loaded host artifact and actual Engine/API/kernel/architecture. A host
source change after startup, source/image/kernel mismatch, missing mode or wrong provider
denies launch. No arbitrary `available=true` injection enables it. These checks are actual
owning-executor observations; fake unit fixtures establish contracts only.

## Full native execution route and owner acceptance

The preferred owner choice is the **existing Docker Desktop Linux ARM64 route**,
subject to the owner's applicable runtime licence. The owner handles runtime startup
and necessary fresh guest sign-in after exact review. The app does not select or install
an alternative runtime automatically. The explicit capability tradeoff is Linux native
CLI/browser execution:
**macOS app-control/computer-use and macOS browser-extension bridges are unavailable**.
No account, licence acceptance or payment is selected automatically.

Use a fresh dedicated native agent and journal-issued context in the owning Runtime.
`queueGroupExecutionProbe(bridge, handle, resources)` uses that Runtime's exact central
ModelPolicy, scheduler, Pulsar and QUARK. It returns `{runId, admitted}`; real holds stay
queued. There is no second reservation ledger, new model-usage ceiling or scheduler.
`resources` is host-only: reviewed image SHA256 ID, approved host project input, read
resources, private state base/inventory, expiry and exact outbound DNS-name/port grants.
The namespace's CPU/memory allocations are the **existing admitted Pulsar estimate**;
Docker's VM adds host memory/CPU overhead that the host must observe through ordinary QUARK
capacity. The implementation does not start/reconfigure the VM or invent spare capacity.

The reviewed public image context is only `runtime/group-native/`. Its default-deny
`.dockerignore` whitelists public runtime files; repository/data/native homes are never
sent. Base Node 24.19.0 bookworm-slim is pinned to official multi-platform digest
`sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`;
Codex 0.159.2, Claude Code 2.1.288 and ws 8.18.3 are pinned. Debian system packages
come from the pinned base's configured repositories; their resolved versions must be
recorded in the real build receipt. No claim of byte-reproducible apt resolution is made.
The reviewed Claude package postinstall places its bundled Linux binary inside the
image; it never runs on the host or signs in. The setup agent builds with a newly created
empty mode-0700 Docker configuration directory and scrubbed HOME/DOCKER_CONFIG, using
`groupContainerBuildRecipe(config, socket)` from compiled `group-container.js`.
The returned executable/argv/environment are the complete supported build recipe:
fixed installed `/usr/local/bin/docker`, one of the two fixed local Engine sockets,
`build --platform linux/arm64 --build-arg SOURCE_DIGEST=<source digest>`, source-digest tag,
and this public directory. It does not execute anything. Build only after review/startup;
inspect the resulting local image ID through the same fixed Engine and pass that SHA256
ID to the host probe. No context/config lookup, credential helper, push or implicit pull
at native launch is permitted. Image label/source digest and immutable image ID are
checked before create; a label alone is not independent build provenance.

The guest is `network=none`, private PID/IPC/UTS/mount namespaces, no published ports,
no restart, read-only image and no host device/control/Docker/agent socket mount. PID1
is the trusted root transport with CHOWN only; native adapters, tools, Xvfb and helpers
execute as UID1000 with zero effective capabilities and no-new-privileges. The pinned
Moby syscall baseline remains deny-default; its only expansion allows nested native
user/mount namespace syscalls inside this outer namespace, without SYS_ADMIN or
`seccomp=unconfined`. `/proc/1/fd` access is denied by UID ownership. The Linux kernel's
PID-namespace teardown kills every contained process, including setsid/double-fork and
nested descendants, when PID1 exits. Actual Engine/crash behavior still needs the real
canary; process-group killing and ancestry polling are not the proof.

Host project input mounts read-only at `/resources/workspace`, other grants at
`/resources/0`, etc. Writable `/workspace`, native homes, credentials, histories,
skills/hooks/config and all Git control files live in the fresh owned guest volume.
The host never executes Git/config/hooks from that volume. Approved input can be copied
by native tools into the guest workspace when editing; this is **not** an automatic
credential copy, file export or publication. Private and shared contexts use different
fresh volumes/identities. No context/volume is automatically adopted after a restart.
Volumes persist locally after stopped-container removal; cleanup neither reads nor
exports their contents. Root's acceptance fixture must archive Codex sessions through
`archiveAndClose()` (or `crashStopCanary()`, which archives first). Fixture-volume
retirement needs a separately owned metadata-verified operation; this route leaves it
private rather than deleting or reading an unknown credential store.

The lifetime uses the private attached root stdin (`StdinOnce=true`), owner heartbeat,
expiry and explicit Engine PID1 kill. Native tools cannot obtain the root input pipe.
Missing heartbeat stops the guest within five seconds of guest scheduling; a prolonged
host/VM pause may consequently stop work, which must not be replayed automatically.
Stop inspects the exact owned container, checks stopped state, then removes only that
container. An uncertain stop records a durable local hold and retains QUARK admission;
it never acknowledges stop or launches another provider. Engine inspection validates
entrypoint, image, namespaces, capabilities, syscall profile, resource allocation and
exact mounts before native launch. Root must still demonstrate owned cleanup/crash
behavior on the installed Engine, not infer it from these unit tests.

Before any sign-in offer, `probeExecution` executes the guest privacy, actual bubblewrap
nested-user/PID/mount/network and Chromium native-sandbox canaries. Failure tears down
the guest; no `--no-sandbox` or silent tool-class fallback is used. Codex then starts via
the existing CodexRpc and private host Unix WebSocket → guest Unix relay. Native CLI
inheritance is enabled, with no feature-disable/MCP inventory rewrite. Native guest
`cli_auth_credentials_store="file"` must match effective configuration/managed requirements.
`authentication()` returns only sanitized state. `beginDeviceSignIn()` surfaces the native
one-time URL/code in memory to the local owner **only after root's reviewed consent**.
After native consent the same capability's `turn(prompt)` immediately starts a real
native model/tool turn using the central assigned model/effort. Native tokens remain in
the guest's own file store; no host credential is read/imported and no API-billing switch
is substituted. Fresh isolated shared/private scopes require their own native authorization.

Claude uses the existing ClaudeSession native stream protocol with an outer-namespace
supervisor and in-memory fixed auth-diagnostic classification, not raw stderr. Native
`auth status --json` is projected to its existing account-affinity hash, never exported.
`ownerClaudeLogin()` returns only the fixed owned guest terminal invocation for native
`claude auth login --claudeai`; root executes that supported interactive command after
reviewed consent, within this already admitted guest. No generic authentication RPC
exists. Native permission/questions remain visible through the original adapter and
`answerClaude`; Codex approval/questions/MCP elicitation use typed `answerCodex`.
Unimplemented native interaction types stop visibly rather than silently dropping a
feature. Actual Claude login/model/tool compatibility is still unverified.

| Native capability                              | Concrete route and actual limit                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell, filesystem, skills, hooks, helpers, Git | Original native tools in guest; input reads + owned writable volume. Guest Git commits/hooks stay native. Personal host configuration/history is not imported.                                                  |
| Browser                                        | Guest Chromium/Xvfb, Chromium sandbox kept; actual pre-sign-in canary required. Provider-specific Linux browser integration remains to be exercised; macOS app/extension bridges do not work here.              |
| HTTPS / remote MCP / Git HTTPS                 | Native end-to-end TLS through guest CONNECT relay, exact public IPv4 DNS-name/port grants. Plain HTTP, private/mixed DNS, raw IP/IPv6-only targets and unrelated destinations deny visibly.                     |
| SSH / Git SSH                                  | Native OpenSSH with guest ProxyCommand through the same exact port grant. Host SSH keys/agent sockets are absent; guest-native authorization is required.                                                       |
| Local MCP / plugins                            | Native group-scoped workspace/home configuration and guest processes; host localhost/control sockets are unreachable. No personal plugin/MCP configuration is copied. Remote destinations need explicit grants. |
| Native sandbox nesting                         | Moby deny-default plus explicit namespace syscalls; actual bubblewrap and browser canaries run before sign-in. Provider's own native sandbox composition remains a real acceptance gate.                        |

Root acceptance uses this same supported capability, not unmanaged CLI execution:

```ts
const queued = runtime.queueGroupExecutionProbe(bridge, handle, hostResources);
const execution = await queued.admitted; // inspect queued.runId for real holds
try {
  // Root obtains necessary native guest consent only now, after tool canaries.
  // Codex: execution.beginDeviceSignIn(); await native authenticated state.
  // Real provider tool event + synthetic nonce file readback, not a reply claim.
  const result = await execution.acceptanceToolTurn();
  if (!result.toolReceiptVerified) throw new Error('Real native tool receipt failed');
  const descendants = execution.startDescendantCanary();
  // Observe real fork, setsid and double-fork heartbeat frames on owned stdout.
  // Retain three observed classes and require pipe closure/no new heartbeats.
  const crash = await execution.crashStopCanary();
  if (!crash.stoppedWithoutHostKill) throw new Error('Guest owner-crash stop failed');
} finally {
  await execution.close(); // admission released only after confirmed namespace stop
}
```

Also test explicit stop with those descendant heartbeats in a separate fresh owned
context, expired/revoked admission, denied fabricated host-data/native-home/control
socket reads, new private/shared isolation and nonreuse, actual native provider sandbox,
required browser/MCP/SSH/Git flows and real counters. Codex token notifications and Claude
step/result counters use existing usage accounting; source aliases bind actual returned
native IDs only in the local journal. Shared results may return scoped opaque source;
private results never return publication authority. These tests must be recorded as
actual results before production activation; no self-certified enable flag is supplied.

Primary references: [Docker public Node tag metadata](https://hub.docker.com/v2/namespaces/library/repositories/node/tags/24.19.0-bookworm-slim),
[Docker native run/namespace options](https://docs.docker.com/reference/cli/docker/container/run/),
[Linux PID namespace teardown](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html),
[Moby syscall baseline](https://github.com/moby/profiles/blob/main/seccomp/default.json),
[Docker Desktop free-use eligibility](https://docs.docker.com/subscription/desktop-license/).
The vendored Moby baseline is SHA256 `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`
and retains its Apache license in `runtime/group-native/LICENSE.seccomp`.

## Retained macOS authentication-only route

The local owning executor calls `Runtime.queueGroupAuthentication(bridge, context, grant)`.
The bridge must reference that runtime's exact Store, ModelPolicy and QUARK instances.
Use a fresh dedicated native Codex agent without a task, parent, native thread or earlier
run. The host resolves the persisted member and issues the opaque context locally. Keep
workspace, state base and private host data disjoint. Grant the exact installed Codex binary
and its runtime closure; authentication requires no Node supervisor or provider tool sandbox.
The method uses the runtime-selected binary, not a browser executable field. The returned
`runId` exposes actual scheduler/QUARK holds; await `admitted` instead of bypassing a hold.

The normal central policy, scheduler, Pulsar reservation and QUARK ledger own this run.
A permanent dedicated-agent marker precedes enqueue. Lost in-memory ownership after
restart fails closed, including reconnect/client paths; it never converts into an ordinary
provider turn. Cancel held probes with `Runtime.interrupt(agentId)`. Active interrupt,
expiry, membership revocation and runtime shutdown close the owned probe and broker.

`GroupNativeBridge.probeAuthentication` starts the **existing CodexRpc adapter** directly
inside the OS profile, behind a fresh private Unix RPC socket. Codex receives its native
`cli_auth_credentials_store="ephemeral"` option; effective config and managed requirements
must agree before native account inspection. Native inheritance remains enabled, without
feature-disable arguments. The returned capability exposes only sanitized account state,
device authorization, status and owned close; no arbitrary RPC, thread, tool or publication API.
Constructing/inspecting it does not start sign-in. Its context is permanently burned even on
failure. Close it in `finally`; state and owned socket directories are deleted after native exit.

Native HTTPS uses a context-capability CONNECT proxy on 127.0.0.1. Its only destination grants
are `auth.openai.com`, `chatgpt.com` and `api.openai.com`, port 443. TLS stays end-to-end in the
native client; the host does not inspect bodies/tokens. The broker rejects other names, plain
HTTP, IP literals, private/special IPv4 DNS answers and mixed DNS results, and pins the checked
address into connect. IPv6-only destinations currently fail closed. The OS allows only TCP
localhost at this proxy port and the dedicated Unix listener. macOS's SBPL address grammar
requires `localhost`, not a literal IPv4 address; this is **not** a production network isolation
proof for arbitrary native tools. Keychain/securityd is denied; trustd is allowed for certificate
verification. No account file, token, email or provider diagnostic is copied into logs/journals.

Authentication-only mode **denies process-fork**. The actual Node24 OS canary demonstrated
owned Unix RPC, granted proxy access, `EPERM` for descendant spawn and exact-PID SIGKILL
on revocation. This restriction is explicit and is never offered as a native-tool-compatible
production mode. Provider tools, skills, hooks, MCP, browser and nesting compatibility remain
unverified. Unit fixtures verify the adapter/admission lifecycle, not installed-provider readiness.
Actual `initialize`/effective-policy/account checks remain necessary for provider readiness;
authentication-only canaries do not satisfy them.

This older ephemeral authentication route is retained for bounded evidence only. Do not
ask the owner to sign into it: it cannot execute native tools. The full guest route above
provides native authorization and an immediate real tool turn together.

Sources: [Codex credential storage](https://learn.chatgpt.com/docs/auth),
[native app-server account/device APIs](https://learn.chatgpt.com/docs/app-server),
[official ephemeral backend](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs).
Claude's [native authentication documentation](https://code.claude.com/docs/en/authentication)
scopes Keychain entries by CLAUDE_CONFIG_DIR, but whole-tree securityd access has not been
proven to protect other personal entries. The full Linux route above avoids macOS Keychain access through fresh native guest
state; actual Claude acceptance is pending. No extraction or API switch is substituted.

## Legacy macOS cleanup limit

A detached-session descendant survived the macOS process-group stop canary while still
inheriting file denials. The harness stopped that exact owned descendant and confirmed it dead.
Apple's [published setsid implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_prot.c)
changes the session/group without a MAC authorization hook; process-group killing alone
cannot establish whole-tree termination. This is concrete failure of the present cleanup route,
not proof against every possible privileged/supported supervisor. Keep production denied until
an actual provider probe demonstrates unchanged nesting, every required native tool class and
owned descendant termination. The auth-only restriction cannot satisfy those production gates.

## Boundary and host responsibilities

The host supplies an approved grant with installation, group, member, visibility and
fresh context UUIDs, positive revision, expiry, workspace, read resources, exact executable
and dylib files, state base and a complete private-resource inventory. This is a host-only
API: do not accept executable, argv, resource path or revision assertions from a browser.
The admission callback must check current membership and the exact saved identity,
revision and manifest digest before each process starts. A digest binds the manifest;
it is not a signature, a file-content hash or a substitute for owner authorization.

The macOS profile uses `deny default` around the entire process tree. Its allowances are:

- Workspace reads; workspace writes only for shared contexts. Private work can write
  only its own native home, scratch and temp. An explicit shared action must go through
  separately authorized host coordination.
- Explicit read resources and exact runtime files. Resource inventories are bounded to
  20,000 entries per root; existing outside symlinks, hardlinks and special files block
  admission. Additional resources require a new grant.
- Read-only `/System/Library` and `/usr/lib`, shell-selection file, root directory, random
  devices and `/dev/null`; null writes. Path ancestors, exact library directories and exact
  aliases resolving to approved runtime files receive metadata access for dyld. Sibling
  metadata subtrees are no longer granted; runtime metadata inventories stop at 20,000 entries; an actual ungranted-sibling `stat` is denied.
  Sysctl access is limited to hardware names, page size and named OS/argument-limit values.
  An explicit `process-info* (target others)` deny is also required: a real numeric
  `KERN_PROCARGS2` canary reads fabricated argv/env with sysctl filters alone, but is
  denied with this guard. Self inspection, Node and scoped Unix connections still work.
  Inspection of other processes, including group siblings, is denied; wider native process
  inspection needs a demonstrated scoped route, not silently relaxed privacy.
- Host-approved executables plus `/bin/sh`, `/bin/bash` and `/usr/bin/sandbox-exec` for
  probes, forking and self signals. Other execution, general Mach lookup, browser/GUI
  services, IPC and network access have no allowances.
- Optionally, one existing Unix socket bound to the same identity and revision. Outside the explicit auth-only route, TCP,
  UDP, listeners and unrelated Unix sockets remain denied. Socket reachability does **not** authenticate a caller: a
  future trusted broker must authenticate the connection, bind its identity, recheck
  membership/revision and enforce typed operations. The authorization helper permits
  private reads of shared/own-private evidence and denies private shared proposals.

Native persistence lives in fresh, exclusively created
`stateBase/installation/group/member/visibility/context/{native-home,temp,scratch}`.
A permanent exclusive `.claimed-contexts/contextUUID` marker under the state base
prevents reuse after close/restart. `close()` deletes only the working context, not the
claim. Broker paths also get permanent hashed claims; rebinding the same path to another
context is refused. Claims remain outside process grants. The native bridge's local
preparation ledger additionally prevents identity reuse with another state root. Shared, private and
other-member homes receive no implicit cross-context read grant. The host inventory must explicitly exclude its data
directory (including `agent-client.json`), personal Codex/Claude homes and unrelated
chats. The harness uses fabricated copies only; no real credential or native history is
read, copied, modified or logged.

The environment is rebuilt, never merged. HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and XDG
roots point inside the context. Temp roots are private. PATH is `/usr/bin:/bin` and
OpenSSL configuration is `/dev/null`. Ambient Node/shell startup hooks, proxies, MCP
configuration, browser endpoints, SSH agent sockets and app-client environment are absent.
Canaries inherit ignored stdin and fresh stdout/stderr pipes; the auth-only native adapter
inherits its owning lifetime stdin pipe, ignored stdout and a drained private stderr pipe. Programs can still open
configuration intentionally inside their approved roots; an approved MCP/tool binary is
subject to the same inherited OS boundary. No tool implementation is replaced here.

## Observed compatibility

Checked on Apple Silicon macOS 26.5.2/build 25F84, Darwin 25.5.0, Node 24.19.0, installed
`/usr/bin/sandbox-exec`. The test harness enumerates the installed Node's transitive dylib
files with `otool`; it never grants all of Homebrew. Pinned lockfile dependencies were
installed only in the task copy with scripts disabled and project-local caches.

Actual confined Node, builtin SQLite, shell and Bash canaries demonstrate granted file
reads/writes; native filesystem casing and Unicode-equivalent path resolution,
wrong-case/Unicode protected-overlap rejection and scoped projects beneath ambient homes;
denial of fabricated host-client, personal-history and unrelated-chat reads;
post-admission symlink escapes; outside/read-only writes; child and grandchild read
attempts; scrubbed environment; separate context persistence; private shared-workspace
write denial; scoped Unix connection and forbidden Unix/TCP connections/listeners; and
unapproved browser-launch execution. Tests also cover grant revocation, expiry, changed
root identity, broad/overlapping resources, hardlinks, reused contexts, output/deadline
limits and cleanup without stopping a separate unrelated process.

**The module's current permissive-inner nesting probe blocks admission.** A nested
`sandbox-exec -p '(version 1)(allow default)' /bin/sh -c 'printf nested-ok'` returns
exit 71, empty stdout and exact stderr `sandbox-exec: sandbox_apply: Operation not permitted\n`.
A grant requiring nesting therefore raises `GROUP_ISOLATION_BLOCKED` before its payload
starts. The failed probe still blocks before payload launch.

The minimal diagnostic harness in `group-isolation-nesting.test.ts` distinguishes this
failure from intrinsic nesting incompatibility. Under the harness’s hand-written minimal
deny-default outer profile, an **identical minimal inner profile succeeds** (exit 0,
`nested-ok`, empty stderr). This is not the generated `GroupIsolation` profile, which
adds workspace/runtime/state grants, signals, broker rules and forbidden denies. Nesting
of that generated profile with an identical inner profile remains untested. Nested
shell canaries still deny ungranted reads/writes and unapproved execution. Adding only
`(allow system-mac-syscall (mac-policy-name "Sandbox"))` to the diagnostic outer profile
does not fix the permissive-inner probe: it still exits 71 with the same stderr. That
allowance is never installed in the production profile. The profile relationship is a
reproducible difference; the precise OS enforcement mechanism is not established here.
No additional allowance is needed for the successful identical-profile case, and no
provider sandbox is disabled or bypassed. Normal Bash subprocesses also work.

The harness preserves exact outer/inner profiles, executable/argv arrays, sanitized
environment, cwd, exit/signal, stdout/stderr, Node version, `uname -a` and `sw_vers` results
in ignored task-local `apps/server/data/group-isolation-evidence/nesting-*.json` when run
through the package command below. Scratch fixtures are removed; evidence is deliberately
retained outside Git. These are exact reproductions for this host, not portable OS claims.
Independent outer-boundary tests use grants explicitly declaring nesting unnecessary;
the module never retries a failed nested grant with less isolation. Actual provider profile
composition under the generated profile, authentication, provider Bash permissions and
full native tool compatibility remain unverified. Identical-profile canaries do not admit a provider. A future probe must
exercise the provider's own sandbox unchanged and pass separate review before enablement.

Unsupported OS/architecture, absent sandbox binary, invalid resources, OS startup refusal,
nested failure and stale host admission block visibly through `GroupIsolationBlocked`.
The startup-refusal test fault-injects a deny-all profile and exercises actual denied shell execution. There is
no full-access fallback. This macOS profile blocks Linux/Intel Mac/Windows. The new Linux guest adapter above
is separate; its local Engine checks do not prove actual provider acceptance.

## Legacy macOS access-profile limits

All policy bindings, symlink targets and ancestry checks use `realpathSync.native`;
forbidden profile rules reuse their bound canonical paths. Case/Unicode folding is not
performed independently of the filesystem. The actual case-insensitive Mac fixtures
exercise wrong-case and NFC/NFD aliases; other filesystems’ equivalence behavior is not
certified. The ambient-root guard rejects both HOME-derived and real account homes (`os.userInfo`),
their Library directories, system Library,
Applications, Volumes, system/Unix roots and their ancestors, but allows scoped project
directories beneath them. It does not replace a complete private-resource inventory.

**Agent-writable Git control files are a host-code execution gate.** Shared workspace
write access includes `.git/config`, `.git/hooks` and other host-interpreted control files.
An agent can plant `core.fsmonitor`, `core.hooksPath`, a `reference-transaction` hook or
other executable repository configuration that later unsandboxed host Git commands
(`status`, `fetch`, ref updates, etc.) may run outside this boundary. Before any provider
admission, host Git must either use a demonstrated complete hardened configuration
(disable hooks, explicitly disable fsmonitor, and exclude repo-local executable config
and other applicable execution paths), or keep/deny Git control directories outside the
agent-writable grant. Turning hooks off alone does **not** protect arbitrary executable
repo config. Hardening host Git may disable native Git integrations; removing writable
Git control state prevents or limits agents’ own native commits, branches, hooks and
configuration. That native-Git trade-off needs owner choice and separate validation;
this disconnected module implements neither option. Host Git hardening is a separately
reviewed integration requirement.

Path resolution and device/inode bindings are rechecked before compatibility probes and
payload launch. Sandbox path checks enforce tested symlink escapes after launch. This is
not atomic, descriptor-based grant installation: another unsandboxed process with the
same owner's authority can change content, hardlinks, ancestor directories or socket
ownership during the check/launch interval. Initial inventory checks do not prevent
later host-side hardlink insertion. Before provider admission, the responsible host must
establish immutable/exclusive snapshots, runtime ownership and grant-root ancestry, or
demonstrate an additional enforcement mechanism. Treat that as an unresolved gate, not a
TOCTOU guarantee. Expiry/revocation is checked at launches; continuous revocation of a
running provider has not been implemented.

Each canary has a 1–10 second deadline and 64 KiB combined output limit. Cleanup kills
only its detached spawn's process group, then removes only its bound context directory;
workspace and read grants remain. A killed orphan may briefly remain an OS zombie. A
descendant deliberately creating another session retains confinement but is **not**
covered by cleanup; a changing-heartbeat canary now demonstrates this. Permanent context
claims and the bridge ledger refuse context/path reuse, including after restart, but do
not establish whole-tree termination. Daemon/reparenting cleanup, inherited handles beyond the tested stdio/socket cases, malicious dylibs, actual
Mach/browser RPC escape probes, UDP/external Internet attempts, complete filesystem
race attacks and disk/CPU/memory quotas remain unverified. This is resource _access_
confinement, not a hard CPU/memory accounting implementation. Those macOS canaries do not establish native network/authentication readiness. The
separate full Linux host route above is connected in source and awaits real acceptance.

Targeted canaries cover real-account-HOME, discriminating shared-
ancestor case/Unicode, runtime sibling-metadata, sysctl, permanent identity and broker
placement/nonreuse canaries. Brokers must be privately owned (no group/other mode bits)
and outside workspace/read/native-state roots. Filesystem races, global inventory and
escaped descendants remain gates. None of these canaries certifies real native auth/tools.

The bounded Mac lifetime experiment found no supported unprivileged whole-descendant
supervisor on this macOS26.5.2 host: `es_new_descendants_client` is absent (introduced
with macOS27 and requires EndpointSecurity entitlement); standard `es_new_client`
returned ERR_NOT_PRIVILEGED without subscribing. The installed SDK marks kqueue
NOTE_TRACK/NOTE_CHILD descendant tracking unsupported since macOS10.5. No privileged
service, entitlement/TCC change or OS update was attempted. This concrete evidence led
to the reviewed separate-runtime route above, not more speculative Mac variations.

Run only the focused harness with Node 24:

```sh
sh scripts/pnpm --filter @dock/server exec vitest run src/group-native.test.ts src/group-isolation.test.ts src/group-isolation-nesting.test.ts
```

Fixtures and sockets are under ignored task-local `data/tests`; all created listeners and
owned canaries are closed by the harness. This document reports source/canary evidence,
not installation activation, Claude approval, provider sign-in or delivery of group features.

Owner-confirmed Stop uses the typed original-owner cleanup lane and needs no model,
allowance, scheduler or resource admission. It still binds current group ownership,
causal work revision and the exact native child/run; retry never targets a later turn.
Start keeps ordinary admission and manager-lease guards. Coordination refresh reads
an authenticated exact work record, including tasks beyond the board's 50-row snapshot.

Retained Git export admission evidence is read by its exact durable run ID, including
completed reservations beyond the recent scheduling window. Snapshot revalidation
still checks current scope/grants, original ledger, and verified namespace closure.
