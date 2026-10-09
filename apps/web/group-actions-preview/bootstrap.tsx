import { createRoot } from 'react-dom/client';
import { GroupActionsBoard } from '../src/groups/GroupActionsBoard';
const handle = '00000000-0000-4000-8000-000000000001';
createRoot(document.getElementById('root')!).render(
  <GroupActionsBoard
    actor={{
      memberId: '00000000-0000-4000-8000-000000000005',
      installationId: '00000000-0000-4000-8000-000000000006',
    }}
    handle={handle}
  />,
);
