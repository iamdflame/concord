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

/**
 * What can this participant actually promise?
 *
 * An incomplete protocol -- reserve and cancel but no confirm, say -- is not an
 * exceptional condition. It is the same answer as any other unpromisable plan:
 * no honest guarantee is available. It is returned, not thrown, so there is one
 * failure mode for one concept.
 */
export function classify(participant) {
  const steps = participant.protocol?.steps ?? {};
  const has = (k) => Boolean(steps[k]?.tool);
  // Whether a crash can be resolved with this vendor at all.
  const recoverable = has('status');

  if (has('reserve') && has('confirm') && has('cancel')) {
    return { rung: RUNG.RESERVABLE, recoverable, why: 'declares reserve, confirm and cancel' };
  }
  if (has('execute') && has('compensate')) {
    return { rung: RUNG.COMPENSABLE, recoverable, why: 'declares execute and compensate' };
  }
  if (has('execute')) {
    return { rung: RUNG.IRREVERSIBLE, recoverable, why: 'declares execute with no way back' };
  }
  return {
    rung: null, recoverable,
    unusable: `${participant.id} declares ${Object.keys(steps).length ? `only ${Object.keys(steps).join(', ')}` : 'no steps'}`
      + ', which is not a commitment protocol anything can be promised over',
  };
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

  const unusable = participants.filter((p) => classified.get(p.id).rung === null);
  if (unusable.length) {
    return {
      guarantee: GUARANTEE.REFUSED,
      order: participants.map((p) => p.id),
      rungs: [], pointOfNoReturn: null, caveats: [], recoverable: false,
      refusal: unusable.map((p) => classified.get(p.id).unusable).join('. ') + '.',
    };
  }

  // A cycle in the declared dependencies is not an exceptional condition
  // either. classify() already says so about an incomplete protocol -- "it is
  // the same answer as any other unpromisable plan, and it is returned, not
  // thrown, so there is one failure mode for one concept" -- and ordering was
  // the one place that still threw. A property test over generated
  // dependencies found it: two participants naming each other produced an
  // exception where every other unpromisable configuration produces a
  // refusal, so the coordinator reported "I could not finish that" instead of
  // saying what was wrong and that nothing had been contacted.
  let sequence;
  try {
    sequence = order(participants, classified);
  } catch (err) {
    if (!(err instanceof PlanError)) throw err;
    return {
      guarantee: GUARANTEE.REFUSED,
      order: participants.map((p) => p.id),
      rungs: [], pointOfNoReturn: null, caveats: [], recoverable: false,
      refusal: `${(err.detail?.cycle ?? []).join(' → ') || 'these participants'} depend on each `
        + 'other in a cycle, so there is no order in which they could be committed. Nothing was '
        + 'contacted.',
    };
  }
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

  // Confirm is a per-vendor fan-out, so two vendors can be ticketed and a third
  // fail. That is ordinary two-phase commit and it cannot be removed without a
  // coordinator both sides trust, which is the thing this design says does not
  // exist. It is said here rather than papered over.
  const reservable = rungs.filter((r) => r.rung === RUNG.RESERVABLE);
  if (reservable.length > 1) {
    caveats.push(`Confirming ${reservable.length} reservations is a sequence, not an instant. `
      + 'If a later confirm fails, the earlier ones are already final — you are told exactly '
      + 'which, and nothing is quietly reversed underneath them.');
  }

  // Recoverability is part of the honest guarantee. A vendor that cannot be
  // asked "did this happen" turns any interruption into a permanent unknown,
  // and the planner used to promise atomicity over exactly that.
  const unrecoverable = rungs.filter((r) => !r.recoverable);
  if (unrecoverable.length) {
    caveats.push(`${unrecoverable.map((r) => r.id).join(', ')} cannot be asked whether a step `
      + 'happened. If this is interrupted mid-call, that vendor is a permanent unknown — '
      + 'no one, including this coordinator, will be able to establish what stands.');
  }

  const guarantee = irreversible.length ? GUARANTEE.BOUNDED
    : compensable.length ? GUARANTEE.COMPENSATED
    : GUARANTEE.ATOMIC;

  return {
    guarantee, order: sequence, rungs, pointOfNoReturn, caveats,
    recoverable: unrecoverable.length === 0,
    refusal: null,
  };
}

/**
 * Every step a plan requires, in order.
 *
 * Shared by the executor, recovery and the verifier, because three places
 * deciding what a commitment consists of is three places to disagree -- and a
 * verifier that computes it differently from the coordinator cannot tell a
 * missing statement from a step that never ran.
 */
export function expectedSteps(rungs) {
  const out = [];
  for (const { id, rung } of rungs) {
    if (rung === RUNG.RESERVABLE) out.push(`${id}.reserve`, `${id}.confirm`);
    else out.push(`${id}.execute`);
  }
  return out;
}

/** What every participant signs: the shape of the whole, not just its own part. */
export function planSummary(planned) {
  return {
    parties: [...planned.order].sort(),
    guarantee: planned.guarantee,
    steps: expectedSteps(planned.rungs),
  };
}

/** One sentence a person can act on, before they commit to anything. */
export function describe(p) {
  if (p.refusal) return `Cannot be made atomic. ${p.refusal}`;
  switch (p.guarantee) {
    case GUARANTEE.ATOMIC:
      // Not "fully atomic". Every vendor holds a reservation and nothing
      // commits until all have agreed -- but the confirm fan-out is sequential,
      // so a late failure leaves earlier confirms standing. Saying otherwise
      // would be the exact lie this design exists to refuse.
      return 'All-or-nothing up to the final confirm. Nothing is committed anywhere until every '
        + 'vendor has agreed; if a confirm then fails, the ones already confirmed stand and you '
        + 'are told which.';
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
