import { useEffect, useRef, useState } from 'react';
import type { SharedDraft } from './useWorkspaceState';

type Version = { text: string; at: string };
type Archive = { text: string; at: string; versions: Version[] };

// Keep recent versions without multiplying a long prompt past browser storage quotas.
// The newest full version always survives, even when the draft exceeds the send limit.
function retainedVersions(versions: Version[]) {
  let characters = 0;
  return versions.filter((version, index) => {
    characters += version.text.length;
    return index === 0 || (index < 50 && characters <= 200_000);
  });
}

/** Primary drafts/receipts stay per-tab. Each mounted draft owns a separate recovery
 * record, so another tab can only offer copies, never overwrite this draft. */
export function useBrowserNotepad(key: string, text: string, save: (text: string) => void) {
  const prefix = `${key}:notepad-recovery:`;
  const recoveryKey = useRef(`${prefix}${crypto.randomUUID()}`).current;
  const current = useRef(text);
  current.current = text;
  const [error, setError] = useState('');
  const [recovered] = useState<Version[]>(() => {
    const found: Version[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name?.startsWith(prefix)) continue;
        const record = JSON.parse(localStorage.getItem(name) ?? 'null') as Archive | null;
        if (!record || !Array.isArray(record.versions)) continue;
        for (const v of [{ text: record.text, at: record.at }, ...record.versions])
          if (typeof v.text === 'string' && v.text.trim() && typeof v.at === 'string')
            found.push(v);
      }
    } catch {
      /* A denied store does not replace the current session draft. */
    }
    return found
      .sort((a, b) => b.at.localeCompare(a.at))
      .filter((v, i, all) => all.findIndex((w) => w.text === v.text) === i)
      .slice(0, 100);
  });
  const savedVersions = useRef<Version[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const persist = () => {
    try {
      localStorage.setItem(
        recoveryKey,
        JSON.stringify({
          text: current.current,
          at: new Date().toISOString(),
          versions: savedVersions.current,
        }),
      );
      setError('');
    } catch {
      setError('This draft could not be kept for reopening. Copy or download it before closing.');
    }
  };
  const checkpoint = () => {
    const value = current.current;
    if (savedVersions.current[0]?.text !== value) {
      savedVersions.current = retainedVersions([
        { text: value, at: new Date().toISOString() },
        ...savedVersions.current,
      ]);
      setVersions(savedVersions.current);
    }
    persist();
  };
  const setText = (value: string) => {
    current.current = value;
    save(value);
    // Only the latest unsent snapshot changes on each keystroke.
    persist();
  };
  useEffect(() => {
    persist();
    const timer = window.setTimeout(checkpoint, 1500);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const retain = () => {
      const value = current.current;
      if (savedVersions.current[0]?.text !== value)
        savedVersions.current = retainedVersions([
          { text: value, at: new Date().toISOString() },
          ...savedVersions.current,
        ]);
      try {
        localStorage.setItem(
          recoveryKey,
          JSON.stringify({
            text: value,
            at: new Date().toISOString(),
            versions: savedVersions.current,
          }),
        );
      } catch {
        /* Live view reports storage failure. */
      }
    };
    window.addEventListener('pagehide', retain);
    return () => {
      retain();
      window.removeEventListener('pagehide', retain);
    };
  }, [recoveryKey]);
  const draft: SharedDraft = {
    text,
    currentText: () => current.current,
    setText,
    state: null,
    ready: true,
    saving: false,
    unsaved: false,
    error,
    conflict: false,
    flush: async () => {
      checkpoint();
      return null;
    },
    retry: async () => {
      persist();
      return null;
    },
    copyDraft: async () => {},
    useSavedVersion: () => {},
    keepMyVersion: () => {},
    clearSent: async () => {},
  };
  const history = {
    versions: [...versions, ...recovered]
      .filter((v, i, all) => all.findIndex((w) => w.text === v.text) === i)
      .slice(0, 100),
    restore: (value: string) => {
      checkpoint();
      setText(value);
    },
  };
  return { draft, history, checkpoint };
}
