import { afterEach, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
import { openProjectEditor } from './project-editor.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  execFile.mockReset();
});

it.each(['darwin', 'linux'])(
  'opens the registered folder without replacing an active workspace on %s',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
    const folder = '/registered/project with spaces';
    await openProjectEditor(folder);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      platform === 'darwin' ? '/usr/bin/open' : 'code',
      platform === 'darwin'
        ? ['-n', '-b', 'com.microsoft.VSCode', '--args', '--new-window', folder]
        : ['--new-window', folder],
      { timeout: 10_000, maxBuffer: 16_384 },
      expect.any(Function),
    );
  },
);

it('reports an unavailable editor without launching another executable', async () => {
  execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('Missing editor')),
  );
  await expect(openProjectEditor('/registered/project')).rejects.toThrow('VS Code could not open');
  expect(execFile).toHaveBeenCalledTimes(1);
});
