// Rowan House — compensable. The booking is real, the charge is real, and a
// reversal is a second real event rather than an erasure of the first.
import { participant } from '/kit/vendor.mjs';

const state = { bookings: [], ledger: [] };
const usd = (m) => `$${(m / 100).toFixed(2)}`;

await participant({
  id: 'stay',
  title: 'Rowan House',
  protocol: {
    steps: {
      execute:    { tool: 'book_room' },
      compensate: { tool: 'cancel_booking', refund: 'full' },
    },
  },
  state,
  steps: {
    execute: {
      tool: 'book_room',
      title: 'Book a room',
      description: 'Books a room and charges the stay immediately. There is no hold — the booking '
        + 'is live and the guest is charged the moment this returns.',
      properties: {
        nights: { type: 'number', description: 'Number of nights' },
        city:   { type: 'string', description: 'City' },
      },
      required: ['nights'],
      async run({ nights, city }) {
        const minor = 18900 * (nights ?? 1);
        const ref = `RH${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        state.bookings.push({ ref, nights, city, minor, status: 'booked' });
        state.ledger.push({ ref, minor, kind: 'charge' });
        return { ref, minor, nights, charged: true };
      },
      summary: (a, r) => `${r.ref} · ${usd(r.minor)} charged now`,
    },
    compensate: {
      tool: 'cancel_booking',
      title: 'Cancel a booking and refund',
      description: 'Cancels the booking and refunds the charge in full. The original charge still '
        + 'happened; this is a second movement that reverses it.',
      properties: { ref: { type: 'string', description: 'Booking reference' } },
      required: ['ref'],
      tone: 'ok',
      async run({ ref }) {
        const id = ref?.ref ?? ref;
        const booking = state.bookings.find((b) => b.ref === id);
        if (!booking) throw new Error(`no booking ${id}`);
        booking.status = 'refunded';
        state.ledger.push({ ref: id, minor: -booking.minor, kind: 'refund' });
        return { ref: id, refunded: booking.minor };
      },
      summary: (a, r) => `${r.ref} · ${usd(r.refunded)} refunded in full`,
    },
  },
  render: (s) => (s.bookings.length
      ? s.bookings.map((b) => `<div class="row"><span>${b.ref} · ${b.nights} nights</span>` +
          `<span class="pill ${b.status === 'booked' ? 'done' : 'gone'}">${b.status} ${usd(b.minor)}</span></div>`).join('')
      : '<div class="empty">no bookings</div>')
    + `<div class="row"><span>net charged</span><b class="num">${
        usd(s.ledger.reduce((t, l) => t + l.minor, 0))}</b></div>`,
});
