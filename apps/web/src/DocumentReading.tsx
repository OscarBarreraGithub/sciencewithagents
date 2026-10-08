import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import {
  readingMathParts,
  stripLatexCommand,
  type DocumentReadingResponse as Reading,
} from '@dock/shared';
import { apiScope, apiUrl } from './api';
import 'katex/dist/katex.min.css';

export function DocumentReading({
  id,
  reading,
  size,
  close,
  endpoint = `/documents/${id}`,
}: {
  id: string;
  endpoint?: string;
  reading: Reading;
  size: number;
  close: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; equation: boolean } | null>(null);
  const html = useMemo(() => {
    const source = reading.html.replace(
      /reader-asset:([a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif))/g,
      (_, asset: string) => apiUrl(`${endpoint}/assets/${asset}`),
    );
    const clean = DOMPurify.sanitize(source, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'embed', 'object', 'audio', 'video'],
      FORBID_ATTR: ['style', 'srcset', 'name'],
    });
    const document = new DOMParser().parseFromString(clean, 'text/html');
    for (const image of document.querySelectorAll('img')) {
      const src = image.getAttribute('src') ?? '';
      if (!src.startsWith(apiUrl(`${endpoint}/assets/`))) image.remove();
    }
    const numbers = { ...reading.labels };
    let nextNumber = 0;
    let wraps = 0;
    const references: { element: HTMLElement; tex: string; display: boolean; number?: string }[] =
      [];
    for (const original of document.querySelectorAll<HTMLElement>('.math')) {
      const display = original.classList.contains('display');
      const source = (original.textContent ?? '').replace(/^\\[([]|\\[)\]]$/g, '');
      const parts = display
        ? readingMathParts(source)
        : [{ tex: source, labels: [], tag: undefined, numbered: false }];
      for (const part of parts) {
        const math = document.createElement('span');
        math.className = original.className;
        original.before(math);
        let number = part.tag;
        if (part.numbered) number = String(++nextNumber);
        for (const key of part.labels) {
          if (numbers[key]) number = numbers[key];
          else if (number !== undefined) numbers[key] = number;
          const anchor = document.createElement('span');
          anchor.id = key;
          math.before(anchor);
        }
        if (number && /^\d+$/.test(number)) nextNumber = Math.max(nextNumber, Number(number));
        let tex = part.tex
          .replace(/\\(?:begin|end)\{equation\*?\}/g, '')
          .replace(/\{align\*?\}/g, '{aligned}')
          .replace(/\{gather\*?\}/g, '{gathered}');
        if (display) {
          const wrap = document.createElement('span');
          wrap.className = 'reading-math-wrap';
          math.replaceWith(wrap);
          wrap.append(math);
          math.setAttribute('role', 'region');
          math.setAttribute('aria-label', number ? `Equation ${number}` : 'Equation');
          const hint = document.createElement('span');
          hint.className = 'reading-overflow-hint';
          hint.id = `equation-overflow-${wraps++}`;
          hint.hidden = true;
          math.setAttribute('aria-describedby', hint.id);
          wrap.append(hint);
        }
        references.push({ element: math, tex: stripLatexCommand(tex, 'tag'), display, number });
      }
      original.remove();
    }
    for (const { element, tex, display, number } of references) {
      const resolved = tex.replace(
        /\\(eqref|ref)\{([^{}]+)\}/g,
        (match, type: string, key: string) => {
          const value = numbers[key]?.replace(/^\$|\$$/g, '');
          return value ? (type === 'eqref' ? `(${value})` : value) : match;
        },
      );
      const content = document.createElement('span');
      content.className = 'reading-equation-content';
      const formula = document.createElement('span');
      content.append(formula);
      katex.render(resolved, formula, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      });
      if (display && number !== undefined) {
        const tag = document.createElement('span');
        tag.className = 'reading-equation-number';
        katex.render(`(${number.replace(/^\$|\$$/g, '')})`, tag, {
          throwOnError: false,
          trust: false,
          strict: 'ignore',
        });
        content.append(tag);
      }
      element.append(content);
    }
    for (const link of document.querySelectorAll('a')) {
      const href = link.getAttribute('href') ?? '';
      const number = numbers[href.slice(1)];
      if (href.startsWith('#') && number && link.hasAttribute('data-reference-type')) {
        const value = number.replace(/^\$|\$$/g, '');
        katex.render(
          link.getAttribute('data-reference-type') === 'eqref' ? `(${value})` : value,
          link,
          { throwOnError: false, trust: false },
        );
      }
      if (/^https?:\/\//.test(href)) {
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } else if (!href.startsWith('#')) link.removeAttribute('href');
    }
    for (const table of document.querySelectorAll('table')) {
      for (const cell of table.querySelectorAll('td'))
        if (
          /^[+−\-]?[\d.,]+(?:\s*[eE][+−\-]?\d+)?(?:\s*[%°])?$/.test(cell.textContent?.trim() ?? '')
        )
          cell.classList.add('reading-numeric');
      const wrap = document.createElement('div');
      wrap.className = 'reading-math-wrap';
      const area = document.createElement('div');
      area.className = 'reading-table-scroll';
      table.replaceWith(wrap);
      area.append(table);
      wrap.append(area);
      const hint = document.createElement('span');
      hint.className = 'reading-overflow-hint';
      hint.hidden = true;
      hint.id = `equation-overflow-${wraps++}`;
      area.setAttribute('role', 'region');
      area.setAttribute('aria-label', 'Table');
      area.setAttribute('aria-describedby', hint.id);
      wrap.append(hint);
    }
    return document.body.innerHTML;
  }, [id, endpoint, reading.html, reading.labels]);
  // React 19 re-applies dangerouslySetInnerHTML whenever its object changes, so an inline
  // object would rebuild the whole document (and reset equation scroll positions and overflow
  // cues) on every parent render, such as each poll during a rebuild.
  const markup = useMemo(() => ({ __html: html }), [html]);
  useLayoutEffect(() => {
    const element = scroll.current!;
    const key = `swa:reading:${apiScope()}:${endpoint}`;
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
  }, [id, endpoint, html]);
  useEffect(() => {
    const root = scroll.current!;
    const equations = [
      ...root.querySelectorAll<HTMLElement>('.math.display, .reading-table-scroll'),
    ];
    let disposed = false;
    // Each pass reads every geometry it needs before writing, and writes only changes, so a pass
    // costs at most two layouts however many equations it covers. (Interleaving reads and writes
    // forced one layout per equation: hundreds of milliseconds per scroll event on a phone.)
    const hint = (equation: HTMLElement) =>
      equation.parentElement!.querySelector<HTMLElement>(':scope > .reading-overflow-hint')!;
    const cue = (equation: HTMLElement) => {
      const { scrollLeft, scrollWidth, clientWidth } = equation;
      const wide = scrollWidth > clientWidth + 3;
      const left = scrollLeft > 3;
      const right = scrollLeft + clientWidth < scrollWidth - 3;
      const label = equation.classList.contains('reading-table-scroll') ? 'table' : 'equation';
      return {
        equation,
        wide,
        text: left && right ? `← More ${label} →` : left ? `← More ${label}` : `More ${label} →`,
      };
    };
    const show = ({ equation, wide, text }: ReturnType<typeof cue>) => {
      const element = hint(equation);
      if (element.hidden === wide) element.hidden = !wide;
      if (element.textContent !== text) element.textContent = text;
      if (equation.tabIndex !== (wide ? 0 : -1)) equation.tabIndex = wide ? 0 : -1;
      equation.parentElement!.classList.toggle('has-overflow', wide);
    };
    const update = (targets: Iterable<HTMLElement>) => {
      if (disposed) return;
      const stacks = [];
      for (const equation of targets) {
        const content = equation.querySelector<HTMLElement>('.reading-equation-content');
        const formula = content?.firstElementChild as HTMLElement | null;
        const number = content?.querySelector<HTMLElement>('.reading-equation-number');
        if (content && formula && number)
          stacks.push({
            content,
            stack:
              formula.scrollWidth +
                number.scrollWidth +
                parseFloat(getComputedStyle(equation).fontSize) >
              equation.clientWidth,
          });
      }
      for (const { content, stack } of stacks) content.classList.toggle('stack-number', stack);
      const cues = [...targets].map(cue);
      for (const item of cues) show(item);
    };
    // Observe each scroller and its content: late KaTeX fonts widen the content only.
    const owner = new Map<Element, HTMLElement>();
    for (const equation of equations) {
      owner.set(equation, equation);
      const content = equation.querySelector('.reading-equation-content, table');
      if (content) owner.set(content, equation);
    }
    const resize = new ResizeObserver((entries) =>
      update(new Set(entries.map((entry) => owner.get(entry.target)!))),
    );
    const scrolled = (event: Event) => {
      if (!disposed) show(cue(event.currentTarget as HTMLElement));
    };
    for (const [element, equation] of owner) {
      resize.observe(element);
      if (element === equation) equation.addEventListener('scroll', scrolled, { passive: true });
    }
    update(equations);
    void document.fonts.ready.then(() => update(equations));
    return () => {
      disposed = true;
      resize.disconnect();
      for (const equation of equations) equation.removeEventListener('scroll', scrolled);
    };
  }, [html, size]);
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
          equation: !!(event.target as Element).closest('.math, .reading-table-scroll'),
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
        dangerouslySetInnerHTML={markup}
      />
    </div>
  );
}
