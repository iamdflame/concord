// The ledger process. Read-only and reachable by nobody but the kernel, so it
// is the one origin in the composition that can never be the step that harms
// anyone -- it can only be the step that informs the one that does.

import { resolveModelContext } from '/shim/adapter.mjs';

const KERNEL = 'http://localhost:5173';
const { ctx } = await resolveModelContext();

const accounts = { acct_main: 184230, acct_ops: 9915 };
// settlement is the account this vendor is actually paid at, on record here
// and not taken from correspondence. It is what lets the kernel tell a real
// payee from one a forged email supplied.
const invoices = [
  { id: 'inv-4471', vendor: 'Supplier Ltd',  minor: 184230, due: '2026-09-11',
    status: 'open', settlement: 'acct_supplier' },
  { id: 'inv-4468', vendor: 'Cloud Hosting', minor: 24000,  due: '2026-08-30',
    status: 'paid', settlement: 'acct_hosting' },
];

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
    if (!(account in accounts)) throw new Error(`no such account: ${account}`);
    return { account, minor: accounts[account], currency: 'USD' };
  },
}, { exposedTo: [KERNEL] });

await ctx.registerTool({
  name: 'list_invoices',
  title: 'List invoices',
  description: 'Returns invoices, optionally filtered by status.',
  inputSchema: {
    type: 'object',
    properties: { status: { type: 'string', description: 'open or paid' } },
  },
  annotations: { readOnlyHint: true },
  async execute({ status }) {
    return { invoices: invoices.filter((i) => !status || i.status === status) };
  },
}, { exposedTo: [KERNEL] });

const usd = (minor) => `$${(minor / 100).toFixed(2)}`;

document.getElementById('origin').textContent = location.origin;
document.getElementById('accounts').innerHTML = Object.entries(accounts)
  .map(([id, minor]) => `<div class="row"><b>${id}</b><span class="num">${usd(minor)}</span></div>`).join('');
document.getElementById('invoices').innerHTML = invoices
  .map((i) => `<div class="row"><span><b>${i.id}</b> · ${i.vendor} → ${i.settlement}</span>` +
              `<span class="num ${i.status === 'open' ? 'neg' : 'pos'}">${usd(i.minor)} · ${i.status}</span></div>`).join('');
