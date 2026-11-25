import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(directory, '../../lib/persona-portrait.js');
const result = await build({ entryPoints: [path.join(directory, 'portrait-entry.mjs')], bundle: true, write: false,
  platform: 'browser', format: 'iife', globalName: 'TreadwayPersonaPortrait', minify: true,
  banner: { js: '// GENERATED from pinned DiceBear Lorelei by tools/personas/build-portrait.mjs; do not edit.' },
  footer: { js: 'globalThis.TreadwayPersonaPortrait = TreadwayPersonaPortrait; if (typeof module !== "undefined" && module.exports) module.exports = TreadwayPersonaPortrait;' } });
const text = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== text) throw new Error('Portrait bundle differs; run node recorder/tools/personas/build-portrait.mjs');
} else fs.writeFileSync(destination, text);
