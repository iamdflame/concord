#!/usr/bin/env node
// Verify a Concord receipt with nothing but the file.
//
// A vendor in a dispute should not have to ask the coordinator whether the
// coordinator is honest. This resolves each participant's key from that
// participant's own origin over TLS, checks every statement was signed by the
// party it names with a key that was in force at the time, and checks the
// receipt accounts for the whole commitment its participants signed up to.
//
//   npx concord-verify receipt.json
//   npx concord-verify receipt.json --explain
//
// Exits non-zero if anything fails.

import { readFile } from 'node:fs/promises';
import { verifyReceipt, originResolver } from './lib/receipt.mjs';

const args = process.argv.slice(2);
const explain = args.includes('--explain');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('usage: npx concord-verify <receipt.json> [--explain]');
  process.exit(2);
}

const say = (s = '') => console.log(s);
const step = (n, what) => { if (explain) say(`\n  [${n}] ${what}`); };

let receipt;
try {
  receipt = JSON.parse(await readFile(file, 'utf8'));
} catch (err) {
  console.error(err.code === 'ENOENT' ? `no such file: ${file}`
    : `${file} is not readable JSON: ${err.message}`);
  process.exit(2);
}

for (const [field, kind] of [['sagaId', 'string'], ['root', 'string'], ['entries', 'object']]) {
  if (typeof receipt?.[field] !== kind) {
    console.error(`${file} is not a Concord receipt: it has no ${field}`);
    process.exit(2);
  }
}
if (!Array.isArray(receipt.entries) || !receipt.entries.length) {
  console.error(`${file} contains no statements, so there is nothing to verify`);
  process.exit(2);
}

say(`receipt   ${file}`);
say(`saga      ${receipt.sagaId}   ${receipt.outcome}`);
say(`issued    ${receipt.at}`);
say(`root      ${receipt.root}`);

if (explain) {
  say('\nThe algorithm, as it runs. Every step is specified in SPEC.md §12.');
  step(1, 'Recompute the Merkle root from the statements in the file.');
  step(2, 'Reject any statement belonging to a different commitment.');
  step(3, 'Require every statement to agree on what the commitment was going to be.');
  step(4, 'Resolve each key from the origin the statement itself names — never from');
  say('      any mapping the coordinator wrote — and reject an origin that says it');
  say('      is somebody else.');
  step(5, 'Verify each signature over the canonical form of its statement.');
  step(6, 'Check the key was entitled to sign at the moment the statement is dated.');
  step(7, 'Check the receipt accounts for the whole commitment.');
}

say('');
for (const [id, where] of Object.entries(receipt.vendors ?? {})) {
  say(`  resolving ${id} → ${where.origin}/.well-known/concord.json`);
}
say('');

let out;
try {
  out = await verifyReceipt(receipt, originResolver());
} catch (err) {
  console.error(`could not complete verification: ${err.message}`);
  process.exit(2);
}

for (const complaint of out.complaints ?? []) say(`  ✗ ${complaint}`);
for (const note of out.notes ?? []) say(`  · ${note}`);
if (out.complaints?.length || out.notes?.length) say('');

const w = Math.max(...out.findings.map((f) => (f.vendor ?? '').length), 6);
for (const f of out.findings) {
  if (f.why && !f.vendor) { say(`  ✗ ${f.why}`); continue; }
  say(`  ${f.ok ? '✓' : '✗'} ${(f.vendor ?? '').padEnd(w)}  ${(f.step ?? '').padEnd(11)}`
    + `in tree ${f.included ? 'yes' : 'NO '}   signed ${f.signed ? 'yes' : 'NO '}`
    + `   key ${f.inForce === false ? 'NOT IN FORCE' : 'in force'}`
    + (f.why ? `\n        ${f.why}` : ''));
}

say(`\n${out.ok ? 'VERIFIED' : 'FAILS VERIFICATION'} — `
  + `${out.findings.filter((f) => f.ok).length}/${out.findings.length} statements`
  + ' signed by the party named and provably part of this receipt.');

if (!out.ok) say('\nA failure is a claim about a specific party, not a generic error:\n'
  + '  in tree NO         the statement was altered or was never part of this receipt\n'
  + '  signed NO          the statement is in the receipt but that vendor never made it\n'
  + '  key NOT IN FORCE   the signature checks out, but the key was not entitled to sign\n'
  + '                     at that moment — retired, or reported stolen since before it');

process.exit(out.ok ? 0 : 1);
