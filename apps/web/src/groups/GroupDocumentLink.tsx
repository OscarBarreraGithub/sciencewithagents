import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  groupDocumentReference,
  groupDocumentOfferSchema,
  groupDocumentLinkSchema,
  groupDocumentOfferFailureCodeSchema,
  groupDocumentOfferFailureMessages,
  groupDocumentCaptureStateSchema,
  type GroupDocumentOffer,
} from '@dock/shared/dist/group-documents.js';
import { api, apiScope, ApiError } from '../api';
import {
  groupDocumentCapacitySchema,
  type GroupDocumentCapacity,
} from '@dock/shared/dist/group-document-capacity.js';
import '../documents.css';
import './group-documents.css';

export interface GroupDocumentReaderProps {
  id: string;
  endpoint: string;
  scoped: true;
  close: () => void;
  actions?: ReactNode;
}
const Scope = createContext<string | null>(null);
const SharedTarget = createContext<string | null>(null);
const ReadOnly = createContext(false);
export const useGroupDocumentScope = () => useContext(Scope);
/** Normal GroupChat owner wraps Conversation with this scope, never with synthetic Store.agent IDs. */
export function GroupDocumentScope({
  handle,
  sharedHandle,
  readOnly = false,
  children,
}: {
  handle: string;
  sharedHandle?: string;
  readOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <Scope.Provider value={handle}>
      <SharedTarget.Provider value={sharedHandle ?? null}>
        <ReadOnly.Provider value={readOnly}>{children}</ReadOnly.Provider>
      </SharedTarget.Provider>
    </Scope.Provider>
  );
}
export function groupDocumentEndpoint(handle: string, grantId: string, version: string) {
  return `/groups/documents/${handle}/${grantId}/${version}`;
}
/** ChatMarkdown's agreed link hook calls this BEFORE ordinary DocumentLink for scoped references. */
export function GroupDocumentLink({ href, children }: { href: string; children: ReactNode }) {
  const handle = useContext(Scope),
    ref = groupDocumentReference(href);
  if (!ref) return <span>{children}</span>;
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (handle)
          window.dispatchEvent(
            new CustomEvent('dock:group-document', { detail: { handle, ...ref } }),
          );
      }}
      aria-disabled={!handle}
      title={handle ? undefined : 'Open this report from its group conversation.'}
    >
      {children}
    </a>
  );
}
/** Existing PdfReader is supplied by normal entry after its scoped endpoint hook is reviewed.
 * No installation library request, fallback or second reader is created here.
 */
export function GroupDocumentHost({
  reader: Reader,
}: {
  reader: ComponentType<GroupDocumentReaderProps>;
}) {
  const handle = useContext(Scope),
    sharedHandle = useContext(SharedTarget),
    readOnly = useContext(ReadOnly),
    [selected, setSelected] = useState<{ grantId: string; version: string; shared?: true } | null>(
      null,
    );
  useEffect(() => {
    setSelected(null);
    const open = (event: Event) => {
      const raw = (event as CustomEvent).detail;
      const parsed = groupDocumentReference(
        `#/groups/${raw?.shared ? 'report' : 'document'}/${raw?.grantId}/${raw?.version}`,
      );
      if (handle && parsed && raw?.handle === handle) setSelected(parsed);
    };
    window.addEventListener('dock:group-document', open);
    return () => window.removeEventListener('dock:group-document', open);
  }, [handle, sharedHandle]);
  if (!handle || !selected) return null;
  return (
    <Reader
      key={`${handle}:${selected.grantId}:${selected.version}`}
      id={selected.grantId}
      endpoint={
        selected.shared
          ? `/groups/reports/${sharedHandle ?? handle}/${selected.grantId}/${selected.version}`
          : groupDocumentEndpoint(handle, selected.grantId, selected.version)
      }
      actions={
        !selected.shared && sharedHandle ? (
          <GroupReportPublish
            key={`${handle}:${selected.grantId}:${selected.version}:${sharedHandle}`}
            handle={handle}
            sharedHandle={sharedHandle}
            grantId={selected.grantId}
            version={selected.version}
            readOnly={readOnly}
          />
        ) : undefined
      }
      scoped
      close={() => setSelected(null)}
    />
  );
}
/** The host projects this OFFER only into its exact native result's owning conversation.
 * One explicit selection grants only the main report and checked exact dependencies.
 */
