import type { McpUrlRequest } from '@dock/shared';

export function McpUrlLink({ request }: { request: McpUrlRequest }) {
  const destination = new URL(request.url);
  return (
    <div className="mcp-url-request">
      <p>
        Requested by <strong>{request.serverName}</strong>
      </p>
      <p>
        Destination: <code>{destination.origin}</code>
      </p>
      {destination.protocol === 'http:' && (
        <p>This is a local address on the device opening it, not a hosted phone link.</p>
      )}
      <details>
        <summary>Inspect the full URL</summary>
        <code>{request.url}</code>
      </details>
      <a
        className="secondary"
        href={request.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        Open requested page <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
