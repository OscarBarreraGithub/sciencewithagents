// Consume before navigation/history hooks mount. No secret is placed in query/path,
// browser storage or a host URL; only an authenticated JSON request ingests it.
let invitation: string | null = null;
let revision = 0;
const scrubbedRoute = (value: string) => {
  const url = new URL(value, location.href);
  if (url.hash.startsWith('#/groups?invite=')) url.hash = '#/groups';
  return url.href;
};
if (scrubbedRoute(location.href) !== location.href) {
  invitation = location.href;
  revision++;
  history.replaceState(history.state, '', scrubbedRoute(location.href));
}
// Scanned/opened links can reuse this document. Capture before navigation hooks:
// they must receive sanitized event URLs as well as the scrubbed location.
window.addEventListener(
  'hashchange',
  (event) => {
    const oldURL = scrubbedRoute(event.oldURL),
      newURL = scrubbedRoute(event.newURL);
    if (oldURL === event.oldURL && newURL === event.newURL) return;
    event.stopImmediatePropagation();
    if (newURL !== event.newURL) {
      invitation = event.newURL;
      revision++;
    }
    const current = scrubbedRoute(location.href);
    if (current !== location.href) history.replaceState(history.state, '', current);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
  },
  true,
);
export const initialGroupInvitation = () => invitation;
export const groupInvitationRevision = () => revision;
export const clearGroupInvitation = () => {
  invitation = null;
};

/** A hosted invitation belongs to the shared service, never the creator's private app URL. */
export function groupInvitationUrl(fragment: string, localOrigin: string) {
  const encoded = new URLSearchParams(fragment.replace(/^\/?groups\?/, '')).get('invite');
  const payload = JSON.parse(encoded ?? 'null') as {
    service?: { endpoint?: string; mode?: string };
  } | null;
  if (payload?.service) {
    const endpoint = new URL(payload.service.endpoint ?? '');
    if (
      payload.service.mode !== 'hosted' ||
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        'The invitation service address is invalid. Ask your setup agent to check Groups.',
      );
    return `${endpoint.origin}/join#${fragment}`;
  }
  // Retain legacy beta and local fixture envelopes; joining still parses only the fragment.
  return `${localOrigin}/#${fragment}`;
}
