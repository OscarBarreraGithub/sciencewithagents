// Deterministically rasterize the existing vector mark; no generated artwork or cloud calls.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const vector = await readFile(new URL('../apps/web/public/dock.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [180, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>body{margin:0;background:#dc552f}svg{display:block;width:100vw;height:100vh}</style>${vector}`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`../apps/web/public/dock-${size}.png`, import.meta.url)),
    });
  }
} finally {
  await browser.close();
}
