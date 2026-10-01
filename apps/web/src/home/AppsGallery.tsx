import { BackLink } from './Navigation';
import { useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import './apps-gallery.css';

// Setup prompts are copied, never executed here. Each step is needed only by the
// app or connection route that uses it, not by ordinary local chats.
const setupSteps = [
  {
    id: 'github',
    title: 'GitHub account and gh sign-in',
    detail:
      'Needed for apps whose code is backed up or published through GitHub. Create a GitHub account first if you do not have one.',
    label: 'Prompt for your setup agent',
    prompt:
      'Set up GitHub sign-in on this computer. Check the installed GitHub CLI and existing account first. If gh is missing, install it using the official method for this operating system; handle the technical steps yourself. Preserve a working sign-in. Otherwise open the native browser sign-in and tell me when I need to complete it. Never ask me to paste credentials into chat. This step does not create repositories or upload files. Finish by checking the connected account and explaining any step that still needs me.',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare account and Wrangler sign-in',
    detail:
      'Needed for apps hosted on Cloudflare and for the Cloudflare phone connection. Create a Cloudflare account first if you do not have one.',
    label: 'Prompt for your setup agent',
    prompt:
      'Set up Cloudflare sign-in on this computer using the official Wrangler CLI. Check for an existing installation and working account first, and preserve them. Handle any required CLI setup yourself, then open the native browser sign-in only if needed and tell me when I need to complete it. Never ask me to paste credentials into chat. This step does not create, change or deploy a project, domain, tunnel or DNS record. Finish by checking the connected account. For sciencewithagents phone access, continue through docs/CLOUDFLARE_SETUP.md only if I choose that route; local use and the no-domain phone option do not require Cloudflare.',
  },
] as const;

function PromptCard({ label, prompt }: { label: string; prompt: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = useRef<HTMLPreElement>(null);
  const timer = useRef(0);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(prompt);
      setState('copied');
      timer.current = window.setTimeout(() => setState('idle'), 2500);
    } catch {
      // Leave the text selected so it can still be copied by hand.
      const range = document.createRange();
      if (text.current) range.selectNodeContents(text.current);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      setState('failed');
    }
  };
  return (
    <div className="setup-prompt">
      <div className="setup-prompt-head">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()}>
          {state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={text} tabIndex={0}>
        {prompt}
      </pre>
      <p className="setup-prompt-status" role="status">
        {state === 'failed'
          ? 'Copy did not work in this browser. The prompt is selected; copy it by hand.'
          : ''}
      </p>
    </div>
  );
}

/** One numbered copy-prompt guide, shared by Apps and Help. */
export function SetupGuide({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="setup-guide">
      <p className="setup-guide-note">
        Paste a prompt into a Codex or Claude chat on this computer. Copying does not run it. Skip a
        step when the account is already signed in. This guide does not check GitHub or Cloudflare
        for you; your agent’s answer is the result.
      </p>
      <ol>
        {setupSteps.map((step, index) => (
          <li key={step.id}>
            <Heading>
              <span className="setup-step-number">{index + 1}</span>
              {step.title}
            </Heading>
            <p>{step.detail}</p>
            <PromptCard label={step.label} prompt={step.prompt} />
          </li>
        ))}
        <li>
          <Heading>
            <span className="setup-step-number">{setupSteps.length + 1}</span>
            Phone access, if you want to open it on your phone
          </Heading>
          <p>Phone access has its own setup and pairing. Existing pairing and devices are kept.</p>
          <a className="setup-link" href="#/phone">
            Open phone access <ArrowUpRight size={16} />
          </a>
        </li>
      </ol>
    </div>
  );
}

export function AppsGallery() {
  return (
    <section className="apps-page" aria-labelledby="apps-heading">
      <BackLink />
      <header className="apps-heading">
        <p className="home-eyebrow">APPS</p>
        <h1 id="apps-heading" tabIndex={-1}>
          Apps
        </h1>
        <p>
          Apps built in your projects open from here. Provider tools and plugins are separate;
          manage them in <a href="#/advanced">Advanced controls</a>.
        </p>
      </header>
      <div className="apps-empty">
        <div className="apps-empty-grid" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h2>No apps yet</h2>
        <p>
          No apps have been added to this workspace. When a project adds an app, its icon and title
          appear here.
        </p>
      </div>
      <section className="apps-setup" aria-labelledby="apps-setup-heading">
        <h2 id="apps-setup-heading">Setup for apps that publish online</h2>
        <p>
          Only apps that use GitHub or Cloudflare need these accounts. Local chats and projects work
          without them.
        </p>
        <SetupGuide />
      </section>
    </section>
  );
}
