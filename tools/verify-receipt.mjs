#!/usr/bin/env node
// Verify a Concord receipt with nothing but the file.
//
// This is the point of the whole design. A vendor in a dispute should not have
// to ask the coordinator whether the coordinator is honest. It runs this, which
// fetches each vendor's published key from that vendor's own origin, checks
// that every statement was signed by the party it is attributed to, and checks
// that every statement belongs to the stated root.
//
//   node tools/verify-receipt.mjs receipt.json
//
// Exits non-zero if anything fails to verify.

import { readFile } from 'node:fs/promises';
import { verifyReceipt, originResolver } from '../concord/receipt.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/verify-receipt.mjs <receipt.json>');
  process.exit(2);
}

// This is what a vendor in a dispute runs. It must never answer with a stack
// trace; a tool that crashes on a malformed receipt tells them nothing about
// the receipt.
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

console.log(`receipt   ${file}`);
console.log(`saga      ${receipt.sagaId}   ${receipt.outcome}`);
console.log(`issued    ${receipt.at}`);
console.log(`root      ${receipt.root}\n`);

for (const [id, where] of Object.entries(receipt.vendors ?? {})) {
  console.log(`  resolving ${id} → ${where.origin}/.well-known/concord.json`);
}
console.log('');

let out;
try {
  out = await verifyReceipt(receipt, originResolver());
} catch (err) {
  console.error(`could not complete verification: ${err.message}`);
  process.exit(2);
}

for (const complaint of out.complaints ?? []) console.log(`  ! ${complaint}`);
if (out.complaints?.length) console.log('');

const w = Math.max(...out.findings.map((f) => (f.vendor ?? '').length), 6);
for (const f of out.findings) {
  if (f.why && !f.vendor) { console.log(`  ✗ ${f.why}`); continue; }
  const mark = f.ok ? '✓' : '✗';
  console.log(`  ${mark} ${(f.vendor ?? '').padEnd(w)}  ${(f.step ?? '').padEnd(11)}` +
    `in tree ${f.included ? 'yes' : 'NO '}   signed ${f.signed ? 'yes' : 'NO '}` +
    `   key ${f.inForce === false ? 'NOT IN FORCE' : 'in force'}` +
    (f.why ? `\n        ${f.why}` : ''));
}

console.log(`\n${out.ok ? 'VERIFIED' : 'FAILS VERIFICATION'} — ` +
  `${out.findings.filter((f) => f.ok).length}/${out.findings.length} statements` +
  ' signed by the party named and provably part of this receipt.');

if (!out.ok) console.log('\nA failure here is a claim about a specific party, not a generic error:\n' +
  '  in tree NO         the statement was altered or was never part of this receipt\n' +
  '  signed NO          the statement is in the receipt but that vendor never made it\n' +
  '  key NOT IN FORCE   the signature checks out, but the key was not entitled to sign\n' +
  '                     at that moment -- retired, or reported stolen since before it');

process.exit(out.ok ? 0 : 1);
