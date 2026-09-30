import { attention, type AttentionItem, type Snapshot } from '@dock/shared';
import { Modal } from './Modal';

const labels = {
  approval: 'Permission request',
  decision: 'Manager decision',
  failed: 'Stopped work',
  interrupted: 'Interrupted work',
  integration: 'Ready to apply',
  backup: 'Source backup',
};
export function AttentionPanel({
  state,
  close,
  open,
}: {
  state: Snapshot;
  close: () => void;
  open: (item: AttentionItem) => void;
}) {
  const items = attention(state).items;
  return (
    <Modal title="Needs your attention" close={close}>
      <p>
        One place to review pending items across all projects. Opening an item never approves,
        resumes or applies anything.
      </p>
      {items.length === 0 ? (
        <p role="status">Nothing needs your attention right now.</p>
      ) : (
        <ul className="attention-list">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <small>
                {item.projectName} · {labels[item.kind]}
              </small>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <button className="secondary" onClick={() => open(item)}>
                {item.destination === 'workspace'
                  ? 'Review changes'
                  : item.kind === 'approval'
                    ? 'Review request'
                    : 'Open conversation'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
