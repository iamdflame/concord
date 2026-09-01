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

const receipt = JSON.parse(await readFile(file, 'utf8'));

console.log(`receipt   ${file}`);
console.log(`saga      ${receipt.sagaId}   ${receipt.outcome}`);
console.log(`issued    ${receipt.at}`);
console.log(`root      ${receipt.root}\n`);

for (const [id, where] of Object.entries(receipt.vendors ?? {})) {
  console.log(`  resolving ${id} → ${where.origin}/.well-known/concord.json`);
}
console.log('');

const out = await verifyReceipt(receipt, originResolver());

const w = Math.max(...out.findings.map((f) => (f.vendor ?? '').length), 6);
for (const f of out.findings) {
  if (f.why && !f.vendor) { console.log(`  ✗ ${f.why}`); continue; }
  const mark = f.ok ? '✓' : '✗';
  console.log(`  ${mark} ${(f.vendor ?? '').padEnd(w)}  ${(f.step ?? '').padEnd(11)}` +
    `in tree ${f.included ? 'yes' : 'NO '}   signed ${f.signed ? 'yes' : 'NO '}` +
    (f.why ? `   ${f.why}` : ''));
}

console.log(`\n${out.ok ? 'VERIFIED' : 'FAILS VERIFICATION'} — ` +
  `${out.findings.filter((f) => f.ok).length}/${out.findings.length} statements` +
  ' signed by the party named and provably part of this receipt.');

if (!out.ok) console.log('\nA failure here is a claim about a specific party, not a generic error:\n' +
  '  in tree NO   the statement was altered or was never part of this receipt\n' +
  '  signed  NO   the statement is in the receipt but that vendor never made it');

process.exit(out.ok ? 0 : 1);
