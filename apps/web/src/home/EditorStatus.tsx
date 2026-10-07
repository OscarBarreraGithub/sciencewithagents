import { useState } from 'react';
import { ArrowRight, Code } from 'lucide-react';
import { mirrorDaemon } from '../useMirrorChats';
import { Modal } from '../Modal';
import type { HomeData } from './useHomeData';

export function EditorStatus({ data }: { data: HomeData }) {
  const [open, setOpen] = useState(false);
  // Native Codex daemon sessions are not VS Code windows; Chats lists them separately.
  const windows = (data.mirrors.data ?? []).filter((w) => !mirrorDaemon(w));
  const live = windows.filter((w) => w.status !== 'offline');
  const shared = live.filter((w) => w.threadId).length;
  const [text, tone] = data.mirrors.error
    ? ['Unavailable', 'muted']
    : !data.mirrors.loaded
      ? ['Checking', 'muted']
      : !windows.length
        ? ['Not connected', 'muted']
        : !live.length
          ? ['Offline', 'muted']
          : live.some((w) => w.status === 'attention')
            ? ['Needs input', 'warn']
            : shared
              ? [`${shared} shared`, 'ok']
              : ['Connected', 'ok'];
  return (
    <>
      <button
        type="button"
        className={`connection-check home-editor tone-${tone}`}
        onClick={() => setOpen(true)}
        aria-label={`VS Code on this computer: ${text}. Show setup status and extension instructions`}
        aria-haspopup="dialog"
      >
        <Code size={15} aria-hidden="true" />
        <span>VS Code</span>
        <span className="connection-check-state">{text}</span>
      </button>
      {open && (
        <Modal title="VS Code setup" close={() => setOpen(false)} className="home-editor-setup">
          <p role="status">
            <strong>{text}</strong>
            {' · '}
            {data.mirrors.error
              ? 'Could not check the connection to this computer.'
              : live.length
                ? 'The extension is connected to sciencewithagents.'
                : 'No connected extension is reporting yet. VS Code may be closed; this does not prove it is uninstalled.'}
          </p>
          <button className="flow-button" onClick={data.mirrors.retry}>
            Check connection
          </button>
          <h3>Set up the extension</h3>
          <ol>
            <li>Open VS Code on this computer with Codex or Claude Code already working.</li>
            <li>
              Ask your setup agent to install the sciencewithagents companion using the setup guide
              below. If you already have its VSIX file, choose{' '}
              <strong>Extensions → … → Install from VSIX</strong>.
            </li>
            <li>
              Click <strong>sciencewithagents</strong> in VS Code’s bottom bar, then choose{' '}
              <strong>Share a Codex conversation</strong> or{' '}
              <strong>Share a Claude Code conversation</strong>. First-time setup backs up and
              updates the provider’s connection file. Only reload VS Code when your current work is
              safe.
            </li>
            <li>
              Choose the conversation to share. It appears in <strong>Chats → VS Code</strong> on
              your computer and paired phone.
            </li>
          </ol>
          <p>
            No separate editor login or connection code. Keep VS Code and sciencewithagents open.
          </p>
          <a
            className="flow-button"
            href="https://github.com/OscarBarreraGithub/sciencewithagents/blob/main/docs/CONTRIBUTOR_SETUP.md#optional-vs-code-companion"
            target="_blank"
            rel="noreferrer"
          >
            Extension setup guide <ArrowRight size={16} />
          </a>
        </Modal>
      )}
    </>
  );
}
