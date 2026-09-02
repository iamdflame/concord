// The payments process. This is the effect the whole kernel exists to stand in
// front of: one call, irreversible, and trivially easy for an agent to make.
//
// The UI updates the instant a transfer settles, because the human is meant to
// be watching the same surface the agent is driving. That is the property
// WebMCP is actually for -- the page stays present rather than being bypassed.

import { resolveModelContext } from '/shim/adapter.mjs';

const KERNEL = 'http://localhost:5173';
const { ctx } = await resolveModelContext();

const transfers = [];

await ctx.registerTool({
  name: 'send_funds',
  title: 'Send funds',
  description: 'Transfers funds to an account, in minor units. This cannot be reversed.',
  inputSchema: {
    type: 'object',
    properties: {
      to:    { type: 'string', description: 'Destination account' },
      minor: { type: 'number', description: 'Amount in minor units' },
      memo:  { type: 'string', description: 'Memo line' },
    },
    required: ['to', 'minor'],
  },
  annotations: { readOnlyHint: false },
  async execute({ to, minor, memo }) {
    const transfer = { to, minor, memo: memo ?? '', at: new Date().toISOString() };
    transfers.push(transfer);
    render();
    return { ok: true, ...transfer, settled: true };
  },
}, { exposedTo: [KERNEL] });

await ctx.registerTool({
  name: 'list_transfers',
  title: 'List settled transfers',
  description: 'Returns every transfer that has actually settled.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  async execute() { return { transfers: transfers.map((t) => ({ ...t })) }; },
}, { exposedTo: [KERNEL] });

function render() {
  const el = document.getElementById('transfers');
  if (!transfers.length) { el.innerHTML = '<p class="empty">no transfers settled</p>'; return; }
  el.innerHTML = transfers.map((t, i) =>
    `<div class="card${i === transfers.length - 1 ? ' new' : ''}">` +
    `<div class="from"><span>→ ${t.to}</span><span class="num neg">$${(t.minor / 100).toFixed(2)}</span></div>` +
    `<div class="body">${(t.memo || '—').replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]))}</div></div>`).join('');
}

document.getElementById('origin').textContent = location.origin;
