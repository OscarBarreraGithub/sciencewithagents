/** Gateway-owned bootstrap only; the native Jupyter page and scripts are unchanged. */
export const notebookLaunchScript = String.raw`
const message = document.getElementById('message');
const retry = document.getElementById('retry');
const secret = location.hash.slice(1);
history.replaceState(null, '', '/launch');
let notebookPath;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function failed(text, canRetry = false) {
  message.textContent = text;
  retry.hidden = !canRetry;
}
async function startNotebook() {
  retry.hidden = true;
  message.textContent = 'Waiting for notebook to start…';
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(15000, deadline - Date.now()));
    let status;
    try {
      const response = await fetch(notebookPath.slice(0, -3) + 'api/status', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      status = response.status;
    } catch { status = 502; }
    finally { clearTimeout(timeout); }
    if (status === 200) { location.replace(notebookPath); return; }
    if (status === 401 || status === 403) {
      failed('This notebook connection closed or expired. Return to sciencewithagents and open it again.');
      return;
    }
    if (status !== 502 && status !== 503) {
      failed('The notebook could not start. Return to sciencewithagents to check the job.', true);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await wait(Math.min(2000, remaining));
  }
  failed('The notebook has not started after 90 seconds. Check the job in sciencewithagents, or retry startup.', true);
}
retry.onclick = () => { void startNotebook(); };
const claimController = new AbortController();
const claimTimeout = setTimeout(() => claimController.abort(), 15000);
fetch('/_gateway/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({secret}),
  signal: claimController.signal,
}).then(async response => {
  const value = await response.json();
  clearTimeout(claimTimeout);
  if (!response.ok || !/^\/notebooks\/\d{1,20}\/lab$/.test(value.path)) throw Error();
  notebookPath = value.path;
  return startNotebook();
}).catch(() => failed('This link expired or the notebook connection failed. Return to sciencewithagents and open it again.'))
  .finally(() => clearTimeout(claimTimeout));
`;
export const notebookLaunchPage = (nonce: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open notebook</title><p id="message" role="status" aria-live="polite">Opening notebook…</p><button id="retry" type="button" hidden>Retry notebook startup</button><script nonce="${nonce}">${notebookLaunchScript}</script>`;
