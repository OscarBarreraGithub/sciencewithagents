import { useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { apiScope } from '../api';
import { PromptCard } from '../SetupPrompt';
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
  const heading = useRef<HTMLHeadingElement>(null);
  // A display preference, not a claim that an account is authenticated.
  const setupKey = `dock:${apiScope()}:apps:hide-setup`;
  const [hideSetup, setHideSetup] = useState(() => {
    try {
      return localStorage.getItem(setupKey) === '1';
    } catch {
      return false;
    }
  });
  function dismissSetup() {
    try {
      localStorage.setItem(setupKey, '1');
    } catch {
      // The shortcut still hides for this visit when storage is unavailable.
    }
    setHideSetup(true);
    heading.current?.focus();
  }
  return (
    <section className="apps-page" aria-labelledby="apps-heading">
      <header className="apps-heading">
        <p className="home-eyebrow">APPS</p>
        <h1 id="apps-heading" tabIndex={-1} ref={heading}>
          Apps
        </h1>
        <p>Tools for your projects.</p>
      </header>
      <a href="#/latex" className="apps-tile">
        <span className="latex-app-icon" aria-hidden="true">
          T<span>E</span>X
        </span>
        LaTeX
      </a>
      {!hideSetup && (
        <details className="apps-setup">
          <summary>
            Set up publishing accounts <ChevronDown size={20} aria-hidden="true" />
          </summary>
          <div className="apps-setup-content">
            <p>
              Only apps that use GitHub or Cloudflare need these accounts. Local chats and projects
              work without them.
            </p>
            <div className="apps-setup-dismiss">
              <p>Already set up? These instructions are always available in Help and setup.</p>
              <button type="button" className="setup-link" onClick={dismissSetup}>
                Hide setup shortcut
              </button>
            </div>
            <SetupGuide />
          </div>
        </details>
      )}
    </section>
  );
}
