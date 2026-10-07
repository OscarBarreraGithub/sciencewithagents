import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { GroupCatchup } from '../src/groups/GroupCatchup';
import './preview.css';
function Preview() {
  const [open, setOpen] = useState(true);
  return (
    <main>
      {open ? (
        <GroupCatchup
          handle="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          onClose={() => setOpen(false)}
          members={[{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Bob · 李明' }]}
        />
      ) : (
        <button onClick={() => setOpen(true)}>Open private catch-up</button>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
