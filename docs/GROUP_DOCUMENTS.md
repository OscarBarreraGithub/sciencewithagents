# Group reports and scoped document access

Normal Groups connects scoped document storage, native completion capture, explicit grants
and the existing Reading/PDF interface. The reviewed compiler recipe and controlled two-host
report journey have local acceptance checks. Real provider-generated reports, deployed hosting
and two installed computers remain separate acceptance; see [Status](STATUS.md#groups).

## Authority and exact grants

A trusted normal-host result projection calls `GroupDocuments.offer(slotHandle, resultId)`.
The native owner must describe a **verified completed** result: exact request/result/source
receipt, group/member/installation/context/visibility and immutable per-file digest/size.
It must extract regular snapshot files, refuse symlinks/traversal and preserve same-key
export receipts. A guest path or provider-authored link alone is never authority. Offers
have opaque host-issued file handles; there is no browser path, result lookup or library API.

The person selects one `.tex` or PDF and exact supporting file handles in one explicit grant.
Only those bytes are exported and registered; every byte must match the exact receipt and
manifest version. Dependencies from another offer are refused. The input limit is 100 files
and 8 MiB combined, including PDF inputs. Native PDF build output is limited to 50 MiB.
No wildcard mount or implicit same-folder grant exists.

A private grant is readable only in its exact owning aside. A shared context cannot read it,
and a different private context of the same person has no implicit access. **Share this report
and its selected files with the group** creates a separate auditable shared grant; it does
not rewrite the private grant or publish the private conversation. Revoking the original
also revokes its shared derivative. A copied link conveys no authority. Shared reads check
both the current reader and source owner enrollment/context; all group and immutable version
bindings must match. Remote authority failures must fail closed.

The dedicated SQLite database stores source bytes, grants, PDF/figure outputs, durable request
keys and append-only evidence. It never calls `Store.agent`, `Store.savedEntry`, the personal
`Documents` library or its filesystem browser. Normal host construction must place the database
and staging directory inside protected, ignored installation `data/`.

## Reading and builds

The scoped adapter reuses `buildReading`, its bounded include loader and sandboxed Pandoc
conversion. An owned subprocess enforces a total 30-second deadline, bounded output and figure
bytes and owned-process-group cleanup. Its private staging folder contains only exact granted
bytes. Local includes escaping that folder and symlinks to external files are refused; missing
support files cause failure or an explicit original-PDF figure note. Derived assets are keyed
by grant and immutable version; another grant cannot read them even with the same asset name.
Reading accepts at most eight queued conversions. No formatting agent is launched here.

PDF compilation requires `GroupDocumentsNative.build`: a **fresh confined native builder**
with only the exact granted inputs and compiler system assets, no network, no shell escape,
120-second execution limit and bounded PDF/log output. The existing installation-global TeX
compiler is deliberately not a fallback: its source path checks do not confine hostile TeX.
An absent builder keeps deterministic Reading available with an explicit PDF-unavailable message.
No compiled PDF is claimed ready on admission or an uncertain result.

Grant/export and build intents are recorded before dispatch. Same-key payload changes fail.
Native build keys are persisted per immutable grant, including across browser retries/restart;
uncertain replies reconcile the same native operation. Successful effects and browser receipts
commit atomically. Unknown receipts remain evidence. A previous successful immutable PDF stays
readable; a new source/dependency version requires a new offer/grant.

## Concrete runtime factory and normal integration

`createGroupDocumentsNativeRuntime` in `group-documents-native-runtime.ts` implements the
production `GroupDocumentsNative` interface with the existing GroupContainer boundary. Pass
protected `directory`, `hostJournalPath` (GroupHost native journal), `nativeJournalPath`
(GroupNativeJournal), the immutable reviewed Docker `image` ID, and
`authority: { revalidateOwner }`. Paths and image are trusted host configuration. The factory
requires both journals to exist and refuses a second live owner of its operation directory.
There is no personal Store, host compiler, browser path or simulated production fallback.

Immediately after `execution.turn(text, requestId)` records verified native completion, and
**before** the native connector's `finally { execution.close() }`, await
`documentsNative.captureCompletedRequest(requestId, execution)`. The host request already
reserves the exact result UUID. This hook checks that UUID/request/run/container, owning
normal context and actual native context against the journals and the existing admitted
`gitExportProof()`. It captures only reports named in Markdown links in the exact saved native
reply, plus recursively resolved literal dependencies. `/workspace/` is an image-defined name,
never a host path. An optional `<!-- group-document-inputs: ["extra.bib"] -->` advertises exact
additional inputs, without granting export. No file bytes leave the guest during capture.
Keep capture failure evidence without replacing the native completed text/result or replaying
tools. A completion missed before the guest closes remains unavailable; later working files
cannot be substituted for that completion.

Describe requires the exact durable owning chat projection. Export opens the same native
volume snapshot through a fresh no-outbound GroupContainer, checks every pinned digest, and
returns only the selected host-issued artifact IDs. Cache/restart reads repeat authority and
integrity checks. Private completion receipts carry exact native turn identity and no shared
publication source. Normal owning context and native context are separately immutable; neither
is an installation-global agent identity.

Build verifies exact selected exported bytes and creates a fresh guest with no retained source,
credentials, host workspace/read mounts or outbound destinations. The fixed public
`runtime/group-native/group-documents.py` runs with isolated Python (`-I -B`) so guest-written
user site packages or working-directory modules cannot intercept extraction. It stages only those bytes in temporary storage and runs
PDFTeX inside another Bubblewrap user/mount/PID/network namespace, with compiler assets bound
read-only, selected inputs read-only and a new writable output directory. It leaves `/proc` absent:
the supported Docker masked-proc layout rejects a nested proc mount with EPERM, and PDFTeX
requires no proc filesystem. It never binds the outer guest proc/root view or widens outer
capabilities. Each accepted image requires actual kernel and PDF checks, separately from
unit tests. It clears environment,
uses paranoid Kpathsea input/output policy, disables shell escape and passes a literal entry
filename. Two passes share a 110-second compiler deadline, 16 MiB log bound, 50 MiB PDF bound
and 128 output-file bound. The enclosing guest has one CPU, 768 MiB and a 120-second deadline.
Path checks alone are not the compiler confinement. No `latexmk` shell or provider turn runs.

The Dockerfile adds Debian `texlive-latex-base`, `texlive-latex-recommended` and
`texlive-fonts-recommended`, then copies the fixed helper. Its public source digest includes
that helper. Setup records the exact built image checksum/source label and verifies the real
compiler boundary before enabling it. Local checks of the reviewed recipe are described below;
a changed image needs its own matching acceptance evidence.

Operation keys/receipt IDs and exact namespace reservations are durable. Timeout or unverified
stop returns the same unknown receipt. Retry first retires every exact prior namespace, then
replays only this bounded file export or deterministic contained compilation; it never resends
provider tools. Eight namespace attempts per operation are the maximum. A live second host
cannot take over. The source owner is revalidated before/after and during guest operations.
Completed captures/operations retain their IDs and results without a lifetime request cutoff.
The 512 MiB logical envelope counts retained snapshot/cache bytes and metadata, plus worst-case
pending capture/export/PDF reservations; at most 128 unresolved captures and 128 unresolved
export/build operations may be reserved. New work fails before guest execution when capacity is unavailable.

## Normal host and reader composition

The normal document authority resolves `GroupHost.authenticatedContext({handle})` and
revalidates the exact persisted owner/context and current remote membership. Authenticated
`registerGroupDocumentsRoutes` exposes scoped metadata, source/PDF/Reading/assets and
explicit open/build/share/revoke grants. Result offers and granted links remain separate
projections; they never replace the exact original native reply.

`GroupDocumentHost` reuses the existing `PdfReader` and `DocumentReading` with a scoped
endpoint and asset base. Scoped requests never fall back to the personal document library
or its global formatting controls. `ChatMarkdown` resolves `groupDocumentReference` under
`GroupDocumentScope` before ordinary personal-document links. No second reader or generic
attachment bypass is introduced.

## Local verification, separate from acceptance

Node 24 focused checks exercise exact fabricated native-receipt exports, changed-byte/receipt
and mixed-handle denial, private/other-group/version denial, source/reader revocation, interrupted
export and build recovery, same-key concurrency across repository instances, explicit sharing,
missing build dependency, include/symlink escape, derived-asset scope and authenticated routes.
`apps/server/tsconfig.group-documents-tests.json` includes strict test types. A compiled subprocess
smoke check used the installed Pandoc and existing converter successfully; no TeX build ran.
The concrete runtime tests read realistic owning/native SQLite journals, execute the actual
public Python capture/export protocol on uncredentialed temporary fixture files, and exercise
exact run/container binding, projection mismatch, later-request denial, concurrency, cached
byte integrity, membership revocation, same-receipt restart and unverified-stop recovery.
Guest tests check safe descriptor-relative reads/writes, symlink/traversal/mixed-grant denial,
compiler namespace arguments, prelaunch build digest denial and owned timeout/output cleanup.
The builder transport in these local tests emits an explicitly fabricated PDF; it does not
claim a Linux compiler execution. A scoped service test reaches the existing real Reading
parser/Pandoc using the concrete capture/export provider. Separate actual local Engine
compiler and normal two-host PDF/Reading checks also pass. They do not establish an actual
provider-generated artifact or two installed computers. To reproduce the isolated compiler
check after exact image review/build, the setup agent can run:

```sh
pnpm --filter @dock/server exec tsx src/group-documents-native-runtime-compiler-check.ts sha256:<reviewed-image> <absolute-private-ignored-data-directory>
```

This explicit host fixture uses fresh GroupContainers and public bytes only. It produces actual
`report.pdf`, `report.tex`, `reading.json` and append-only image/namespace receipts, requires a
successful real compile with shell escape disabled, and requires explicit compiler denials for
missing and ambient inputs. Infrastructure errors are not counted as denials. It invokes the
existing Reading conversion and closes every owned container. Native policy retains its empty
home volumes; their exact names are recorded for the owning runtime's later cleanup. This
fixture is not a production result/export or the required real native artifact acceptance.

The synthetic UI fixture reuses **DocumentReading** and tests the scoped reader contract, grant
retry and draft preservation at 1440×1000, 412×915, 360×800 and 915×412 with 30px Reading text.
360/412 screenshots were inspected. This is Chromium viewport emulation, not physical phone,
real-provider, deployed-service or two-installed-computer acceptance.
Run focused checks with:

```sh
pnpm --filter @dock/shared build
pnpm --filter @dock/server exec tsc -p tsconfig.group-documents-tests.json
pnpm --filter @dock/server exec vitest run src/group-documents.test.ts src/group-documents-native-runtime.test.ts src/group-documents-native-runtime-guest.test.ts src/group-container-stop-race.test.ts
pnpm --filter @dock/web exec tsc -p tsconfig.group-documents.json
pnpm --filter @dock/web exec playwright test --config playwright.group-documents.config.ts
```

The preview binds `127.0.0.1:5199` and is a test fixture only. Its runner owns and closes the
server/browser; artifacts stay ignored under `data/group-documents-ui/`. Actual provider
artifact/consent and physical-device acceptance remain separate from source integration
and local compiler/reader checks. [Status](STATUS.md#groups) retains the current release gates.

### Explicit cross-installation publication

Open an authorized local report in the normal Groups reader, expand **Share this report**, and choose **Share selected report files with group**. This copies only the selected immutable source/assets and its current PDF into a separate shared publication; it does not share the private conversation. Another member opens **Shared reports → Load shared reports**, then chooses a report for the existing PDF/Reading reader. Listing does not download files. Share/revoke retries retain their operation identity, and revoking the original local grant revokes every shared copy created from it. Cached downloads still require current remote membership and grant authorization.

The document transport uses the existing protected group service and membership ledger. An explicit shared report publishes a separate immutable manifest with its **shared target context**, selected authored source/assets and optional PDF; private grant/native-context metadata is excluded. Listing returns metadata only. A chosen source, Reading or PDF view fetches the required files on demand, verifies chunk/file digests and rechecks the current remote grant. Membership is checked on every packet; only the publishing installation can revoke or resume a publication.

The protected host retains the publication UUID, manifest digest and original bytes across offline/lost-ack retries. A changed bundle uses a new publication UUID. Completed receipts and originals remain available without a lifetime message-count cutoff; incomplete stages retain their reservations until explicit cancellation/revocation, which releases only the unwritten reservation and keeps actual chunks/metadata. At most eight uploads may be incomplete. Actual plus reserved document storage is limited to 32 MiB, within the existing shared 64 MiB delivery allocation and unchanged 80 MiB operational SQLite ceiling. Uploads stop with a quota refusal before exceeding the fence; a larger owner-local PDF remains local. Fixed binary chunks avoid storing base64 copies. Daily document upload/read budgets are 64/128 MiB, responses are at most 512 KB and manifest pages contain at most four entries. This transport does not approve hosting entitlement, provider login, native artifact acceptance or publication of any unselected/private files.
