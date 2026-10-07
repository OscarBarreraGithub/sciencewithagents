import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import '../setup-prompt.css';

const setupPrompt = `Help me set up Groups in my existing sciencewithagents installation.
Read docs/GROUP_WORKFLOW.md and docs/GROUP_NATIVE_OWNER_SETUP.md first.
Preserve my installation, accounts, files, saved work and running jobs.
Use the built-in hosted beta service for a fresh installation; preserve an existing
protected service configuration. I will supply one beta setup code to create a project,
or an invitation to join one. Help with the exact creator approval steps. Desktop Groups
does not need my own Cloudflare account or Tailscale; phone access and Git stay optional.
Use the native agent already installed on this computer with its existing provider
sign-in, tools, skills, hooks and permissions. Explain local agent access before I enable
it; help with ordinary provider sign-in only if needed. Shared chat and Private to you
use separate conversations, but local execution is not filesystem isolation. Never copy
credentials or put secrets in group messages. Do not publish private history, drafts or
files automatically; sharing files requires my explicit choice.
Help me create a group or join an invitation, then show how to send a message.
Do not start group agent work or allowance-using checks without my explicit approval.
Ask only for necessary owner decisions and report any remaining setup blocker.`;

export function GroupSetupPrompt() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = useRef<HTMLPreElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setCopyState('copied');
    } catch {
      // The prompt remains selectable even when clipboard access is unavailable.
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
    <details className="group-host-status">
      <summary>Set up Groups</summary>
      <p>Copy this prompt into Codex or Claude on the computer you want to set up.</p>
      <div className="setup-prompt">
        <div className="setup-prompt-head">
          <button type="button" onClick={() => void copy()}>
            {copyState === 'copied' ? (
              <Check size={16} aria-hidden />
            ) : (
              <Copy size={16} aria-hidden />
            )}
            {copyState === 'copied' ? 'Copied' : 'Copy setup prompt'}
          </button>
        </div>
        <pre ref={text} tabIndex={0} aria-label="Groups setup prompt">
          {setupPrompt}
        </pre>
        <p className="setup-prompt-status" role="status">
          {copyState === 'failed'
            ? 'Copy did not work in this browser. Select the prompt and copy it by hand.'
            : copyState === 'copied'
              ? 'Setup prompt copied.'
              : ''}
        </p>
      </div>
    </details>
  );
}
