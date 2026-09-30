import { useRef, useState } from 'react';

/** Keep failures where the user is working, with one pending submission at a time. */
export function useFormAction(act: (fn: () => Promise<unknown>) => Promise<void>) {
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setError('');
    try {
      await act(async () => {
        try {
          return await fn();
        } catch (error) {
          setError(
            error instanceof TypeError
              ? 'We lost the connection. Your details are still here. Please try again.'
              : error instanceof Error
                ? error.message
                : 'That didn’t work. Your details are still here. Please try again.',
          );
          throw error;
        }
      });
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  return { pending, error, run, clearError: () => setError('') };
}
