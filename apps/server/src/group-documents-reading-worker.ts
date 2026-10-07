import { buildReading } from './document-reading.js';
// Host-selected private staging paths only; this entry point is never a browser/provider tool.
const [source, root, assets] = process.argv.slice(2);
if (!source || !root || !assets) throw new Error('Scoped reading paths required.');
process.stdout.write(JSON.stringify(await buildReading(source, root, assets)));
