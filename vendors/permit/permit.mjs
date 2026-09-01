// Entry Permit — a second irreversible vendor.
//
// It exists so the refusal is real rather than staged. Two vendors that can
// only act, and neither able to take it back, is the case where no ordering
// helps: if the second fails, nothing can undo the first. Concord declines the
// whole plan rather than doing half of it, and it declines before contacting
// either of them.
import { participant, esc } from '/kit/vendor.mjs';

const state = { permits: [] };
const usd = (m) => `$${(m / 100).toFixed(2)}`;

await participant({
  id: 'permit',
  title: 'Entry Permit',
  protocol: {
    steps: { execute: { tool: 'issue_permit' } },
    irreversible: true,
    note: 'Single-entry permit. The issuing authority does not revoke or refund.',
  },
  state,
  steps: {
    execute: {
      tool: 'issue_permit',
      title: 'Issue an entry permit',
      description: 'Issues a single-entry permit and takes the fee. There is no cancellation and '
        + 'no refund; once this returns, it is issued.',
      properties: {
        applicant: { type: 'string', description: 'Applicant name' },
        country:   { type: 'string', description: 'Destination country' },
      },
      required: ['applicant'],
      tone: 'bad',
      async run({ applicant, country }) {
        const ref = `EP${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        state.permits.push({ ref, applicant, country, minor: 14500 });
        return { ref, minor: 14500, refundable: false };
      },
      summary: (a, r) => `${r.ref} · ${usd(r.minor)} taken · non-refundable`,
    },
  },
  render: (s) => (s.permits.length
    ? s.permits.map((p) => `<div class="row"><span>${esc(p.ref)} · ${esc(p.applicant)}</span>` +
        `<span class="pill done">${usd(p.minor)} issued</span></div>`).join('')
    : '<div class="empty">no permits issued</div>'),
});
