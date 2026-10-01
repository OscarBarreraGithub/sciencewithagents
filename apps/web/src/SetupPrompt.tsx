import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import './setup-prompt.css';

export function PromptCard({ label, prompt }: { label: string; prompt: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = useRef<HTMLPreElement>(null);
  const timer = useRef(0);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(prompt);
      setState('copied');
      timer.current = window.setTimeout(() => setState('idle'), 2500);
    } catch {
      // Leave the text selected so it can still be copied by hand.
      const range = document.createRange();
      if (text.current) range.selectNodeContents(text.current);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      setState('failed');
    }
  };
  return (
    <div className="setup-prompt">
      <div className="setup-prompt-head">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()}>
          {state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={text} tabIndex={0}>
        {prompt}
      </pre>
      <p className="setup-prompt-status" role="status">
        {state === 'failed'
          ? 'Copy did not work in this browser. The prompt is selected; copy it by hand.'
          : ''}
      </p>
    </div>
  );
}
