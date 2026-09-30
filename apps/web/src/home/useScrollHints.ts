import { useEffect, useState, type RefObject } from 'react';

/** Fixed-size hints: observing content never moves the surrounding panel. */
export function useScrollHints(ref: RefObject<HTMLElement | null>, identity: string) {
  const [hint, setHint] = useState('');
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const above = element.scrollTop > 8;
      const below = element.scrollHeight - element.clientHeight - element.scrollTop > 8;
      setHint(
        above && below ? 'More above and below' : below ? 'More below' : above ? 'More above' : '',
      );
    };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const mutation = new MutationObserver(read);
    mutation.observe(element, { subtree: true, childList: true, characterData: true });
    element.addEventListener('scroll', read, { passive: true });
    read();
    return () => {
      observer.disconnect();
      mutation.disconnect();
      element.removeEventListener('scroll', read);
    };
  }, [ref, identity]);
  return hint;
}
