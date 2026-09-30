// Export every sciencewithagents icon from the owner's original heldalive vector.
// Artwork is copied, not redrawn. Preview/export files stay under ignored data/.
import { readFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const exec = promisify(execFile);
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'apps/web/public/dock.svg');
const vector = await readFile(source, 'utf8');
await copyFile(source, join(root, 'site/assets/favicon.svg'));
await mkdir(join(root, 'data'), { recursive: true });
const temporary = await mkdtemp(join(root, 'data/brand-export-'));
const iconset = join(temporary, 'sciencewithagents.iconset');
await mkdir(iconset);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size, path, desktop = false) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:transparent}main{width:100%;height:100%;display:grid;place-items:center;background:#f6f5f2;${desktop ? 'border-radius:22%;' : ''}}svg{display:block;width:80%;height:80%}</style><main>${vector}</main>`,
    );
    await page.screenshot({ path, omitBackground: true });
  };
  for (const size of [180, 192, 512])
    await render(size, join(root, `apps/web/public/dock-${size}.png`));
  await render(128, join(root, 'apps/vscode-mirror/icon.png'));
  if (process.platform === 'darwin') {
    for (const size of [16, 32, 128, 256, 512]) {
      await render(size, join(iconset, `icon_${size}x${size}.png`), true);
      await render(size * 2, join(iconset, `icon_${size}x${size}@2x.png`), true);
    }
    await mkdir(join(root, 'assets/branding'), { recursive: true });
    await exec('/usr/bin/iconutil', [
      '-c',
      'icns',
      iconset,
      '-o',
      join(root, 'assets/branding/sciencewithagents.icns'),
    ]);
  }
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