export function GroupDocumentGrant({
  offer: raw,
  onGranted,
}: {
  offer: GroupDocumentOffer;
  onGranted: (link: {
    grantId: string;
    version: string;
    href: string;
    visibility: 'shared' | 'private';
  }) => void;
}) {
  const handle = useContext(Scope),
    offer = groupDocumentOfferSchema.parse(raw);
  const [entry, setEntry] = useState(
      offer.files.find((f) => f.kind !== 'dependency')?.handle ?? '',
    ),
    [dependencies, setDependencies] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<{ key: string; payload: string } | null>(null);
  const submit = async () => {
    if (!handle || !entry || busy) return;
    setBusy(true);
    setError('');
    try {
      onGranted(
        groupDocumentLinkSchema.parse(
          await api(
            `/groups/documents/${handle}/grants`,
            (() => {
              const payload = JSON.stringify({
                offer: offer.handle,
                entry,
                dependencies: [...dependencies].sort(),
              });
              if (request.current?.payload !== payload)
                request.current = { key: crypto.randomUUID(), payload };
              return { key: request.current.key, ...JSON.parse(payload) };
            })(),
          ),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset disabled={!handle || busy} className="group-document-grant">
      <legend>Open a report from this reply</legend>
      <label>
        Report
        <select
          value={entry}
          onChange={(e) => {
            setEntry(e.target.value);
            setDependencies([]);
          }}
        >
          {offer.files
            .filter((f) => f.kind !== 'dependency')
            .map((f) => (
              <option key={f.handle} value={f.handle}>
                {f.name}
              </option>
            ))}
        </select>
      </label>
      <p>
        Allow the selected report and only the supporting files you check. A private report stays in
        this aside.
      </p>
      {offer.files.some((file) => file.kind === 'tex') &&
        !offer.files.some((file) => file.kind === 'pdf') && (
          <p>
            Need a PDF? Ask My group agent with Work to create it in the group workspace and link
            both the PDF and matching LaTeX source in its final reply. Open that new reply, select
            the PDF and check its source and supporting files. Reading can open this source now.
          </p>
        )}
      {offer.files
        .filter((f) => f.handle !== entry)
        .map((f) => (
          <label key={f.handle}>
            <input
              type="checkbox"
              checked={dependencies.includes(f.handle)}
              onChange={(e) =>
                setDependencies((v) =>
                  e.target.checked ? [...v, f.handle] : v.filter((id) => id !== f.handle),
                )
              }
            />
            {f.name} ({f.bytes} bytes)
          </label>
        ))}
      <button type="button" disabled={!entry} onClick={() => void submit()}>
        {busy ? 'Opening report…' : 'Allow selected files and open'}
      </button>
      {error && <p role="alert">{error} Retry uses the same request.</p>}
    </fieldset>
  );
}

/** Explicit auditable private-to-shared transition; copying a link alone grants nothing. */
export function GroupDocumentShare({
  grantId,
  version,
  sharedHandle,
  onShared,
}: {
  grantId: string;
  version: string;
  sharedHandle: string;
  onShared: (href: string) => void;
}) {
  const handle = useContext(Scope),
    [key] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div>
      <button
        type="button"
        disabled={!handle || busy}
        onClick={() => {
          if (!handle) return;
          setBusy(true);
          setError('');
          void api(`${groupDocumentEndpoint(handle, grantId, version)}/share`, {
            key,
            sharedHandle,
          })
            .then(groupDocumentLinkSchema.parse)
            .then((link) => onShared(link.href))
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        Share this report and its selected files with the group
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Loads only this exact saved reply on demand; ordinary chat polling never resolves report exports. */
export function GroupDocumentCaptureNotice({ state }: { state: 'pending' | 'unavailable' }) {
  return (
    <p role="status">
      {
        groupDocumentOfferFailureMessages[
          groupDocumentCaptureStateSchema.parse(state) === 'pending'
            ? 'GROUP_DOCUMENT_CAPTURE_PENDING'
            : 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE'
        ]
      }
    </p>
  );
}

export function GroupDocumentOfferButton({
  handle,
  requestKey,
  request,
}: {
  handle: string;
  requestKey: string;
  request: (path: string, body: unknown) => Promise<unknown>;
}) {
  const [offer, setOffer] = useState<GroupDocumentOffer | null>(null),
    [busy, setBusy] = useState(false),
    [unavailable, setUnavailable] = useState(false),
    [error, setError] = useState('');
  if (offer)
    return (
      <GroupDocumentGrant
        offer={offer}
        onGranted={(link) =>
          window.dispatchEvent(
            new CustomEvent('dock:group-document', { detail: { handle, ...link } }),
          )
        }
      />
    );
  return (
    <div>
      <button
        disabled={busy || unavailable}
        onClick={() => {
          setBusy(true);
          setError('');
          void request('document-offer', { handle, key: requestKey })
            .then(groupDocumentOfferSchema.parse)
            .then(setOffer)
            .catch((error: unknown) => {
              const code = groupDocumentOfferFailureCodeSchema.safeParse(
                error instanceof ApiError ? error.code : undefined,
              );
              setUnavailable(code.success && code.data === 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE');
              setError(
                groupDocumentOfferFailureMessages[
                  code.success ? code.data : 'GROUP_DOCUMENT_OFFER_RETRY'
                ],
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Loading report…' : 'Open report from this reply'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function GroupReportPublish({
  handle,
  sharedHandle,
  grantId,
  version,
  readOnly,
}: {
  handle: string;
  sharedHandle: string;
  grantId: string;
  version: string;
  readOnly: boolean;
}) {
  const storage = `swa:group-report-share:${apiScope()}:${handle}:${grantId}:${version}:${sharedHandle}`;
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [href, setHref] = useState(''),
    [capacity, setCapacity] = useState<GroupDocumentCapacity | null>(null),
    [capacityError, setCapacityError] = useState(''),
    [checking, setChecking] = useState(false),
    [saved, setSaved] = useState(() => {
      try {
        return !!sessionStorage.getItem(storage);
      } catch {
        return false;
      }
    });
  const inFlight = useRef(false),
    capacityRead = useRef(false),
    currentReadOnly = useRef(readOnly);
  currentReadOnly.current = readOnly;
  const preflight = async () => {
    if (capacityRead.current) return null;
    capacityRead.current = true;
    setChecking(true);
    setCapacityError('');
    try {
      const result = groupDocumentCapacitySchema.parse(
        await api(`${groupDocumentEndpoint(handle, grantId, version)}/preflight`, { sharedHandle }),
      );
      setCapacity(result);
      return result;
    } catch (error) {
      setCapacity(null);
      setCapacityError(
        error instanceof ApiError && error.code === 'GROUP_REPORT_HOSTING_UPDATE'
          ? 'The group creator needs to update the hosted Groups service before sharing a new report. This storage check does not upload files.'
          : 'Hosted report storage could not be checked. Recheck when connected. This storage check does not upload files.',
      );
      return null;
    } finally {
      capacityRead.current = false;
      setChecking(false);
    }
  };
  const publish = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    let retained = false;
    try {
      let key = sessionStorage.getItem(storage);
      retained = !!key;
      if (!key) {
        if (currentReadOnly.current) {
          setNotice('Choose Contribute in Groups before sharing a new report.');
          return;
        }
        const latest = await preflight();
        if (!latest?.fits || currentReadOnly.current) return;
        key = crypto.randomUUID();
        sessionStorage.setItem(storage, key);
        retained = true;
        setSaved(true);
      }
      // A saved key must reconcile even if today's advisory is full, unavailable
      // or Read-only. Only the server's exact prior lookup can settle that share.
      const link = groupDocumentLinkSchema.parse(
        await api(`${groupDocumentEndpoint(handle, grantId, version)}/publish`, {
          key,
          sharedHandle,
        }),
      );
      sessionStorage.removeItem(storage);
      setSaved(false);
      setHref(link.href);
      setNotice(
        'Shared the selected report and supporting files. Members can open its notification in Group chat; Advanced also keeps the report list.',
      );
    } catch (error) {
      setNotice(
        `${error instanceof Error ? error.message : 'The share could not be confirmed.'} ${retained ? 'Retry uses the same saved publication.' : 'No new report was uploaded.'}`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <details
      className="group-report-publish"
      onToggle={(event) => {
        if (event.currentTarget.open && !inFlight.current) void preflight();
      }}
    >
      <summary>Share this report</summary>
      <p>
        This stores only the selected report and supporting files as a hosted group attachment. Your
        private conversation stays private. Project files and private Git are separate.
      </p>
      {capacity && (
        <div role="status">
          <p>
            This selected report and its supporting files require{' '}
            {reportBytes(capacity.logical.requiredBytes)} of hosted report storage.{' '}
            {reportBytes(Math.max(0, capacity.logical.limitBytes - capacity.logical.usedBytes))}{' '}
            remains of {reportBytes(capacity.logical.limitBytes)}.
          </p>
          <p>
            {capacity.reason === 'available'
              ? 'There is room now. Sharing checks current limits again.'
              : capacity.reason === 'logical-limit'
                ? 'Hosted report storage cannot fit this new attachment. Existing copies stay available; your separate project files and Git can continue.'
                : capacity.reason === 'physical-limit'
                  ? 'The hosted Groups service cannot fit this attachment alongside its retained data and reservations. Existing copies and separate Git files are preserved.'
                  : 'All pending report upload slots are occupied. Reconcile the existing uploads before starting another; existing copies and separate Git files are preserved.'}
          </p>
        </div>
      )}
      {checking && <p role="status">Checking hosted report storage…</p>}
      {capacityError && <p role="alert">{capacityError}</p>}
      {saved && (
        <p>
          A saved share is not yet confirmed here. Retry checks that exact publication, even if new
          attachments are currently refused. Nothing is automatically resent.
        </p>
      )}
      {readOnly && !saved && (
        <p>
          This group is Read-only. Choose Contribute in Groups to share a new report; reading and
          separate Git sync remain available.
        </p>
      )}
      <button disabled={busy || checking} onClick={() => void preflight()}>
        Recheck hosted storage
      </button>
      <button
        disabled={busy || (!saved && (checking || readOnly || !capacity?.fits))}
        onClick={() => void publish()}
      >
        {busy
          ? 'Sharing report…'
          : saved
            ? 'Retry saved report share'
            : 'Share selected report files with group'}
      </button>
      {notice && <p role="status">{notice}</p>}
      {href && (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            const ref = groupDocumentReference(href);
            if (ref)
              window.dispatchEvent(
                new CustomEvent('dock:group-document', { detail: { handle, ...ref } }),
              );
          }}
        >
          Open shared report copy
        </a>
      )}
    </details>
  );
}

function reportBytes(bytes: number) {
  const unit = bytes >= 1024 ** 2 ? 1024 ** 2 : bytes >= 1024 ? 1024 : 1;
  return `${(bytes / unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit === 1024 ** 2 ? 'MiB' : unit === 1024 ? 'KiB' : 'bytes'}`;
}
