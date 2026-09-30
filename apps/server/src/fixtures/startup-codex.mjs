#!/usr/bin/env node
// Disposable executable: records attempted provider activity and never runs a model.
import { appendFileSync } from 'node:fs';
appendFileSync(
  process.env.DOCK_STARTUP_CALLS,
  JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n',
);
if (process.argv[2] === '--version') {
  await new Promise((done) => setTimeout(done, Number(process.env.DOCK_STARTUP_DELAY ?? 0)));
  console.log('codex startup fixture');
} else {
  process.exitCode = 1;
}
