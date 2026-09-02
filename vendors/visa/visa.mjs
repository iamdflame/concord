// Consular Fee — the weakest rung, and the reason the ladder exists. There is
// no cancel step here and none can be invented: a government fee is gone.
import { participant, esc } from '/kit/vendor.mjs';

const state = { fees: [] };
const usd = (m) => `$${(m / 100).toFixed(2)}`;

await participant({
  id: 'visa',
  brand: { hue: 12,  chroma: 0.09, face: 'state' },
  title: 'Consular Fee',
  protocol: {
    // No compensate. Declaring one would be a lie the coordinator would build on.
    steps: { execute: { tool: 'pay_fee' } },
    irreversible: true,
    note: 'Statutory fee. Non-refundable by law, not by policy.',
  },
  state,
  steps: {
    execute: {
      tool: 'pay_fee',
      title: 'Pay the consular fee',
      description: 'Takes the non-refundable statutory fee. Once this returns the money is gone; '
        + 'there is no cancellation and no refund under any circumstances.',
      properties: {
        applicant: { type: 'string', description: 'Applicant name' },
        country:   { type: 'string', description: 'Destination country' },
      },
      required: ['applicant'],
      tone: 'bad',
      async run({ applicant, country }) {
        const ref = `CF${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        state.fees.push({ ref, applicant, country, minor: 26000 });
        return { ref, minor: 26000, refundable: false };
      },
      summary: (a, r) => `${r.ref} · ${usd(r.minor)} taken · non-refundable`,
    },
  },
  render: (s) => (s.fees.length
    ? s.fees.map((f) => `<div class="row"><span>${esc(f.ref)} · ${esc(f.applicant)}</span>` +
        `<span class="pill done">${usd(f.minor)} taken</span></div>`).join('')
    : '<div class="empty">no fees taken</div>'),
});
