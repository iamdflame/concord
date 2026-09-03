#!/usr/bin/env node
// The README, checked against the repository.
//
// Documentation drifts silently: a port changes, a script is renamed, a section
// is inserted and every §number after it shifts by one. Each of those is a
// reader following an instruction that does not work, which is worse than no
// instruction. All of it is mechanically checkable, so it is checked.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ORIGINS, VENDORS } from '../config.mjs';

const md = readFileSync('README.md', 'utf8');
const spec = readFileSync('SPEC.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];
const want = (ok, why) => { if (!ok) problems.push(why); };

// Links and images that point at this repository must resolve.
for (const [, target] of md.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
  const file = target.split('#')[0];
  want(!file || existsSync(file), `broken link: ${target}`);
}
for (const [, src] of md.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
  want(src.startsWith('http') || existsSync(src), `broken image: ${src}`);
}

// Anything it tells you to run has to be runnable.
for (const [, name] of md.matchAll(/npm (?:run )?([a-z:0-9]+)/g)) {
  want(name === 'test' || name in pkg.scripts, `no such script: npm run ${name}`);
}

// Ports come from the origin table, and the table is the only place they live.
for (const [id, url] of Object.entries(ORIGINS)) {
  if (id === 'app') continue;
  want(md.includes(`:${new URL(url).port}`), `${id} runs on :${new URL(url).port}, unmentioned`);
}

// Counts stated in words, checked against the thing they count.
const WORDS = {
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
};
const stated = (re) => WORDS[md.match(re)?.[1]?.toLowerCase()];
want(stated(/(\w+) independent businesses/) === VENDORS.length,
  `the README claims a different number of participants than config.mjs has (${VENDORS.length})`);
want(stated(/(\w+) origins: the coordinator/) === Object.keys(ORIGINS).length + 3,
  `the dev server runs ${Object.keys(ORIGINS).length + 3} origins; the README says otherwise`);
want(stated(/there is an? (\w+) origin,/) === Object.keys(ORIGINS).length,
  `the verifier is origin number ${Object.keys(ORIGINS).length}; the README says otherwise`);

// The assertion count, from the suite itself.
const out = execFileSync('npm', ['test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const passing = out.match(/^. pass (\d+)/m)?.[1];
const claimed = md.match(/\*\*(\d+) assertions with no browser\*\*/)?.[1];
want(passing && claimed === passing,
  `the README says ${claimed} assertions; the suite reports ${passing}`);

// Every SPEC section cited anywhere exists.
//
// Inserting a section shifts every number after it, and the citations live in
// four files and a source comment. That has now silently gone wrong three
// times, each time in a different file, which is exactly the kind of drift
// worth spending twelve lines to make impossible.
const CITING = ['README.md', 'SUBMISSION.md', 'THREAT-MODEL.md', 'concord/receipt.mjs'];
for (const file of CITING) {
  const text = readFileSync(file, 'utf8');
  for (const [, n] of text.matchAll(/§(\d+)/g)) {
    want(spec.includes(`\n## ${n}. `), `${file} cites SPEC §${n}, which does not exist`);
  }
}


for (const p of problems) console.log(`  ✗ ${p}`);
console.log(problems.length ? `README FAILED — ${problems.length}` : '  ✓ the README describes this repository');
process.exit(problems.length ? 1 : 0);
