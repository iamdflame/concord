// A process the kernel supervises. Registers two tools with deliberately
// different exposure, so Phase 01 can test the security boundary and not just
// the happy path.

import { resolveModelContext } from '/shim/adapter.mjs';

const KERNEL = 'http://localhost:5173';
const { ctx, provider, surface } = await resolveModelContext();

// Granted to the kernel. This is the call Phase 01 forwards.
await ctx.registerTool({
  name: 'get_balance',
  title: 'Get account balance',
  description: 'Returns the current balance of a ledger account in minor units.',
  inputSchema: {
    type: 'object',
    properties: { account: { type: 'string', description: 'Account identifier' } },
    required: ['account'],
  },
  annotations: { readOnlyHint: true },
  async execute({ account }) {
    const balances = { 'acct_main': 184230, 'acct_ops': 9915 };
    if (!(account in balances)) throw new Error(`no such account: ${account}`);
    return { account, minor: balances[account], currency: 'USD' };
  },
}, { exposedTo: [KERNEL] });

// Granted to nobody. The kernel must be unable to see or call this. If it can,
// the exposure model is not real and everything built on top of it is theatre.
await ctx.registerTool({
  name: 'private_note',
  title: 'Read internal note',
  description: 'Internal-only note that must never be visible to another origin.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  async execute() {
    return { note: 'CANARY-b7f3 — visible to this origin only' };
  },
});

document.getElementById('origin').textContent   = location.origin;
document.getElementById('ctx').textContent      = `${surface} · ${provider}`;
document.getElementById('exposed').textContent  = `get_balance → ${KERNEL}`;
document.getElementById('withheld').textContent = 'private_note → (nobody)';
