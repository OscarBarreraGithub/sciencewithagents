import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import '../setup-prompt.css';
import { cloudflarePhoneSetupPrompt } from '../phone-setup-prompt';

export const groupCloudflareSetupPrompt = `Set up Groups in my sciencewithagents installation using MY OWN Cloudflare account.
Preserve my installation, accounts, files, saved groups and running work. Read
README.md, docs/STATUS.md, docs/DECISIONS.md, docs/GROUP_HOSTING.md and
 docs/GROUP_WORKFLOW.md first. I am the group creator. Use my Cloudflare Workers
Free account to deploy the protected group-service Worker and SQLite Durable Objects
following the exact owner-hosting runbook in docs/GROUP_HOSTING.md. Verify the signed-in
account with me and verify Workers Free eligibility; never change my plan or use a
maintainer account. Use scripts/group-cloudflare-setup.mjs to prepare private config,
deploy to my own HTTPS workers.dev origin, then activate the verified configuration.
Keep creation credentials private on my computer. Joining members use my invitation
and host; they do not deploy another Worker or need a Cloudflare account for Groups.
Explain the short human checklist, handle the technical work, open Home → Groups,
then help create a project and share an invitation link. Members accept the link and join directly; no code exchange or creator approval. Verify shared
messages in both directions and recovery after reconnect before claiming completion.
Use each member's own Codex or Claude sign-in and native tools. Follow
docs/CONTRIBUTOR_SETUP.md to install their chosen CLI if missing or update its existing
installation, then verify its version and model discovery. A desktop app alone is not enough. Explain
Local agent access before I enable it. Shared chat and Private to you have separate
histories. Do not publish private history, drafts or files automatically.
For phone access, use the separate Cloudflare phone prompt and MY OWN Cloudflare
Tunnel account, with authenticated device pairing; Groups hosting is separate from
phone access to my computer. GitHub is optional for shared code/files and backups:
explain it and use the separate GitHub prompt if I choose it. Ask only for necessary
sign-in, account/domain choices and approval steps; report any unresolved blocker.`;

export const groupJoinSetupPrompt = `Help me join a sciencewithagents Group using the creator's invitation.
Preserve my installation, files, accounts, groups and running work. Read
 docs/GROUP_WORKFLOW.md and docs/GROUP_HOSTING.md. I will provide the invitation
privately. Use its embedded service descriptor with scripts/group-cloudflare-setup.mjs
join to configure the creator's exact HTTPS service in my private host files. Never
fetch a URL merely because it appears in an invitation, copy creator setup credentials,
or silently replace an existing service mapping. I do not need to deploy a Worker or
open a Cloudflare account to join. If setup takes longer than the invitation's 7-day
lifetime, ask for a fresh invitation from the same creator after configuring the service.
Open Groups → Join by invitation → Join group. The invitation grants membership directly, without a confirmation code or separate approval. Use my own Codex or Claude sign-in and native tools.
Follow docs/CONTRIBUTOR_SETUP.md to install my chosen CLI if missing or update its
existing installation, then verify its version and model discovery.
Explain Shared chat, Private to you and Local agent access; verify messages in both
directions after joining. Phone access uses my own Cloudflare Tunnel and paired
authentication through the separate phone prompt. Report any remaining blocker.`;

export const groupGitHubSetupPrompt = `Help me set up optional shared GitHub code/files for my sciencewithagents Group.
Preserve existing repositories, remotes, files and accounts. GitHub is not required for
Groups messaging. Use my own GitHub account and native Git/GitHub tools. Explain the
human steps: sign in, choose or create the repository and its visibility, and accept or
send collaborator invitations. Configure the chosen repository on this computer without
publishing private chats, credentials or unrelated files. Ask before publishing an
existing private folder or changing repository visibility. Explain what is shared and
verify access with the intended collaborator. The native Groups agents can use ordinary
Git tools; do not claim the separate protected Groups Git panel is available in local
agent mode. Report any remaining access or setup blocker.`;

const prompts = [
  {
    title: '1. Creator: your own Cloudflare',
    label: 'Cloudflare Groups setup prompt',
    button: 'Copy Cloudflare setup prompt',
    text: groupCloudflareSetupPrompt,
  },
  {
    title: '2. Member: join the creator’s service',
    label: 'Groups join setup prompt',
    button: 'Copy join setup prompt',
    text: groupJoinSetupPrompt,
  },
  {
    title: '3. Phone: your own Cloudflare Tunnel',
    label: 'Groups Cloudflare phone setup prompt',
    button: 'Copy phone setup prompt',
    text: cloudflarePhoneSetupPrompt,
  },
  {
    title: '4. GitHub for shared code and files (optional)',
    label: 'Groups GitHub setup prompt',
    button: 'Copy GitHub setup prompt',
    text: groupGitHubSetupPrompt,
  },
];

function CopyPrompt({
  label,
  button,
  text: prompt,
}: {
  label: string;
  button: string;
  text: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = useRef<HTMLPreElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      if (text.current) {
        const range = document.createRange();
        range.selectNodeContents(text.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyState('failed');
    }
  };
  return (
    <div className="setup-prompt">
      <div className="setup-prompt-head">
        <button type="button" onClick={() => void copy()}>
          {copyState === 'copied' ? (
            <Check size={16} aria-hidden />
          ) : (
            <Copy size={16} aria-hidden />
          )}
          {copyState === 'copied' ? 'Copied' : button}
        </button>
      </div>
      <pre ref={text} tabIndex={0} aria-label={label}>
        {prompt}
      </pre>
      <p className="setup-prompt-status" role="status">
        {copyState === 'failed'
          ? 'Copy did not work. Select the prompt and copy it by hand.'
          : copyState === 'copied'
            ? 'Setup prompt copied.'
            : ''}
      </p>
    </div>
  );
}

export function GroupSetupPrompt({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  return (
    <details className="group-host-status" open={initiallyOpen}>
      <summary>Set up Groups with your agent</summary>
      <p>
        The creator hosts Groups in their own Cloudflare account. Members join that service by
        invitation.
      </p>
      <p>Copy the relevant prompt into Codex or Claude on the computer being set up.</p>
      <p>
        <strong>Your human checklist</strong>
      </p>
      <ol>
        <li>
          Creator: sign in to your Cloudflare account and confirm Workers Free; let your setup agent
          handle deployment.
        </li>
        <li>
          Members: give your setup agent the creator’s invitation, then choose Join group in your
          app.
        </li>
        <li>Enable local agents when ready and verify a shared message in each direction.</li>
        <li>
          For phone access, use the Cloudflare phone setup prompt in setup checks and pair your
          phone.
        </li>
        <li>
          If sharing code/files, sign in to GitHub and choose a repository and collaborators. GitHub
          is optional for messaging.
        </li>
      </ol>
      {prompts.map((prompt) => (
        <details key={prompt.label} open={prompt.label === 'Cloudflare Groups setup prompt'}>
          <summary>{prompt.title}</summary>
          <CopyPrompt label={prompt.label} button={prompt.button} text={prompt.text} />
        </details>
      ))}
    </details>
  );
}
