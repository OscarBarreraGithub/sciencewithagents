// Every address the site points at, in one place. The HTML carries the same
// addresses as a fallback, so links still work without JavaScript.
const repo = 'https://github.com/OscarBarreraGithub/sciencewithagents';
window.SCIENCEWITHAGENTS_LINKS = {
  // The public repository. Forks can point this to their own repository.
  github: repo,
  features: `${repo}/blob/main/docs/FEATURES.md`,
  machines: `${repo}/blob/main/docs/CONTRIBUTOR_SETUP.md#check-the-machine-first`,
};
const links = window.SCIENCEWITHAGENTS_LINKS;
document.querySelectorAll('[data-link]').forEach((el) => {
  const href = links[el.dataset.link];
  if (href) el.setAttribute('href', href);
});

// The setup prompt follows the repository README and is generated from the
// GitHub address so the two never drift apart.
const prompt = `Set up sciencewithagents on this computer from ${links.github}, following docs/CONTRIBUTOR_SETUP.md. First check for an existing installation and preserve it. For a new install, use a local folder outside iCloud or other cloud sync. Check platform support and prerequisites, and use my own Codex or Claude account; I do not need both. Install the Applications launcher on Mac, open Welcome, verify my models and help me create my first project. Let me choose its manager separately from worker defaults and review the saved project brief before sending. Keep phone access, VS Code sharing and private GitHub backup optional. Handle the technical setup; tell me which sign-in, device or preference steps need me and how to open the app next time. Do not run the full developer test suite for ordinary setup or claim completion while a required step is failing.`;
document.querySelectorAll('[data-prompt]').forEach((el) => (el.textContent = prompt));

const selectPrompt = () => {
  const el = document.querySelector('[data-prompt]');
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};
document.querySelectorAll('[data-copy-prompt]').forEach((button) => {
  const label = button.textContent.trim();
  const status = document.querySelector('[data-copy-status]');
  let timer;
  button.addEventListener('click', async () => {
    let message;
    try {
      await navigator.clipboard.writeText(prompt);
      button.textContent = 'Copied';
      message = 'Setup prompt copied.';
    } catch {
      selectPrompt();
      button.textContent = 'Select and copy the text';
      message = 'Copying was blocked. The prompt is selected; copy it yourself.';
    }
    if (status) status.textContent = message;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = label;
      if (status) status.textContent = '';
    }, 2200);
  });
});

// A fixed window with an explicit scrolling reading panel, as on Sketchcoded.
(() => {
  const panel = document.querySelector('.site-scroll');
  const hint = document.querySelector('.site-scroll-hint');
  if (!panel || !hint) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => {
    hint.hidden = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 3;
  };
  panel.addEventListener('scroll', update, { passive: true });
  hint.addEventListener('click', () =>
    panel.scrollBy({
      top: panel.clientHeight * 0.7,
      behavior: reduced.matches ? 'auto' : 'smooth',
    }),
  );
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    for (const child of panel.children) observer.observe(child);
  } else {
    window.addEventListener('resize', update);
  }
  update();
})();

// In-page links move focus with the view, so keyboard and screen reader users
// continue from the section they chose.
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = document.getElementById(link.getAttribute('href').slice(1));
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => target.focus({ preventScroll: true }));
  });
});
