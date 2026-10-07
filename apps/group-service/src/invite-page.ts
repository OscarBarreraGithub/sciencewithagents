// This document is identical for every invitation. Only browser memory and the
// readonly field hold the fragment; it never enters a request, storage or markup.
const script = String.raw`
(() => {
  'use strict';
  const field = document.getElementById('invitation');
  const copy = document.getElementById('copy');
  const available = document.getElementById('available');
  const notice = document.getElementById('notice');
  let invitation = '';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const secret = /^[a-f0-9]{64}$/;
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
  function validService(value, origin) {
    if (!record(value) || !keys(value, ['version', 'mode', 'endpoint', 'endpointId', 'hostingAuthorization']) ||
        value.version !== 1 || value.mode !== 'hosted' || !uuid.test(value.endpointId) ||
        typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return false;
    const endpoint = new URL(value.endpoint);
    const auth = value.hostingAuthorization;
    return endpoint.protocol === 'https:' && endpoint.origin === origin && endpoint.pathname === '/' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      record(auth) && keys(auth, ['origin', 'approvalCapability', 'freeApprovalId']) &&
      auth.origin === origin && secret.test(auth.approvalCapability) && uuid.test(auth.freeApprovalId);
  }
  function capture() {
    const url = new URL(location.href);
    const original = url.href;
    const fragment = url.hash;
    url.hash = '';
    // Scrub before parsing, including malformed fragments. No reload or request.
    if (fragment) history.replaceState(history.state, '', url.href);
    invitation = '';
    field.value = '';
    available.hidden = true;
    copy.textContent = 'Copy invitation';
    notice.textContent = fragment
      ? 'This invitation is incomplete or malformed. Ask the inviter to send a fresh, complete link privately.'
      : 'No invitation is attached. Open the complete link sent privately by your inviter, or ask for a fresh invitation.';
    try {
      if (original.length > 4096 || url.search || !fragment.startsWith('#/groups?')) return;
      const params = new URLSearchParams(fragment.slice('#/groups?'.length));
      if ([...params.keys()].length !== 1 || !params.has('invite')) return;
      const value = JSON.parse(params.get('invite'));
      if (!record(value) || !keys(value, ['groupId', 'secret', 'name', 'serviceId', 'admission', 'service']) ||
          !uuid.test(value.groupId) || !secret.test(value.secret) ||
          typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 120 ||
          (value.serviceId !== undefined && !uuid.test(value.serviceId)) ||
          (value.admission !== undefined && (typeof value.admission !== 'string' || !value.admission.length || value.admission.length > 1024)) ||
          (value.service !== undefined && !validService(value.service, url.origin))) return;
      invitation = original;
      field.value = invitation;
      available.hidden = false;
      notice.textContent = 'Invitation ready. Copy it and continue in your own sciencewithagents app.';
    } catch {
      // Never include URL data or parser errors in the document or logs.
    }
  }
  copy.addEventListener('click', async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation);
      copy.textContent = 'Invitation copied';
      notice.textContent = 'Copied. Open your own app, then Groups → Join by invitation, and paste it there.';
    } catch {
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      notice.textContent = 'Copy did not work. The invitation is selected below; copy it by hand, then paste it into your own app.';
    }
  });
  window.addEventListener('hashchange', capture);
  capture();
})();
`;

const styles = `
:root { color-scheme: light dark; font: 17px/1.55 system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f5f7fb; color: #19243a; }
main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
.brand { margin: 0 0 1.5rem; font-weight: 650; color: #435578; }
h1 { font-size: clamp(1.8rem, 7vw, 2.5rem); line-height: 1.15; margin: 0 0 1rem; }
h2 { font-size: 1.15rem; margin-top: 1.8rem; }
p, ol { margin: 1rem 0; }
ol { padding-left: 1.4rem; }
li { padding: .25rem 0 .25rem .2rem; }
a { color: #224bb6; text-underline-offset: .2em; }
button { border: 0; border-radius: .65rem; padding: .8rem 1.1rem; background: #224bb6; color: white; font: inherit; font-weight: 650; cursor: pointer; }
button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 3px solid #b47500; outline-offset: 4px; }
label { display: block; margin: 1rem 0 .4rem; font-weight: 650; }
textarea { display: block; width: 100%; min-height: 7rem; padding: .7rem; border: 1px solid #8794aa; border-radius: .5rem; background: white; color: inherit; font: .85rem/1.5 ui-monospace, monospace; overflow-wrap: anywhere; resize: vertical; }
.privacy { font-size: .9rem; color: #435578; }
[hidden] { display: none !important; }
@media (prefers-color-scheme: dark) {
  body { background: #101724; color: #edf1fa; }
  .brand, .privacy { color: #b8c6df; }
  a { color: #a9c3ff; }
  button { background: #aac5ff; color: #122447; }
  textarea { background: #182338; border-color: #8294b1; }
}
@media (max-height: 500px) { main { padding-top: 1.25rem; } }
`;

// Hashes cover the exact inline strings above; the boundary test verifies them.
const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'sha256-oed7lAb6sQDfmsa+KOrOskq9ttCotVvhfm4tzLNoti0='; style-src 'sha256-phYc+xsi83jVfN3LwX9BL2T2mo2H1A1J+xMJIFSrgtc='; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <link rel="icon" href="data:,">
  <title>Join a group · sciencewithagents</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <p class="brand">sciencewithagents · Groups</p>
    <h1>You’re invited to a group</h1>
    <p>Join from the sciencewithagents app on your own computer, using your own Codex or Claude account.</p>
    <p id="notice" role="status" aria-live="polite">Checking the invitation…</p>
    <div id="available" hidden>
      <button id="copy" type="button">Copy invitation</button>
      <label for="invitation">Your private invitation</label>
      <textarea id="invitation" readonly autocomplete="off" spellcheck="false" aria-describedby="privacy"></textarea>
    </div>
    <h2>Already have the app?</h2>
    <ol>
      <li>Copy the complete invitation above.</li>
      <li>Open your own sciencewithagents app and choose <strong>Groups → Join by invitation</strong>.</li>
      <li>Paste the invitation and enter your name. If service setup is needed, give your setup agent the invitation.</li>
      <li>Your group opens when the invitation is accepted. The same link can invite other people before it expires.</li>
    </ol>
    <h2>New to sciencewithagents?</h2>
    <p>Open the <a href="https://github.com/OscarBarreraGithub/sciencewithagents#groups-beta" rel="noreferrer noopener" target="_blank">Groups setup instructions</a>, copy the “Join a group” setup prompt, and give it with this invitation to your own setup agent. Each member installs their own app; the inviter hosts the shared service.</p>
    <p id="privacy" class="privacy">Keep the invitation private. This page does not submit it or join the group. A refresh removes the captured invitation; reopen the original link if needed. Ask the inviter for a fresh link if it has expired.</p>
    <noscript><p>JavaScript is needed to copy the invitation here. Copy the complete link you received and paste it into your own app under Groups → Join by invitation, or give it privately to your setup agent.</p></noscript>
  </main>
  <script>${script}</script>
</body>
</html>`;

export function invitationPage(head = false): Response {
  return new Response(head ? null : html, { headers: pageHeaders });
}
