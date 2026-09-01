#!/usr/bin/env node
// Assemble the publishable verifier from the source of truth.
//
// The package must be self-contained -- a verifier that needs the rest of this
// repository is not one a stranger can run -- but it must not be a second copy
// that drifts. It is generated, and CI regenerates it to check nothing moved.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
await mkdir(join(here, 'lib'), { recursive: true });

const banner = (from) =>
  `// Generated from ${from} by verify/build.mjs. Do not edit here.\n`
  + `// The source of truth lives in the Concord repository:\n`
  + `//   https://github.com/iamdflame/concord\n\n`;

for (const [from, to, fix] of [
  ['kit/canonical.mjs', 'lib/canonical.mjs', (s) => s],
  ['concord/receipt.mjs', 'lib/receipt.mjs', (s) => s.replace("'../kit/canonical.mjs'", "'./canonical.mjs'")],
]) {
  const src = await readFile(join(root, from), 'utf8');
  await writeFile(join(here, to), banner(from) + fix(src));
  console.log(`  ${to} ← ${from}`);
}
