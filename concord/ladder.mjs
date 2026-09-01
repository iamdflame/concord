// The commitment ladder.
//
// A saga over irreversible steps is a lie. If a vendor can only be told to do
// something, and never to undo it, then "atomic" is a promise nobody can keep,
// and discovering that after the failure is the difference between a demo and
// a system. So Concord classifies what each participant can actually commit to,
// works out what guarantee is available *before* anything happens, and refuses
// when none is.
//
// Rungs, weakest to strongest:
//
//   1 IRREVERSIBLE  execute only. Once done, done.
//   2 COMPENSABLE   execute + compensate. The effect happens and is then
//                   reversed -- money moves and comes back, and someone sees
//                   the intermediate state.
//   3 RESERVABLE    reserve + confirm + cancel. Nothing observable happens
//                   until every participant has agreed.
//
// WebMCP describes what a tool is, not what a commitment is, so participants
// declare their commitment surface through one read-only tool. That declaration
// is the only thing Concord trusts about them.

export const RUNG = { IRREVERSIBLE: 1, COMPENSABLE: 2, RESERVABLE: 3 };
export const RUNG_NAME = { 1: 'irreversible', 2: 'compensable', 3: 'reservable' };

export const GUARANTEE = {
  ATOMIC: 'atomic',                 // nothing observable until all agree
  COMPENSATED: 'compensated',       // effects occur, then reverse
  BOUNDED: 'bounded',               // reversible up to a single final commit
  REFUSED: 'refused',               // no honest promise is available
};

export class PlanError extends Error {
  constructor(message, detail) { super(message); this.name = 'PlanError'; this.detail = detail; }
}

/** What can this participant actually promise? */
export function classify(participant) {
  const steps = participant.protocol?.steps ?? {};
  const has = (k) => Boolean(steps[k]?.tool);

  if (has('reserve') && has('confirm') && has('cancel')) {
    return { rung: RUNG.RESERVABLE, why: 'declares reserve, confirm and cancel' };
  }
  if (has('execute') && has('compensate')) {
    return { rung: RUNG.COMPENSABLE, why: 'declares execute and compensate' };
  }
  if (has('execute')) {
    return { rung: RUNG.IRREVERSIBLE, why: 'declares execute with no way back' };
  }
  throw new PlanError(`${participant.id} declares no usable commitment protocol`,
    { participant: participant.id, steps: Object.keys(steps) });
}

/**
 * Order participants so that everything reversible is settled before anything
 * irreversible is touched.
 *
 * This ordering is the whole trick. Run an irreversible step first and a later
 * failure leaves it stranded; run it last and every prior step can still be
 * unwound. Declared dependencies can make that ordering impossible, and when
 * they do the plan says so rather than proceeding and hoping.
 */
function order(participants, classified) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const rungOf = (id) => classified.get(id).rung;

  // Topological order over declared dependencies, then by descending rung so
  // reversible work is front-loaded among peers.
  const visited = new Set();
  const visiting = new Set();
  const out = [];

  const visit = (id, trail = []) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new PlanError('participants depend on each other in a cycle',
        { cycle: [...trail, id] });
    }
    visiting.add(id);
    const deps = [...(byId.get(id)?.dependsOn ?? [])]
      .filter((d) => byId.has(d))
      .sort((a, b) => rungOf(b) - rungOf(a));
    for (const dep of deps) visit(dep, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
    out.push(id);
  };

  for (const p of [...participants].sort((a, b) => rungOf(b.id) - rungOf(a.id))) visit(p.id);
  return out;
}

/**
 * Work out what can honestly be promised, before anything runs.
 *
 * @returns {{guarantee, order, pointOfNoReturn, rungs, caveats, refusal}}
 */
export function plan(participants) {
  if (!participants?.length) throw new PlanError('a plan needs at least one participant', {});

  const classified = new Map();
  for (const p of participants) classified.set(p.id, classify(p));

  const sequence = order(participants, classified);
  const rungs = sequence.map((id) => ({ id, ...classified.get(id) }));

  const irreversible = rungs.filter((r) => r.rung === RUNG.IRREVERSIBLE);
  const compensable = rungs.filter((r) => r.rung === RUNG.COMPENSABLE);
  const caveats = [];

  // More than one irreversible participant admits no honest promise: if the
  // second one fails, the first cannot be taken back by anyone.
  if (irreversible.length > 1) {
    return {
      guarantee: GUARANTEE.REFUSED,
      order: sequence, rungs, pointOfNoReturn: null, caveats,
      refusal: `${irreversible.map((r) => r.id).join(' and ')} are both irreversible. `
        + 'If the second fails, nothing can undo the first, so this plan cannot be made atomic. '
        + 'Ask those vendors for a cancel step, or run them as separate decisions.',
    };
  }

  // A single irreversible step is fine, but only if nothing has to follow it.
  let pointOfNoReturn = null;
  if (irreversible.length === 1) {
    const last = sequence.at(-1);
    if (irreversible[0].id !== last) {
      const blocking = sequence.slice(sequence.indexOf(irreversible[0].id) + 1);
      return {
        guarantee: GUARANTEE.REFUSED,
        order: sequence, rungs, pointOfNoReturn: null, caveats,
        refusal: `${irreversible[0].id} is irreversible but ${blocking.join(', ')} must run after it. `
          + 'Once it commits, a later failure cannot be undone, so atomicity is not available here.',
      };
    }
    pointOfNoReturn = sequence.length - 1;
    caveats.push(`${irreversible[0].id} cannot be reversed. It runs last, only once everything `
      + 'else has succeeded, and if it fails the rest is unwound.');
  }

  if (compensable.length) {
    caveats.push(`${compensable.map((r) => r.id).join(', ')} `
      + `${compensable.length === 1 ? 'commits' : 'commit'} before the plan is settled. `
      + 'A failure reverses it, but the effect is briefly real — a charge may appear and refund.');
  }

  const guarantee = irreversible.length ? GUARANTEE.BOUNDED
    : compensable.length ? GUARANTEE.COMPENSATED
    : GUARANTEE.ATOMIC;

  return { guarantee, order: sequence, rungs, pointOfNoReturn, caveats, refusal: null };
}

/** One sentence a person can act on, before they commit to anything. */
export function describe(p) {
  if (p.refusal) return `Cannot be made atomic. ${p.refusal}`;
  switch (p.guarantee) {
    case GUARANTEE.ATOMIC:
      return 'Fully atomic. Every vendor holds a reservation, and nothing is committed anywhere '
        + 'until all of them have agreed.';
    case GUARANTEE.COMPENSATED:
      return 'Atomic by compensation. Some steps commit and are reversed on failure, so an effect '
        + 'may be briefly visible before it is undone.';
    case GUARANTEE.BOUNDED:
      return 'Atomic up to a final commit. Everything reversible is settled first; the one '
        + 'irreversible step runs last, and a failure there unwinds the rest.';
    default:
      return 'No guarantee available.';
  }
}
