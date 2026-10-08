import './groups/group-invitation';
import { DocumentHost } from './Documents';
import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './home/Home';
import { PhoneGate } from './PhoneAccess';
import './styles.css';
import { apiScope, selectComputer } from './api';
import { readPairingCode } from './pairing-link';
import { startClientCache } from './cache-bootstrap';

startClientCache({ registerWorker: import.meta.env.PROD });

// Keep scan input only in this document. StrictMode may initialize components twice;
// consuming the URL inside a component would discard the code on its second mount.
const initialPairingCode = readPairingCode();
// Retain the previous interface for deliberate maintenance/recovery. The new
// home never links to it and never mounts its auto-restoration or draft effects.
const ClassicApp = lazy(() => import('./App').then((module) => ({ default: module.App })));
const classic = (() => {
  const selected = new URLSearchParams(location.search).get('workspace');
  if (selected) return selected === 'classic';
  try {
    return sessionStorage.getItem('dock:workspace-ui') === 'classic';
  } catch {
    return false;
  }
})();
function WorkspaceApp() {
  const [switching, setSwitching] = useState(false);
  if (switching)
    return (
      <p role="status">
        Opening your selected computer… Your saved work stays on its original computer.
      </p>
    );
  return classic ? (
    <Suspense fallback={<p role="status">Opening the previous workspace…</p>}>
      <ClassicApp
        key={apiScope()}
        onHostChange={(id) => {
          setSwitching(true);
          selectComputer(id);
        }}
      />
    </Suspense>
  ) : (
    <Home />
  );
}
const fixtureEnabled =
  location.pathname === '/group-fixture' &&
  (await fetch('/api/health')
    .then((response) => response.json())
    .then((value: { groupFixture?: boolean }) => value.groupFixture === true)
    .catch(() => false));
const FixtureApp = fixtureEnabled ? (await import('./groups/GroupFixture')).GroupFixture : null;
createRoot(document.getElementById('root')!).render(
  FixtureApp ? (
    <FixtureApp />
  ) : (
    <React.StrictMode>
      <PhoneGate initialPairingCode={initialPairingCode}>
        <WorkspaceApp />
        <DocumentHost />
      </PhoneGate>
    </React.StrictMode>
  ),
);
