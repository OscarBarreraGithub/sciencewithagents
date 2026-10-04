import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import type { DocumentReading as Reading } from '@dock/shared';
import { apiScope, apiUrl } from './api';
import 'katex/dist/katex.min.css';

export function DocumentReading({
  id,
  reading,
  size,
  close,
}: {
  id: string;
  reading: Reading;
  size: number;
  close: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; equation: boolean } | null>(null);
  const html = useMemo(() => {
    const source = reading.html.replace(
      /reader-asset:([a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif))/g,
      (_, asset: string) => apiUrl(`/documents/${id}/assets/${asset}`),
    );
    const clean = DOMPurify.sanitize(source, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'embed', 'object', 'audio', 'video'],
      FORBID_ATTR: ['style', 'srcset', 'name'],
    });
    const document = new DOMParser().parseFromString(clean, 'text/html');
    for (const image of document.querySelectorAll('img')) {
      const src = image.getAttribute('src') ?? '';
      if (!src.startsWith(apiUrl(`/documents/${id}/assets/`))) image.remove();
    }
    const numbers = { ...reading.labels };
    let nextNumber = 0;
    for (const math of document.querySelectorAll<HTMLElement>('.math')) {
      const display = math.classList.contains('display');
      let tex = (math.textContent ?? '').replace(/^\\[([]|\\[)\]]$/g, '');
      const labels = [...tex.matchAll(/\\label\{([^{}]+)\}/g)];
      tex = tex
        .replace(/\\label\{[^{}]+\}/g, '')
        .replace(/\\(?:begin|end)\{equation\*?\}/g, '')
        .replace(/\{align\*?\}/g, '{aligned}')
        .replace(/\{gather\*?\}/g, '{gathered}');
      katex.render(tex, math, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      });
      for (const label of labels) {
        const key = label[1]!;
        const anchor = document.createElement('span');
        anchor.id = key;
        math.prepend(anchor);
        numbers[key] ??= String(++nextNumber);
        const number = document.createElement('span');
        number.className = 'reading-equation-number';
        number.textContent = `(${numbers[key]})`;
        math.append(number);
      }
      if (display) {
        math.tabIndex = 0;
        math.setAttribute('aria-label', 'Equation');
      }
    }
    for (const link of document.querySelectorAll('a')) {
      const href = link.getAttribute('href') ?? '';
      const number = numbers[href.slice(1)];
      if (href.startsWith('#') && number && link.hasAttribute('data-reference-type'))
        link.textContent =
          link.getAttribute('data-reference-type') === 'eqref' ? `(${number})` : number;
      if (/^https?:\/\//.test(href)) {
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } else if (!href.startsWith('#')) link.removeAttribute('href');
    }
    return document.body.innerHTML;
  }, [id, reading.html, reading.labels]);
  useLayoutEffect(() => {
    const element = scroll.current!;
    const key = `swa:reading:${apiScope()}:${id}`;
    try {
      element.scrollTop = Number(localStorage.getItem(key)) || 0;
    } catch {
      /* private storage */
    }
    return () => {
      try {
        localStorage.setItem(key, String(element.scrollTop));
      } catch {
        /* private storage */
      }
    };
  }, [id, html]);
  return (
    <div
      ref={scroll}
      className="document-reading-scroll"
      aria-label="Reading pages"
      tabIndex={0}
      onTouchStart={(event) => {
        const point = event.touches[0];
        if (!point || event.touches.length !== 1) return;
        touch.current = {
          x: point.clientX,
          y: point.clientY,
          equation: !!(event.target as Element).closest('.math'),
        };
      }}
      onTouchEnd={(event) => {
        const start = touch.current;
        touch.current = null;
        const point = event.changedTouches[0];
        if (
          start &&
          point &&
          !start.equation &&
          point.clientX - start.x > 110 &&
          Math.abs(point.clientY - start.y) < 65
        )
          close();
      }}
      onClick={(event) => {
        const target = (event.target as Element).closest('a');
        const href = target?.getAttribute('href');
        if (href?.startsWith('#')) {
          event.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const destination = [...scroll.current!.querySelectorAll('[id]')].find(
            (node) => node.id === id,
          );
          destination?.scrollIntoView({ block: 'start' });
        }
      }}
    >
      {reading.warnings.length > 0 && (
        <details className="reading-notes">
          <summary>Conversion notes</summary>
          {reading.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
      <article
        className="document-reading"
        style={{ '--reading-size': `${size}px` } as CSSProperties}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
