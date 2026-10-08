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
Explain the short human checklist, handle the technical work, open Chats → Groups,
then help create a project and share an invitation link. Members accept the link and join directly; no code exchange or creator approval. Verify shared
messages in both directions and recovery after reconnect before claiming completion.
Use each member's own Codex or Claude sign-in and native tools. Follow
docs/CONTRIBUTOR_SETUP.md to install their chosen CLI if missing or update its existing
installation, then verify its version and model discovery. A desktop app alone is not enough. Explain
Local agent access before I enable it. Group chat shows everyone’s shared messages. Group manager directs my own agent’s shared work.
Previously saved private histories remain private and are not part of this view. Do not publish private history, drafts or files automatically.
For phone access, use the separate Cloudflare phone prompt and MY OWN Cloudflare
Tunnel account, with authenticated device pairing; Groups hosting is separate from
phone access to my computer. GitHub is optional for shared code/files and backups:
ask whether I want shared code/files, then use the separate GitHub prompt if I choose it.
Ask each member for their GitHub username when setting up files; unknown names stay blank. Ask only for necessary
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
Open Chats → Groups → Join group. The invitation grants membership directly, without a confirmation code or separate approval. Use my own Codex or Claude sign-in and native tools.
Follow docs/CONTRIBUTOR_SETUP.md to install my chosen CLI if missing or update its
existing installation, then verify its version and model discovery.
Explain Group chat, Group manager and Local agent access; verify messages in both
directions after joining. Ask whether this group uses a shared GitHub repository; if so,
use the GitHub setup prompt to verify my own account access and connect its shared workspace.
Phone access uses my own Cloudflare Tunnel and paired
authentication through the separate phone prompt. Report any remaining blocker.`;

export const groupGitHubSetupPrompt = `Help me set up shared GitHub code/files for my sciencewithagents Group.
Read docs/GROUP_WORKFLOW.md and docs/GROUP_NATIVE_GIT.md. Preserve existing repositories,
remotes, files, accounts and running work. GitHub is optional for messaging. Ask for my
GitHub username (a group display name is not a GitHub identity), sign in using my own
native Git/GitHub account, and choose or create the intended repository. Leave unknown
member usernames blank; never guess accounts or invite anyone without my instruction.
For a new shared repository, use private visibility unless I explicitly choose otherwise.
Explain collaborator invitations and have each member accept access through their own account.
Connect only this group's server-selected shared workspace to the same repository on each
computer. Keep Private to you, conversation databases, credentials and unrelated files out
of the repository. Never publish an existing folder or change visibility without authorization.
Open Manage group → Shared files, save my username if known, and enable automatic sync
when I choose shared file synchronization. New Work requests use member/request branches;
workers change task worktrees and an independent reviewer checks each committed result.
Apply the exact reviewed preview under the saved project review policy. Sync fetches remote
changes and fast-forwards clean branches; it pushes reviewed applied commits without force.
Preserve dirty work and divergent branches and resolve conflicts through a reviewed change.
Do not claim that joining a group grants GitHub access, that uncommitted files are synced,
or that the app merges every branch automatically. Verify a reviewed change can reach the
other member's checkout, and explain any remaining sign-in or collaborator-access blocker.`;

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
    description:
      'Connect a repository only if your group will work on files together. Group messages already sync through Cloudflare.',
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
        text.current.closest('details')?.setAttribute('open', '');
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
      <details className="group-prompt-text">
        <summary>Read prompt</summary>
        <pre ref={text} tabIndex={0} aria-label={label}>
          {prompt}
        </pre>
      </details>
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
      <details>
        <summary>Your setup checklist</summary>
        <ol>
          <li>
            Creator: sign in to your Cloudflare account and confirm Workers Free; let your setup
            agent handle deployment.
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
            For shared files, sign in to GitHub, provide your GitHub username, choose the repository
            and accept collaborator access. Then enable Shared files → Automatic sync. GitHub is
            optional for messaging.
          </li>
        </ol>
      </details>
      {prompts.map((prompt) => (
        <section className="group-setup-choice" key={prompt.label}>
          <h3>{prompt.title}</h3>
          {prompt.description && <p>{prompt.description}</p>}
          <CopyPrompt label={prompt.label} button={prompt.button} text={prompt.text} />
        </section>
      ))}
    </details>
  );
}
