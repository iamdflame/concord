#!/usr/bin/env node
// Fire every forgery at the verifier and report which ones it lets through.
//
//   npm run attacks
//
// Exit code is the number of attacks that succeeded. Zero is the only
// acceptable answer for a project whose pitch is that a receipt can be checked
// by somebody who trusts neither party. The same list runs in a browser at
// /attack.html, from the same module, so the page and the build cannot drift.

import { verifyReceipt } from '../concord/receipt.mjs';
import { ATTACKS, honestReceipt } from './browser.mjs';

const honest = await honestReceipt();

// The control. If this fails, the harness is wrong, not the verifier, and
// "all attacks rejected" would be the same kind of lie they are looking for.
const control = await verifyReceipt(honest.receipt, honest.resolve);
console.log(`\n  control: an honest receipt ${control.ok ? 'verifies' : 'FAILS — the harness is broken'}`);
if (!control.ok) { console.log(control.complaints.join('\n')); process.exit(2); }

let through = 0;
console.log(`\n  ${ATTACKS.length} attacks\n`);
for (const { name, why, run } of ATTACKS) {
  const v = await run(honest);
  const stopped = !v.ok;
  if (!stopped) through++;
  console.log(`  ${stopped ? '\u2713 rejected' : '\u2717 ACCEPTED'}  ${name}`);
  if (!stopped) console.log(`               ${why}`);
  else if (process.env.VERBOSE) console.log(`               ${(v.complaints[0] ?? '').slice(0, 96)}`);
}

console.log(through
  ? `\n${through} of ${ATTACKS.length} attacks were accepted by the verifier.`
  : `\nAll ${ATTACKS.length} attacks rejected.`);
process.exit(through);
