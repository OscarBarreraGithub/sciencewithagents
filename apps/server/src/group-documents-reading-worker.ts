import { buildReading, ReadingProblem } from './document-reading.js';
// Host-selected private staging paths only; this entry point is never a browser/provider tool.
const [source, root, assets] = process.argv.slice(2);
if (!source || !root || !assets) throw new Error('Scoped reading paths required.');
try {
  process.stdout.write(JSON.stringify(await buildReading(source, root, assets)));
} catch (error) {
  // The parent shows stderr to the reader: a sentence only, never a stack or a path.
  process.stderr.write(
    error instanceof ReadingProblem ? error.message : 'Reading conversion failed.',
  );
  process.exitCode = 1;
}
