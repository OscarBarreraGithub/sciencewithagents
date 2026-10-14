import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  appSourceUpdatesSchema,
  appSourceUpdatePrompt,
  type AppSourceUpdates,
} from '@dock/shared/dist/app-source-updates.js';
import { CopyPrompt } from './GroupSetupPrompt';
export function GroupAppUpdates({ value: initial }: { value: AppSourceUpdates }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial);
  }, [initial]);
  useEffect(() => {
    const controller = new AbortController();
    const read = () => {
      if (!document.hidden)
        void api('/groups/app-updates', undefined, controller.signal)
          .then((raw) => {
            if (!controller.signal.aborted) setValue(appSourceUpdatesSchema.parse(raw));
          })
          .catch(() => {});
    };
    const timer = window.setInterval(read, 60_000);
    window.addEventListener('focus', read);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, []);
  return (
    <details className="group-host-status group-app-updates">
      <summary>
        App updates{value.check?.state === 'available' ? ' · Update available' : ''}
      </summary>
      <p role="status">{value.check?.message ?? `Checking ${value.branch} update metadata…`}</p>
      {value.check && (
        <p>
          Checked {new Date(value.check.checkedAt).toLocaleString()}. Checks run while the app is
          open, normally every six hours, without a model call.
        </p>
      )}
      {value.check?.state === 'error' && value.lastSuccessful && (
        <p>
          Last successful check:{' '}
          {value.lastSuccessful.state === 'available' ? 'update available' : 'up to date'} on{' '}
          {new Date(value.lastSuccessful.checkedAt).toLocaleString()}.
        </p>
      )}
      <CopyPrompt
        label="App update instructions"
        button="Copy update instructions"
        text={appSourceUpdatePrompt(value.branch)}
      />
      <p>
        Your existing agent can tell you about this status when it next reads Groups. This does not
        wake an idle conversation or apply updates.
      </p>
    </details>
  );
}
