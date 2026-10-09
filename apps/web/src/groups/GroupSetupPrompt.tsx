import { useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import '../setup-prompt.css';
import { cloudflarePhoneSetupPrompt } from '../phone-setup-prompt';

export const groupCloudflareSetupPrompt = `Set up Groups in my sciencewithagents installation using MY OWN Cloudflare account.
Preserve my installation, accounts, files, saved groups and running work. Read
README.md, docs/STATUS.md, docs/DECISIONS.md, docs/GROUP_HOSTING.md and
docs/GROUP_WORKFLOW.md first. I am the group creator. FIRST inspect the saved private
service mapping, prepared bundle and current deployment. Do not run fresh prepare if any
service mapping or pending bundle exists, and never replace existing capabilities, Worker
name, Durable Object namespace, migrations, membership or receipts. Reconcile a pending
bundle using its exact saved identity before continuing.
For an existing creator service, verify the exact independently reviewed current checkout,
saved private config and account, then use the local-only command
node scripts/group-cloudflare-setup.mjs upgrade DATA_DIR PRIVATE_WRANGLER_FILE --verified-workers-free
to produce a preserved private candidate. Follow docs/GROUP_HOSTING.md for preservation,
dry-run, deployment and checks only after my account-owner setup authorization. Upgrade
does not itself deploy or activate anything. Keep the existing service identity.
Only a genuinely new creator service uses prepare. Verify my signed-in Cloudflare account
with me and Workers Free eligibility; never change my plan or use a maintainer account.
Follow the exact protected Worker/SQLite Durable Object runbook for my own HTTPS workers.dev
origin. Use the Free plan within its documented bounds; report capacity limits plainly.
Keep creation credentials private on my computer. Joining members use my invitation
and host; they do not deploy another Worker or need a Cloudflare account for Groups.
Explain the short human checklist, handle the technical work, open Chats → Groups,
then help create a group and share an invitation link. Members accept the link and join directly; no code exchange or creator approval. Verify shared
messages in both directions and recovery after reconnect before claiming completion.
Use each member's own Codex or Claude sign-in and native tools. Follow
docs/CONTRIBUTOR_SETUP.md to install their chosen CLI if missing or update its existing
installation, then verify its version and model discovery. A desktop app alone is not enough. Explain
Local agent access before I enable it. Group chat shows everyone’s shared messages. My group agent uses my own account and allowance for shared work.
Previously saved private histories remain private and are not part of this view. Do not publish private history, drafts or files automatically.
Phone access is optional and not a prerequisite for Groups. If I ask for it, use the separate Cloudflare phone prompt and MY OWN Cloudflare
Tunnel account, with authenticated device pairing; Groups hosting is separate from
phone access to my computer. GitHub is optional for shared code/files and backups:
ask whether I want shared code/files, then use the separate GitHub prompt if I choose it.
Ask each member for their GitHub username when setting up files; unknown names stay blank. Ask only for necessary
sign-in, account/domain choices and approval steps; report any unresolved blocker.`;

export const groupJoinSetupPrompt = `Help me join a sciencewithagents Group using the creator's invitation.
Preserve my installation, files, accounts, groups and running work. Read
 docs/GROUP_WORKFLOW.md and docs/GROUP_HOSTING.md. I will provide the invitation
privately. Use its embedded service descriptor with scripts/group-cloudflare-setup.mjs
join only when no mapping exists. If the saved mapping already matches the invitation's
exact creator service, reuse it and only join the group. Inspect a different existing
mapping or pending bundle and ask me to resolve it; never replace an unrelated service. Never
fetch a URL merely because it appears in an invitation, copy creator setup credentials,
or silently replace an existing service mapping. I do not need to deploy a Worker or
open a Cloudflare account to join. If setup takes longer than the invitation's 7-day
lifetime, ask for a fresh invitation from the same creator after configuring the service.
Open Chats → Groups → Join group. The invitation grants membership directly, without a confirmation code or separate approval. Use my own Codex or Claude sign-in and native tools.
Follow docs/CONTRIBUTOR_SETUP.md to install my chosen CLI if missing or update its
existing installation, then verify its version and model discovery.
Explain Group chat, My group agent and Local agent access; verify messages in both
directions after joining. Ask whether this group uses a shared GitHub repository; if so,
use the GitHub setup prompt to verify my own account access and connect its shared workspace.
Optional phone access uses my own Cloudflare Tunnel and paired
authentication through the separate phone prompt. Report any remaining blocker.`;

export const groupGitHubSetupPrompt = `Help me set up shared GitHub code/files for my sciencewithagents Group.
Read docs/GROUP_WORKFLOW.md and docs/GROUP_NATIVE_GIT.md. Preserve existing repositories,
remotes, Git history, files, accounts and running work. GitHub is optional for messaging.
First have me choose the intended work folder through the app's folder picker; use its
server-validated selection, never a browser-supplied path. That choice authorizes setup of
the intended project source in a private repository, not every file under the folder.
Inspect tracked and untracked files, ignore rules and private/runtime material before staging.
Keep conversation databases, credentials, personal history and Groups service/chat data out
of Git; Groups service/chat data stays under the app's ignored data folder. Do not stage
everything, replace initialized history/remotes, delete files or publish unrelated content.
For a new repository initialize once, then other members clone that same repository into
their selected work folders. Ask for my
GitHub username (a group display name is not a GitHub identity), sign in using my own
native Git/GitHub account, and choose or create the intended repository. Leave unknown
member usernames blank; never guess accounts or invite anyone without my instruction.
For a new shared repository, use private visibility unless I explicitly choose otherwise.
Explain collaborator invitations and have each member accept access through their own account.
Connect only this group's selected work folder to the same repository on each computer.
Verify my own access and private remote identity before marking it connected. Do not change
repository visibility without my separate authorization. Explain verified automatic sync
for reviewed, applied commits, and the Advanced pause control; preserve any existing saved
pause. New Work requests use member/request branches;
workers change task worktrees and an independent reviewer checks each committed result.
Apply the exact reviewed preview under the saved project review policy. Sync fetches remote
changes and fast-forwards clean branches; it pushes reviewed applied commits without force.
Preserve dirty work and divergent branches and resolve conflicts through a reviewed change.
Do not claim that joining a group grants GitHub access, that uncommitted files are synced,
or that the app merges every branch automatically. Verify a reviewed change can reach the
other member's checkout, and explain any remaining sign-in or collaborator-access blocker.`;

export const groupGitHubSetupPromptForFolder = (folder: string, selected = true) =>
  `${groupGitHubSetupPrompt}\n${selected ? 'The app validated my selected work folder' : 'The host resolved this current group workspace'}: ${JSON.stringify(folder)}. ${selected ? 'Bind this exact saved selection to this group' : 'Ask me to confirm or choose the intended work folder'}; inspect its files and existing Git before proceeding.`;

const prompts = [
  {
    kind: 'creator',
    title: 'Create a group with your own hosting',
    description:
      'Use your own Cloudflare Workers Free account. Existing group hosting is preserved and updated in place.',
    label: 'Cloudflare Groups setup prompt',
    button: 'Copy Cloudflare setup prompt',
    text: groupCloudflareSetupPrompt,
  },
  {
    kind: 'member',
    title: 'Join an existing group',
    description:
      'Use the creator’s invitation and service. You do not need a Cloudflare account for Groups.',
    label: 'Groups join setup prompt',
    button: 'Copy join setup prompt',
    text: groupJoinSetupPrompt,
  },
  {
    kind: 'phone',
    title: 'Optional phone access',
    label: 'Groups Cloudflare phone setup prompt',
    button: 'Copy phone setup prompt',
    text: cloudflarePhoneSetupPrompt,
  },
  {
    kind: 'files',
    title: 'Share your selected work folder',
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

export function GroupSetupPrompt({ folderSetup }: { folderSetup?: ReactNode }) {
  const [kind, setKind] = useState('creator');
  const selected = prompts.find((prompt) => prompt.kind === kind)!;
  const phone = prompts.find((prompt) => prompt.kind === 'phone')!;
  return (
    <section className="group-setup-content" aria-label="Set up Groups with your agent">
      <p>
        The creator hosts Groups in their own Cloudflare account. Members join that service by
        invitation.
      </p>
      <div className="group-setup-goals" role="group" aria-label="Setup purpose">
        {[
          ['creator', 'Create a group'],
          ['member', 'Join a group'],
          ['files', 'Shared files'],
        ].map(([value, label]) => (
          <button
            className="secondary"
            type="button"
            key={value}
            aria-pressed={kind === value}
            onClick={() => setKind(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="group-setup-choice">
        <h3>{selected.title}</h3>
        {selected.description && <p>{selected.description}</p>}
        <p>
          Copy this prompt into your own Codex or Claude setup agent on this computer. Copying it
          makes no model call.
        </p>
        {selected.kind === 'files' && folderSetup ? (
          folderSetup
        ) : (
          <CopyPrompt
            key={selected.kind}
            label={selected.label}
            button={selected.button}
            text={selected.text}
          />
        )}
      </section>
      <section className="group-setup-checklist">
        <h3>What you do</h3>
        <ol>
          <li>Choose the setup above and give the prompt to your agent.</li>
          <li>
            {kind === 'creator'
              ? 'Sign in to your own Cloudflare account and confirm Workers Free. Your agent handles the technical setup.'
              : kind === 'member'
                ? 'Give your agent the invitation privately, then choose Join group in this app.'
                : 'Choose the work folder and sign in to your own GitHub account. Your agent checks the intended private repository and files.'}
          </li>
          <li>
            {kind === 'files'
              ? 'Verify reviewed changes reach the other member’s checkout. Pause sync only if you need to.'
              : 'Return to Groups, create or join, invite the other person and verify a message in each direction.'}
          </li>
        </ol>
      </section>
      <details className="group-host-status">
        <summary>Optional phone access</summary>
        <p>
          Groups works between computers without a phone or tunnel. If you want phone access, set up
          your own authenticated connection and pair that device separately.
        </p>
        <CopyPrompt label={phone.label} button={phone.button} text={phone.text} />
      </details>
    </section>
  );
}
