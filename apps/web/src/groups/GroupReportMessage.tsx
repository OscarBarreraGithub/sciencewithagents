import type { GroupReportNotification } from '@dock/shared/dist/group-report-notification.js';
import { useGroupDocumentScope } from './GroupDocumentLink';
import './group-documents.css';

export function GroupReportMessage({
  notification,
  original,
}: {
  notification: GroupReportNotification;
  original: string;
}) {
  const handle = useGroupDocumentScope();
  return (
    <div className="group-report-message">
      <p>
        <strong>{notification.title}</strong>
      </p>
      <button
        type="button"
        className="secondary"
        disabled={!handle}
        onClick={() => {
          if (handle)
            window.dispatchEvent(
              new CustomEvent('dock:group-document', {
                detail: {
                  handle,
                  grantId: notification.publication.publicationId,
                  version: notification.publication.manifestHash,
                  shared: true,
                },
              }),
            );
        }}
      >
        Open report
      </button>
      <details>
        <summary>Original notification</summary>
        <pre>{original}</pre>
      </details>
    </div>
  );
}
