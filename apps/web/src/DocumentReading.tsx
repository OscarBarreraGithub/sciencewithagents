import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import {
  readingMathParts,
  stripLatexCommand,
  type DocumentReadingResponse as Reading,
} from '@dock/shared';
import { apiScope, apiUrl } from './api';
import { readingEqualityLayout } from './readingMathLayout';
import { prepareReadingTable } from './readingTableLayout';
import 'katex/dist/katex.min.css';

export function DocumentReading({
  id,
  reading,
  size,
  close,
  endpoint = `/documents/${id}`,
  onOverflow,
}: {
  id: string;
  endpoint?: string;
  reading: Reading;
  size: number;
  close: () => void;
  onOverflow?: (wide: boolean) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; equation: boolean } | null>(null);
  const overflowRef = useRef(onOverflow);
  overflowRef.current = onOverflow;
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
        macros: { ...reading.macros },
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      });
      const candidate = display && readingEqualityLayout(resolved);
      if (candidate && !formula.querySelector('.katex-error')) {
        const original = document.createElement('span');
        original.className = 'reading-equation-original';
        original.append(...formula.childNodes);
        const wrapped = document.createElement('span');
        wrapped.className = 'reading-equation-wrapped';
        wrapped.hidden = true;
        katex.render(candidate, wrapped, {
          displayMode: true,
          throwOnError: false,
          trust: false,
          macros: { ...reading.macros },
          strict: 'ignore',
          maxExpand: 1000,
          maxSize: 20,
        });
        if (wrapped.querySelector('.katex-error')) formula.append(...original.childNodes);
        else formula.append(original, wrapped);
      }
      if (display && number !== undefined) {
        const tag = document.createElement('span');
        tag.className = 'reading-equation-number';
        katex.render(`(${number.replace(/^\$|\$$/g, '')})`, tag, {
          throwOnError: false,
          trust: false,
          macros: { ...reading.macros },
          strict: 'ignore',
          maxExpand: 1000,
          maxSize: 20,
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
          { throwOnError: false, trust: false, macros: { ...reading.macros }, maxExpand: 1000 },
        );
      }
      if (/^https?:\/\//.test(href)) {
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } else if (!href.startsWith('#')) link.removeAttribute('href');
    }
    let tableIndex = 0;
    for (const table of document.querySelectorAll('table')) {
      for (const cell of table.querySelectorAll('td'))
        if (
          /^[+−\-]?[\d.,]+(?:\s*[eE][+−\-]?\d+)?(?:\s*[%°])?$/.test(cell.textContent?.trim() ?? '')
        )
          cell.classList.add('reading-numeric');
      prepareReadingTable(table, `reading-table-column-${tableIndex++}`);
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
  }, [id, endpoint, reading.html, reading.labels, reading.macros]);
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
    let frame = 0;
    let settled: ReturnType<typeof setTimeout> | undefined;
    let fontsReady = false;
    const pending = new Set<HTMLElement>();
    // Batch geometry reads before each stage's writes: relation layout, number placement,
    // then overflow cues. Never alternate reads/writes once per equation.
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
      // Measure original table layout in batches before choosing cards. A narrow table
      // that already fits stays a table, including after text-size or column changes.
      const tables = [...targets].flatMap((area) => {
        const table = area.querySelector<HTMLElement>(':scope > table.reading-card-table');
        return table ? [{ area, table }] : [];
      });
      for (const { table } of tables) table.classList.remove('reading-card-active');
      const cards = tables.map(({ area, table }) => ({
        table,
        active: area.clientWidth < 600 && table.scrollWidth > area.clientWidth + 3,
      }));
      for (const { table, active } of cards) table.classList.toggle('reading-card-active', active);
      const layouts = [];
      for (const equation of targets) {
        const original = equation.querySelector<HTMLElement>('.reading-equation-original');
        const wrapped = equation.querySelector<HTMLElement>('.reading-equation-wrapped');
        const natural = original?.querySelector<HTMLElement>('.katex');
        if (original && wrapped && natural)
          layouts.push({
            original,
            wrapped,
            reflow: natural.getBoundingClientRect().width > equation.clientWidth + 3,
          });
      }
      for (const { original, wrapped, reflow } of layouts) {
        original.classList.toggle('reading-equation-clipped', reflow);
        original.setAttribute('aria-hidden', String(reflow));
        wrapped.hidden = !reflow;
      }
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
      if (fontsReady && overflowRef.current) {
        clearTimeout(settled);
        settled = setTimeout(() => {
          if (!disposed && root.clientWidth > 0)
            overflowRef.current?.(
              equations.some(
                (equation) =>
                  equation.classList.contains('display') &&
                  equation.scrollWidth > equation.clientWidth + 3,
              ),
            );
        }, 500);
      }
    };
    // Observe each scroller and its content: late KaTeX fonts widen the content only.
    const owner = new Map<Element, HTMLElement>();
    for (const equation of equations) {
      owner.set(equation, equation);
      const content = equation.querySelector('.reading-equation-content, table');
      if (content) owner.set(content, equation);
    }
    const schedule = (targets: Iterable<HTMLElement>) => {
      for (const target of targets) pending.add(target);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const targets = [...pending];
          pending.clear();
          update(targets);
        });
    };
    const resize = new ResizeObserver((entries) =>
      schedule(new Set(entries.map((entry) => owner.get(entry.target)!))),
    );
    const scrolled = (event: Event) => {
      if (!disposed) show(cue(event.currentTarget as HTMLElement));
    };
    for (const [element, equation] of owner) {
      resize.observe(element);
      if (element === equation) equation.addEventListener('scroll', scrolled, { passive: true });
    }
    update(equations);
    void document.fonts.ready.then(() => {
      fontsReady = true;
      if (!disposed) schedule(equations);
    });
    return () => {
      disposed = true;
      clearTimeout(settled);
      overflowRef.current?.(false);
      cancelAnimationFrame(frame);
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
