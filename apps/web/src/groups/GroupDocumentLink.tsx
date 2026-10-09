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
export const useGroupDocumentScope = () => useContext(Scope);
/** Normal GroupChat owner wraps Conversation with this scope, never with synthetic Store.agent IDs. */
export function GroupDocumentScope({
  handle,
  sharedHandle,
  children,
}: {
  handle: string;
  sharedHandle?: string;
  children: ReactNode;
}) {
  return (
    <Scope.Provider value={handle}>
      <SharedTarget.Provider value={sharedHandle ?? null}>{children}</SharedTarget.Provider>
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
            handle={handle}
            sharedHandle={sharedHandle}
            grantId={selected.grantId}
            version={selected.version}
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
            Need a PDF? Ask your Group manager with Work to create it in the group workspace and
            link both the PDF and matching LaTeX source in its final reply. Open that new reply,
            select the PDF and check its source and supporting files. Reading can open this source
            now.
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
}: {
  handle: string;
  sharedHandle: string;
  grantId: string;
  version: string;
}) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [href, setHref] = useState('');
  const publish = async () => {
    setBusy(true);
    setNotice('');
    try {
      const storage = `swa:group-report-share:${apiScope()}:${handle}:${grantId}:${version}:${sharedHandle}`;
      let key = sessionStorage.getItem(storage);
      if (!key) {
        key = crypto.randomUUID();
        sessionStorage.setItem(storage, key);
      }
      const link = groupDocumentLinkSchema.parse(
        await api(`${groupDocumentEndpoint(handle, grantId, version)}/publish`, {
          key,
          sharedHandle,
        }),
      );
      sessionStorage.removeItem(storage);
      setHref(link.href);
      setNotice(
        'Shared the selected immutable report and supporting files. Other members can open it under Shared reports.',
      );
    } catch (error) {
      setNotice(`${(error as Error).message} Retry uses the same saved publication.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>Share this report</summary>
      <p>
        This publishes only this report and its selected supporting files to the group. Your private
        conversation stays private.
      </p>
      <button disabled={busy} onClick={() => void publish()}>
        {busy ? 'Sharing report…' : 'Share selected report files with group'}
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
