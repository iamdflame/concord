// Northwind Air — the strongest rung. Nothing observable happens until confirm.
import { participant } from '/kit/vendor.mjs';

const state = { inventory: 4, holds: new Map(), tickets: [] };
const usd = (m) => `$${(m / 100).toFixed(2)}`;

await participant({
  id: 'fly',
  title: 'Northwind Air',
  protocol: {
    steps: {
      reserve: { tool: 'hold_seat', ttlSeconds: 900 },
      confirm: { tool: 'ticket_seat' },
      cancel:  { tool: 'release_seat' },
    },
  },
  state,
  steps: {
    reserve: {
      tool: 'hold_seat',
      title: 'Hold a seat',
      description: 'Places a fifteen-minute hold on a seat. Nothing is charged and the seat is not '
        + 'ticketed. The hold expires by itself if it is never confirmed.',
      properties: {
        route: { type: 'string', description: 'Route code, e.g. LOS-LHR' },
        date:  { type: 'string', description: 'Departure date' },
      },
      required: ['route'],
      tone: 'hold',
      async run({ route, date }) {
        if (state.inventory < 1) throw new Error('no seats left on that departure');
        state.inventory -= 1;
        const ref = `NW${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        state.holds.set(ref, { ref, route, date, minor: 74200, at: Date.now() });
        return { ref, route, minor: 74200, expiresInSeconds: 900 };
      },
      summary: (a, r) => `${r.ref} · ${a.route} · held, not charged`,
    },
    confirm: {
      tool: 'ticket_seat',
      title: 'Ticket a held seat',
      description: 'Turns a hold into a ticket and charges the fare. Cannot be undone through this '
        + 'protocol, which is why the coordinator leaves it until last.',
      properties: { ref: { type: 'string', description: 'Hold reference' } },
      required: ['ref'],
      async run({ ref }) {
        const hold = state.holds.get(ref?.ref ?? ref);
        if (!hold) throw new Error(`no live hold for ${ref?.ref ?? ref}`);
        state.holds.delete(hold.ref);
        state.tickets.push(hold);
        return { ref: hold.ref, ticketed: true, minor: hold.minor };
      },
      summary: (a, r) => `${r.ref} · ticketed · ${usd(r.minor)} charged`,
    },
    cancel: {
      tool: 'release_seat',
      title: 'Release a held seat',
      description: 'Drops a hold and returns the seat to inventory. Nothing was charged, so there '
        + 'is nothing to refund.',
      properties: { ref: { type: 'string', description: 'Hold reference' } },
      required: ['ref'],
      tone: 'ok',
      async run({ ref }) {
        const id = ref?.ref ?? ref;
        if (state.holds.delete(id)) state.inventory += 1;
        return { ref: id, released: true };
      },
      summary: (a, r) => `${r.ref} · released · nothing was charged`,
    },
  },
  render: (s) => `<div class="row"><span>seats available</span><b class="num">${s.inventory}</b></div>`
    + [...s.holds.values()].map((h) =>
        `<div class="row"><span>${h.ref} · ${h.route}</span><span class="pill held">held</span></div>`).join('')
    + s.tickets.map((t) =>
        `<div class="row"><span>${t.ref} · ${t.route}</span><span class="pill done">ticketed ${usd(t.minor)}</span></div>`).join('')
    + (!s.holds.size && !s.tickets.length ? '<div class="empty">no holds, no tickets</div>' : ''),
});
