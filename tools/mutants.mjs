#!/usr/bin/env node
// How many of these tests actually bite?
//
// A suite that passes proves the code does what the suite says. It does not
// prove the suite says anything. Mutation testing answers the second question:
// change the code in a way that must break something, and see whether anything
// breaks. The score is the share of those changes the suite catches.
//
//   npm run mutants              every mutant in the protocol core (slow)
//   SAMPLE=40 npm run mutants     a quick, and therefore partial, read
//   FILES=concord/ladder.mjs npm run mutants
//
// Deliberately small and readable rather than a framework. Each operator below
// is a mistake somebody could actually make -- an inverted comparison, a
// dropped guard, an off-by-one, a swallowed error -- not a random byte flip,
// because a survivor is only interesting if it names a real gap.

import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';


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

/**
 * Run the suite against whatever is currently on disk.
 *
 * Spawned into its own process group and killed as a group on timeout.
 * execFile's own timeout signals the npm wrapper only, and npm does not pass
 * that on to the `node --test` it spawned -- so a mutant that makes a test hang
 * leaves an orphan holding a core for the rest of the run. Enough of those and
 * every later mutant is timed on a loaded machine, and the score becomes a
 * measurement of the runner rather than of the suite. This happened: two
 * orphans took the throughput from ten mutants a minute to ten every three.
 */
function suitePasses() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['test'], { stdio: 'ignore', detached: true });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      // Negative pid: the whole group, which is the `node --test` too.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      done(false);          // a suite that hangs has not passed
    }, 180_000);

    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
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

// Every mutant, by default.
//
// This used to sample 60 of them, and the sample was not random: it took every
// Nth entry from a list built file by file and operator by operator, which is a
// stratified sample of a sorted list. It reported 92% where the whole set gives
// 87%. A score from a sample of a sorted population is not a score, so the
// default is now everything and SAMPLE is opt-in for a quick local read.
const SAMPLE = Number(process.env.SAMPLE ?? Infinity);
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

/**
 * Survivors that have been looked at, and why they are still here.
 *
 * Keyed by the mutated line itself rather than by a line number, because line
 * numbers move and a note that silently reattaches itself to a different mutant
 * is worse than no note.
 *
 * The rule this encodes: a survivor that is NOT in this table is an unexamined
 * gap in the tests and should be treated as one. A survivor that IS here has
 * been argued about, and the argument is written down where the next person can
 * disagree with it. And an entry here whose mutant no longer survives is a
 * stale claim -- reported below, so it gets deleted.
 */
const EXAMINED = {
  "if (Date.now() - startedAt < sagaTimeoutMs) return;":
    'equivalent in practice. `<` against `<=` on elapsed milliseconds differs only '
    + 'when the elapsed time is exactly the deadline, which no test can arrange without '
    + 'an injectable clock. Injecting one would add a production parameter that exists '
    + 'only to be mocked; the behaviour either side of that instant is covered.',
  "if (left < 0) {":
    'equivalent in practice, same reason: a hold whose remaining time is exactly zero. '
    + 'Expiry either side of the instant is covered by concord/boundaries.test.mjs.',
  "if (left <= record.ttlSeconds * 1000 * 0.2) {":
    'equivalent in practice. This is the threshold for warning that a hold is expiring '
    + 'soon; the mutant moves it by one millisecond, and the warning is advisory.',
  "if (p > path.length) return false;":
    'equivalent. With `>` the walk reads one index past the end of the audit path, folds '
    + 'an undefined into the hash, and the result stops matching the root -- so a '
    + 'truncated proof is still refused, for a different reason. Checked rather than '
    + 'argued: 2,124 genuinely malformed proofs (every truncation, every over-length '
    + 'padding, and a reversed path, over trees of size 1 to 24) are refused identically '
    + 'by both versions. The length check stays, because failing for the right reason is '
    + 'worth one line.',
};

/** How each survivor was judged, for the report. */
const judged = survivors.map((m) => {
  const note = EXAMINED[m.mutated.trim()];
  return { ...m, note: note ?? null };
});
const unexamined = judged.filter((m) => !m.note);
const staleNotes = Object.keys(EXAMINED)
  .filter((k) => !survivors.some((m) => m.mutated.trim() === k));

const score = chosen.length ? Math.round((killed / chosen.length) * 100) : 0;
console.log(`\n  ${killed} of ${chosen.length} mutants killed — ${score}%`);
if (unexamined.length) {
  console.log(`\n  ${unexamined.length} unexamined survivor${unexamined.length === 1 ? '' : 's'} `
    + '— gaps in the tests, not necessarily bugs in the code:');
  for (const m of unexamined) console.log(`    ${m.file}:${m.line}  ${m.op}`);
}
if (judged.length - unexamined.length) {
  console.log(`\n  ${judged.length - unexamined.length} survivor(s) examined and documented `
    + 'in evidence/mutation.txt.');
}
for (const k of staleNotes) {
  console.log(`\n  NOTE IS STALE — this mutant no longer survives, so delete its entry `
    + `from EXAMINED in tools/mutants.mjs:\n    ${k}`);
}
await writeFile('evidence/mutation.txt',
  `mutation score: ${score}% (${killed}/${chosen.length} of ${results.length} possible)\n`
  + `files: ${FILES.join(', ')}\n`
  + `at: ${new Date().toISOString()}\n\n`
  + `${killed} killed, ${unexamined.length} unexamined, `
  + `${judged.length - unexamined.length} examined and documented below\n\n`
  + judged.map((m) => `survived ${m.file}:${m.line} ${m.op}\n  ${m.mutated.trim()}\n`
    + (m.note ? `  EXAMINED: ${m.note}\n` : '  UNEXAMINED: nothing has been said about this one yet.\n'))
    .join('\n'))
  .catch(() => {});
process.exit(0);
