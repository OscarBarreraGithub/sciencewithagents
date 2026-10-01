import { expect, type Page } from '@playwright/test';

export async function expectModelFormLayout(page: Page) {
  const issues = await page.locator('.model-settings').evaluate((form) => {
    const problems: string[] = [];
    const box = (selector: string) => form.querySelector(selector)!.getBoundingClientRect();
    const title = form.querySelector('h1')!.firstChild!;
    const range = document.createRange();
    for (const word of title.textContent!.matchAll(/\S+/g)) {
      range.setStart(title, word.index);
      range.setEnd(title, word.index + word[0].length);
      if (new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1)
        problems.push(`Heading word "${word[0]}" is split across lines`);
    }
    const providerRow = box('.model-enabled > div');
    if (providerRow.top - box('.model-enabled > p').bottom < 11)
      problems.push('Provider choices crowd the introduction');
    if (box('.model-enabled > p:last-child').top - providerRow.bottom < 11)
      problems.push('Provider choices crowd the save instructions');
    if (box('.config-form').top - box('.model-project-defaults > p').bottom < 11)
      problems.push('Project defaults crowd the introduction');
    for (const label of form.querySelectorAll('.model-enabled label')) {
      const check = label.querySelector('input')!.getBoundingClientRect();
      const text = label.querySelector('span')!.getBoundingClientRect();
      if (
        text.left - check.right < 7 ||
        Math.abs(check.y + check.height / 2 - text.y - text.height / 2) > 2
      )
        problems.push(`${label.textContent}: checkbox and name are not aligned side by side`);
    }
    for (const card of form.querySelectorAll('.config-section, .model-tier')) {
      const bounds = card.getBoundingClientRect();
      for (const field of card.querySelectorAll('select, input:not([type="range"])')) {
        if (!field.getClientRects().length) continue;
        const rect = field.getBoundingClientRect();
        if (rect.left < bounds.left + 10 || rect.right > bounds.right - 10)
          problems.push(
            `${field.getAttribute('aria-label') ?? field.parentElement?.textContent}: field reaches outside the card padding`,
          );
      }
    }
    return problems;
  });
  expect(issues, `Model form spacing at ${page.url()}`).toEqual([]);
}

/** Check inside controls, where clipping can be hidden by an otherwise fitting page. */
export async function expectSliderLayout(page: Page) {
  const problems = await page
    .locator('.config-slider, .quark-budget-slider')
    .evaluateAll((groups) => {
      const issues: string[] = [];
      const tolerance = 1.5;
      for (const group of groups) {
        const input = group.querySelector<HTMLInputElement>('input[type="range"]');
        if (!input || !input.getClientRects().length) continue;
        const name = input.getAttribute('aria-label') || group.textContent?.trim().slice(0, 60);
        const track = input.getBoundingClientRect();
        const bounds = group.getBoundingClientRect();
        const style = getComputedStyle(input);
        if (group.matches('.config-slider')) {
          const selected = group.querySelector('.config-stops .active');
          if (
            !selected?.getClientRects().length ||
            selected.textContent !== input.getAttribute('aria-valuetext')
          )
            issues.push(`${name}: current choice is not visibly labelled`);
        }
        // Native Safari ranges must not inherit text-input padding/borders: the thumb
        // otherwise stops short of the drawn track even at min/max.
        if (
          [
            'paddingLeft',
            'paddingRight',
            'paddingTop',
            'paddingBottom',
            'borderLeftWidth',
            'borderRightWidth',
          ].some((key) => parseFloat(style[key as keyof CSSStyleDeclaration] as string) > 0)
        )
          issues.push(`${name}: range inherits text-field padding or borders`);
        if (
          track.height < 44 ||
          track.left < bounds.left - tolerance ||
          track.right > bounds.right + tolerance
        )
          issues.push(`${name}: slider touch target does not fit its container`);
        const labels = [
          ...group.querySelectorAll<HTMLElement>(
            '.config-stops > span, .config-slider > span:first-child, .quark-budget-slider-heading > span, .quark-budget-slider-heading > strong',
          ),
        ];
        const fragments: { text: string; rect: DOMRect; owner: Element }[] = [];
        for (const label of labels) {
          if (!label.getClientRects().length) continue;
          const range = document.createRange();
          range.selectNodeContents(label);
          const cell = label.getBoundingClientRect();
          for (const rect of range.getClientRects()) {
            const text = label.textContent ?? '';
            if (
              rect.left < bounds.left - tolerance ||
              rect.right > bounds.right + tolerance ||
              rect.top < bounds.top - tolerance ||
              rect.bottom > bounds.bottom + tolerance ||
              rect.left < cell.left - tolerance ||
              rect.right > cell.right + tolerance
            )
              issues.push(`${name}: label "${text}" escapes its allocated space`);
            if (
              rect.left < track.right &&
              rect.right > track.left &&
              rect.top < track.bottom - tolerance &&
              rect.bottom > track.top + tolerance
            )
              issues.push(`${name}: label "${text}" overlaps the slider`);
            fragments.push({ text, rect, owner: label });
          }
          const words = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          for (let node = words.nextNode(); node; node = words.nextNode()) {
            for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              const lines = new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top)),
              );
              if (lines.size > 1) issues.push(`${name}: word "${match[0]}" is broken across lines`);
            }
          }
        }
        for (let i = 0; i < fragments.length; i++) {
          for (const other of fragments.slice(i + 1)) {
            const current = fragments[i]!;
            if (current.owner === other.owner) continue;
            if (
              Math.min(current.rect.right, other.rect.right) -
                Math.max(current.rect.left, other.rect.left) >
                tolerance &&
              Math.min(current.rect.bottom, other.rect.bottom) -
                Math.max(current.rect.top, other.rect.top) >
                tolerance
            )
              issues.push(`${name}: "${current.text}" overlaps "${other.text}"`);
          }
        }
      }
      return issues;
    });
  expect(problems, `Control layout at ${page.url()}`).toEqual([]);
}
