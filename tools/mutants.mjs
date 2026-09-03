#!/usr/bin/env node
// How many of these tests actually bite?
//
// A suite that passes proves the code does what the suite says. It does not
// prove the suite says anything. Mutation testing answers the second question:
// change the code in a way that must break something, and see whether anything
// breaks. The score is the share of those changes the suite catches.
//
//   npm run mutants              the protocol core
//   FILES=concord/ladder.mjs npm run mutants
//
// Deliberately small and readable rather than a framework. Each operator below
// is a mistake somebody could actually make -- an inverted comparison, a
// dropped guard, an off-by-one, a swallowed error -- not a random byte flip,
// because a survivor is only interesting if it names a real gap.

import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FILES = (process.env.FILES ?? [
  'concord/ladder.mjs',
  'concord/saga.mjs',
  'concord/receipt.mjs',
  'concord/recover.mjs',
  'kit/canonical.mjs',
].join(',')).split(',');

/**
 * The mutations. Each is a plausible mistake, and each must be caught.
 *
 * `skip` marks text that is not code -- a comment, or a string somebody
 * greps for -- because mutating prose produces survivors that mean nothing.
 */
const OPERATORS = [
  { name: 'flip <=', find: /([^<>=!])<=/g, to: '$1<' },
  { name: 'flip >=', find: /([^<>=!])>=/g, to: '$1>' },
  { name: 'flip <', find: /([^<>=!])<([^=])/g, to: '$1<=$2' },
  { name: 'flip ===', find: /===/g, to: '!==' },
  { name: 'flip !==', find: /!==/g, to: '===' },
  { name: 'flip &&', find: / && /g, to: ' || ' },
  { name: 'drop a negation', find: /\(!([a-zA-Z_$][\w.$?]*)\)/g, to: '($1)' },
  { name: 'off by one', find: /([\w.$\]]) \+ 1\b/g, to: '$1 + 2' },
  { name: 'empty a guard', find: /if \(([a-zA-Z_$][\w.$?]*\.length)\) /g, to: 'if (false && $1) ' },
];

const isCode = (line) => {
  const t = line.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
};

async function suitePasses() {
  try {
    await run('npm', ['test'], { timeout: 180_000, maxBuffer: 1 << 24 });
    return true;
  } catch { return false; }
}

const results = [];
console.log('  building the mutant list…');

for (const file of FILES) {
  const original = await readFile(file, 'utf8');
  const lines = original.split('\n');

  for (const op of OPERATORS) {
    for (let i = 0; i < lines.length; i++) {
      if (!isCode(lines[i])) continue;
      op.find.lastIndex = 0;
      if (!op.find.test(lines[i])) continue;
      op.find.lastIndex = 0;
      const mutated = lines[i].replace(op.find, op.to);
      if (mutated === lines[i]) continue;
      results.push({ file, line: i + 1, op: op.name, original, mutated, lines });
    }
  }
}

// A full run of every mutant is minutes per file. SAMPLE keeps the default
// honest about what it measured rather than quietly checking a handful.
const SAMPLE = Number(process.env.SAMPLE ?? 60);
const chosen = results.length > SAMPLE
  ? results.filter((_, i) => i % Math.ceil(results.length / SAMPLE) === 0)
  : results;

console.log(`  ${results.length} mutants possible, running ${chosen.length}\n`);

// The originals, in memory, restored unconditionally.
//
// The first version copied each file to a sidecar and copied it back, and left
// the last mutant applied to kit/canonical.mjs -- a tool that edits source and
// does not put it back exactly is worse than no tool, because the next thing
// you run is testing something you did not write. There is now one restore
// path, it runs in a finally, and it runs again on exit however the process
// ends.
const ORIGINALS = new Map();
for (const file of FILES) ORIGINALS.set(file, await readFile(file, 'utf8'));

const restoreAll = () => {
  for (const [file, text] of ORIGINALS) {
    try { writeFileSync(file, text); } catch { /* nothing further to try */ }
  }
};
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

let killed = 0;
const survivors = [];
for (const [n, m] of chosen.entries()) {
  const patched = [...m.lines];
  patched[m.line - 1] = m.mutated;
  let passed;
  try {
    await writeFile(m.file, patched.join('\n'));
    passed = await suitePasses();
  } finally {
    await writeFile(m.file, ORIGINALS.get(m.file));
  }

  if (passed) {
    survivors.push(m);
    console.log(`  survived  ${m.file}:${m.line}  ${m.op}`);
    console.log(`            ${m.mutated.trim().slice(0, 96)}`);
  } else killed++;
  if ((n + 1) % 10 === 0) console.log(`  … ${n + 1}/${chosen.length}`);
}

restoreAll();
// Say so, rather than assuming it. A silent restore that did not happen is the
// failure this whole block exists to prevent.
for (const [file, text] of ORIGINALS) {
  if (await readFile(file, 'utf8') !== text) {
    console.error(`  ! ${file} was not restored — check it before committing`);
    process.exitCode = 2;
  }
}

const score = chosen.length ? Math.round((killed / chosen.length) * 100) : 0;
console.log(`\n  ${killed} of ${chosen.length} mutants killed — ${score}%`);
if (survivors.length) {
  console.log('\n  Survivors are gaps in the tests, not necessarily bugs in the code.');
}
await writeFile('evidence/mutation.txt',
  `mutation score: ${score}% (${killed}/${chosen.length} of ${results.length} possible)\n`
  + `files: ${FILES.join(', ')}\n`
  + `at: ${new Date().toISOString()}\n\n`
  + survivors.map((s) => `survived ${s.file}:${s.line} ${s.op}\n  ${s.mutated.trim()}`).join('\n'))
  .catch(() => {});
process.exit(0);
