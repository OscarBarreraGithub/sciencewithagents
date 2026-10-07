import { createRoot } from 'react-dom/client';
import { GroupActionsBoard } from '../src/groups/GroupActionsBoard';
const handle = '00000000-0000-4000-8000-000000000001';
createRoot(document.getElementById('root')!).render(<GroupActionsBoard handle={handle} />);
