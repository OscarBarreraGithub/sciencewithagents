import './styles.css';
import './ui/dark.css';
import './entry-recovery.css';
import { pinGroupsEntry, readDistribution } from './distribution';
// The non-sensitive entry signal is available before pairing. It never authorizes data reads.
try {
  const distribution = await readDistribution();
  if (distribution === 'groups-only') {
    pinGroupsEntry();
    await import('./groups/GroupsEntry');
  } else await import('./full-main');
} catch (error) {
  const root = document.getElementById('root')!;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = error instanceof Error ? error.message : 'The app could not open.';
  const retry = document.createElement('button');
  retry.textContent = 'Retry opening app';
  retry.onclick = () => location.reload();
  retry.className = 'secondary';
  const card = document.createElement('main');
  card.className = 'entry-recovery';
  const heading = document.createElement('h1');
  heading.textContent = 'Open sciencewithagents';
  card.append(heading, message, retry);
  root.replaceChildren(card);
}
