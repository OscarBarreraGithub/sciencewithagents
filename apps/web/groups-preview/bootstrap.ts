// Install before loading any normal chat modules. No production backend is available.
window.fetch = async () => {
  throw new Error('Backend requests are unavailable in the synthetic preview.');
};
XMLHttpRequest.prototype.open = function () {
  throw new Error('Uploads are unavailable in the synthetic preview.');
};
window.WebSocket = class {
  constructor() {
    throw new Error('Sockets are unavailable in the synthetic preview.');
  }
} as unknown as typeof WebSocket;
window.EventSource = class {
  constructor() {
    throw new Error('Live connections are unavailable in the synthetic preview.');
  }
} as unknown as typeof EventSource;
void import('./Fixture');
// Normal chat can render links. Keep even explicit navigation inside this fixture.
document.addEventListener(
  'click',
  (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || anchor.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.getElementById('groups-preview-network-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'groups-preview-network-notice';
    notice.setAttribute('role', 'alert');
    notice.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fffefa;padding:12px;border-bottom:1px solid #66856b';
    notice.textContent = 'Links are unavailable in the synthetic preview. ';
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = () => notice.remove();
    notice.append(dismiss);
    document.body.append(notice);
  },
  true,
);
