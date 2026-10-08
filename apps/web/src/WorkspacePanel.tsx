import { useState } from 'react';
import type { Agent } from '@dock/shared';
import { Modal } from './Modal';
import { useWorkspaceState, type SharedDraft } from './useWorkspaceState';

export function WorkspacePanel({
  workspace,
  agents,
  onSelect,
  close,
  embedded = false,
}: {
  workspace: ReturnType<typeof useWorkspaceState>;
  agents: Agent[];
  onSelect: (id: string) => void;
  close: () => void;
  embedded?: boolean;
}) {
  const [label, setLabel] = useState(workspace.state?.client.label ?? 'This browser');
  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? 'Saved conversation';
  const state = workspace.state;
  return (
    <Modal embedded={embedded} title="Open conversations" close={close}>
      <p>
        Your open conversations return when you restart sciencewithagents. Reconnect their saved
        Codex contexts below without sending a message or repeating interrupted work.
      </p>
      {workspace.error && (
        <div role="alert">
          <p>{workspace.error}</p>
          <button
            className="secondary"
            disabled={workspace.busy}
            onClick={() => void workspace.retry()}
          >
            Retry connection
          </button>
        </div>
      )}
      {!state ? (
        <p>Connecting to this computer…</p>
      ) : (
        <>
          <h3>Conversation connections</h3>
          <p className="muted">
            Reconnect uses each conversation’s existing context. Inspect interrupted work before
            asking it to continue. Native terminals open only when you ask.
          </p>
          {workspace.restoreError && <p role="alert">{workspace.restoreError}</p>}
          <button
            className="secondary"
            disabled={workspace.busy || workspace.restoring || !state.client.openAgentIds.length}
            onClick={() => void workspace.restore()}
          >
            {workspace.restoring
              ? 'Reconnecting saved conversations…'
              : 'Reconnect saved conversations'}
          </button>
          {workspace.restoreResults && (
            <section aria-label="Conversation connection results" aria-live="polite">
              <p>No message was sent. These are connection results, not completed work.</p>
              <ul>
                {workspace.restoreResults.map((result) => (
                  <li key={result.agentId}>
                    <strong>{name(result.agentId)}</strong>: {result.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <label className="field">
            Name this browser
            <input
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            className="secondary"
            disabled={workspace.busy || !label.trim() || label.trim() === state.client.label}
            onClick={() => void workspace.rename(label)}
          >
            Save browser name
          </button>
          <h3>Open here</h3>
          {!state.client.openAgentIds.length && (
            <p>No conversations are open here yet. Choose an agent to open one.</p>
          )}
          <ul className="workspace-open-list">
            {state.client.openAgentIds.map((id) => (
              <li key={id}>
                <button
                  className="secondary"
                  disabled={workspace.busy}
                  onClick={() => {
                    void workspace.open(id).then((updated) => {
                      if (updated) {
                        onSelect(id);
                        close();
                      }
                    });
                  }}
                >
                  {name(id)}
                  {id === state.client.selectedAgentId ? ' · Current' : ''}
                </button>
                <button
                  className="secondary"
                  aria-label={`Close ${name(id)} view`}
                  disabled={workspace.busy}
                  onClick={() => {
                    void workspace.close(id).then((updated) => {
                      if (updated) onSelect(updated.client.selectedAgentId ?? '');
                    });
                  }}
                >
                  Close view
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">
            Closing a view keeps its conversation, work and unfinished draft. A native terminal
            reconnects only when you ask.
          </p>
          <h3>Continue from another browser</h3>
          <p>
            Bring its open conversations here without closing anything there. Drafts are separate
            until you explicitly copy one.
          </p>
          {state.others
            .filter((other) => other.openAgentIds.length)
            .map((other) => (
              <section key={other.id} className="workspace-other-browser">
                <h4>{other.label}</h4>
                <p>{other.openAgentIds.map(name).join(', ')}</p>
                <button
                  className="secondary"
                  disabled={workspace.busy}
                  onClick={() => {
                    void workspace.continueHere(other.id, other.revision).then((updated) => {
                      if (updated?.client.selectedAgentId) {
                        onSelect(updated.client.selectedAgentId);
                        close();
                      }
                    });
                  }}
                >
                  Continue here from {other.label}
                </button>
              </section>
            ))}
          {!state.others.some((other) => other.openAgentIds.length) && (
            <p className="muted">
              Open this same computer from your paired phone or another browser to see its workspace
              here.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

export function DraftHandoff({
  draft,
  compact = false,
}: {
  draft: SharedDraft;
  compact?: boolean;
}) {
  const [showOtherDrafts, setShowOtherDrafts] = useState(false);
  return (
    <div className="draft-handoff">
      <p
        className="muted"
        role="status"
        data-draft={
          !draft.ready
            ? 'connecting'
            : draft.saving
              ? 'saving'
              : draft.unsaved
                ? 'unsaved'
                : draft.state?.own.submitted
                  ? 'receipt'
                  : 'saved'
        }
        title={
          compact
            ? 'Drafts are saved separately for this browser. Other devices cannot overwrite them.'
            : undefined
        }
      >
        {/* Routine autosave (typing, saving, saved) keeps one unchanging line so the composer
            and conversation never move per keystroke. Failures surface below as alerts; a hung
            save times out into one. Connecting and delivery receipts are genuine changes. */}
        {!draft.ready
          ? 'Loading draft…'
          : draft.state?.own.submitted && !draft.unsaved && !draft.saving
            ? 'This draft has a delivery receipt. Retrying an unchanged copy will not send it twice.'
            : compact
              ? 'Draft saved automatically'
              : 'Draft saved automatically'}
      </p>
      {draft.error && (
        <div role="alert">
          <p>{draft.error}</p>
          {!draft.conflict && (
            <button
              className="secondary"
              disabled={draft.saving}
              onClick={() => {
                void draft.retry().catch(() => {});
              }}
            >
              Retry saving draft
            </button>
          )}
        </div>
      )}
      {draft.conflict && (
        <>
          <details>
            <summary>Review the saved version</summary>
            <pre className="draft-preview">{draft.state?.own.text || '(Empty draft)'}</pre>
          </details>
          <button className="secondary" onClick={draft.useSavedVersion}>
            Use saved version
          </button>
          <button className="secondary" onClick={draft.keepMyVersion}>
            Keep my text
          </button>
        </>
      )}
      {draft.rejectedDraft && draft.rejectedDraft !== draft.text && (
        <details>
          <summary>Earlier draft refused by this computer</summary>
          <pre className="draft-preview">{draft.rejectedDraft}</pre>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([draft.rejectedDraft!], { type: 'text/plain' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'retained-draft.txt';
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download earlier draft
          </button>
        </details>
      )}
      {Boolean(draft.state?.others.length) && (
        <details
          open={showOtherDrafts}
          onToggle={(event) => setShowOtherDrafts(event.currentTarget.open)}
        >
          <summary>Drafts from other browsers ({draft.state?.others.length})</summary>
          <p>
            Copying keeps the original. Identical copies share one delivery receipt, so sending from
            both devices does not repeat the message.
          </p>
          {draft.state?.others.map((other) => (
            <section key={other.clientId}>
              <h4>
                {other.label}
                {other.submitted ? ' · Already submitted' : ''}
              </h4>
              <pre className="draft-preview">{other.text}</pre>
              <button
                className="secondary"
                disabled={draft.saving || draft.conflict || Boolean(draft.text.trim())}
                onClick={() => {
                  void draft
                    .copyDraft(other)
                    .then(() => setShowOtherDrafts(false))
                    .catch(() => {});
                }}
              >
                Copy draft here from {other.label}
              </button>
            </section>
          ))}
          {Boolean(draft.text.trim()) && (
            <p>Send or clear your current draft before copying another one here.</p>
          )}
        </details>
      )}
    </div>
  );
}
