import './group-invitation';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, MessageCircle } from 'lucide-react';
import { GroupsApp } from './GroupsApp';
import { PhoneGate } from '../PhoneAccess';
import { readPairingCode } from '../pairing-link';
import { startClientCache } from '../cache-bootstrap';
import '../styles.css';
import '../ui/dark.css';
import '../home/home.css';
import '../home/workspace-flow.css';

startClientCache({ registerWorker: import.meta.env.PROD });
const initialPairingCode = readPairingCode();
function GroupsShell() {
  const route = () => {
    const hash = location.hash.slice(2);
    return /^chats\/groups(?:\/[^/]+)?$/.test(hash)
      ? hash
      : /^groups(?:\/[^/]+)?$/.test(hash)
        ? `chats/${hash}`
        : 'chats/groups';
  };
  const [current, setCurrent] = useState(route);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const changed = () => setCurrent(route());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return (
    <div className="home-shell groups-shell">
      <main className="home-content" id="home-content">
        <GroupsApp
          route={current}
          query={query}
          groupsOnly
          listHeader={
            <>
              <div className="groups-brand-row">
                <a
                  className="home-brand"
                  href="#/chats/groups"
                  aria-label="sciencewithagents Groups"
                >
                  <MessageCircle size={22} aria-hidden="true" />
                  <span>sciencewithagents</span>
                </a>
              </div>
              <div className="chat-list-head">
                <h1 className="chat-list-title">Groups</h1>
              </div>
              <label className="flow-search chat-search">
                <Search size={17} aria-hidden="true" />
                <input
                  aria-label="Find a group"
                  placeholder="Search groups"
                  value={query}
                  maxLength={200}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </>
          }
          sidebarFooter={
            <div className="groups-sidebar-utilities">
              <p>Groups on this computer</p>
              <a
                className="flow-button"
                href="https://github.com/OscarBarreraGithub/sciencewithagents/blob/groups-only/docs/GROUPS_ONLY.md"
                target="_blank"
                rel="noreferrer"
              >
                Setup and updates
              </a>
            </div>
          }
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PhoneGate initialPairingCode={initialPairingCode}>
      <GroupsShell />
    </PhoneGate>
  </React.StrictMode>,
);
