import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GroupDocumentScope,
  GroupDocumentLink,
  GroupDocumentHost,
  GroupDocumentGrant,
  type GroupDocumentReaderProps,
} from '../src/groups/GroupDocumentLink';
import { DocumentReading } from '../src/DocumentReading';
import '../src/documents.css';
const handle = 'd5ced7dc-df8d-4e94-82b1-a4f97218cd9c',
  grantId = 'eeeb5ab8-e0c3-413b-b763-21f96af596d4',
  version = 'a'.repeat(64);
const offer = {
  handle: '83ed5c4e-3399-42e9-a7f3-4235881f6930',
  resultId: '7b4e9f42-fb72-45e1-a2d8-0d72c625c3ab',
  version,
  files: [
    {
      handle: '2b72a779-c5b6-4cda-b6a4-3924d8dd2aeb',
      name: 'reports/Measured-report.tex',
      bytes: 160,
      kind: 'tex' as const,
    },
    {
      handle: 'f1c914de-394b-40fb-ad8d-9cdcd7d1513a',
      name: 'reports/supporting-chapter-with-a-long-descriptive-name.tex',
      bytes: 40,
      kind: 'dependency' as const,
    },
  ],
};
/** Only the contract fixture, not a second product reader or native/PDF acceptance. */
function ReadingFixture({ id, endpoint, close }: GroupDocumentReaderProps) {
  const ref = useRef<HTMLDialogElement>(null),
    [size, setSize] = useState(20);
  useEffect(() => {
    ref.current!.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      className="pdf-reader"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header className="pdf-heading">
        <button onClick={close}>Back</button>
        <strong>Scoped report fixture</strong>
      </header>
      <div className="pdf-toolbar">
        <button onClick={() => setSize(30)}>Larger text</button>
      </div>
      <small data-testid="endpoint" style={{ overflowWrap: 'anywhere' }}>
        {endpoint}
      </small>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <DocumentReading
          id={id}
          size={size}
          close={close}
          reading={{
            available: true,
            html: '<h1>A native report fixture</h1><p>Reading keeps text readable on this phone. Its authorization and native export are tested separately.</p><span class="math display">\\begin{equation}\\begin{aligned}E &amp;= mc^2 \\\\ p &amp;= mv\\end{aligned}\\end{equation}</span>',
            warnings: [],
            labels: {},
          }}
        />
      </div>
    </dialog>
  );
}
function App() {
  const [href, setHref] = useState(`#/groups/document/${grantId}/${version}`);
  return (
    <main style={{ maxWidth: 700, margin: 'auto', padding: 12 }}>
      <h1>Scoped document UI fixture</h1>
      <GroupDocumentScope handle={handle}>
        <GroupDocumentGrant offer={offer} onGranted={(link) => setHref(link.href)} />
        <p>
          <GroupDocumentLink href={href}>Open my report</GroupDocumentLink>
        </p>
        <textarea aria-label="Draft" defaultValue="Keep this draft" style={{ width: '100%' }} />
        <GroupDocumentHost reader={ReadingFixture} />
      </GroupDocumentScope>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
