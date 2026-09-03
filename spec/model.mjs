// The commitment protocol as a state machine, written once.
//
// concord/exhaustive.test.mjs already enumerates the whole ladder, and its
// header states this project's objection to a formal model: "a model in another
// notation is a second artefact that can drift from the code." That objection
// is right, and it is the reason this file is shaped the way it is.
//
// Each action and each invariant below carries both an executable definition
// and its TLA+ text, side by side on the same object. spec/Concord.tla is
// *generated* from these strings by spec/build.mjs -- it is a rendering of the
// machine this repository actually checks, not a second description of it. A
// test asserts the committed .tla matches what the generator produces, the same
// way verify/lib is held to verify/build.mjs, so the two cannot drift apart
// silently.
//
// ── what this does and does not prove ───────────────────────────────────────
//
// spec/check.mjs enumerates this machine exhaustively -- every reachable state
// over every plan shape, by breadth-first search -- and checks every invariant
// in every state, reporting the shortest counterexample trace when one fails.
// That is a real exhaustive proof of the invariants over the modelled machine.
//
// It is not a proof about concord/saga.mjs. It is a proof about a model of it.
// The model is small enough to read in one sitting, which is the point: the
// implementation is checked by the rest of the suite, and this says what the
// implementation is *supposed* to be, in a form a machine can exhaust.
//
// TLC has not been run against the generated .tla here, because this machine
// has no Java on it. Anyone who has can run it; the module is a faithful
// transcription and the invariant names are held equal by test. The authority
// in this repository is check.mjs, and that is stated rather than glossed.

/** The three things a participant can be. Same vocabulary as the ladder. */
export const RUNGS = ['reservable', 'compensable', 'irreversible'];

/** Phases, in the only order the protocol permits. SPEC §5. */
export const PHASES = ['idle', 'reserve', 'execute', 'irreversible', 'confirm', 'settled'];

export const initial = (plan) => ({
  plan,                    // [{ v, rung }], in plan order
  proposed: false,
  committable: false,
  explained: false,
  accepted: false,
  spent: false,            // the acceptance has been used to start a commitment
  phase: 'idle',
  journalled: [],          // step keys whose intent is durably recorded
  performed: [],           // step keys whose effect actually happened
  reversed: [],            // step keys that have been taken back
  outcome: null,
});

const key = (v, step) => `${v}.${step}`;
const has = (xs, x) => xs.includes(x);
const add = (xs, x) => (has(xs, x) ? xs : [...xs, x]);

const of = (s, rung) => s.plan.filter((p) => p.rung === rung).map((p) => p.v);
const stepFor = { reservable: 'reserve', compensable: 'execute', irreversible: 'execute' };

/**
 * Everything the machine may do next.
 *
 * `guard` decides whether an action is enabled in a state; `effect` returns the
 * next state. `tla` is the same action in TLA+, rendered into Concord.tla.
 */
export const ACTIONS = [
  {
    name: 'Propose',
    // Two irreversible participants cannot both be last, so no honest
    // guarantee exists and the plan is refused. The model carries the same
    // rule rather than a flag, so "refused" is reachable and not assumed.
    guard: (s) => !s.spent && s.phase === 'idle',
    effects: (s) => [{
      ...s, proposed: true, explained: false, accepted: false,
      committable: of(s, 'irreversible').length <= 1,
    }],
    tla: [
      'Propose ==',
      '  /\\ ~spent /\\ phase = "idle"',
      '  /\\ proposed\' = TRUE',
      '  /\\ explained\' = FALSE',
      '  /\\ accepted\' = FALSE',
      '  /\\ committable\' = (Cardinality(Irreversible) <= 1)',
      '  /\\ UNCHANGED << spent, phase, journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'Explain',
    guard: (s) => s.proposed && s.phase === 'idle',
    effects: (s) => [{ ...s, explained: true }],
    tla: [
      'Explain ==',
      '  /\\ proposed /\\ phase = "idle"',
      '  /\\ explained\' = TRUE',
      '  /\\ UNCHANGED << proposed, committable, accepted, spent, phase,',
      '                  journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'Accept',
    // The only action a person takes, and the only one that can set `accepted`.
    // A refused plan has nothing to accept: that is the guard, not a check
    // somewhere downstream.
    guard: (s) => s.proposed && s.explained && s.committable && !s.accepted && s.phase === 'idle',
    effects: (s) => [{ ...s, accepted: true }],
    tla: [
      'Accept ==',
      '  /\\ proposed /\\ explained /\\ committable /\\ ~accepted /\\ phase = "idle"',
      '  /\\ accepted\' = TRUE',
      '  /\\ UNCHANGED << proposed, committable, explained, spent, phase,',
      '                  journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'Repropose',
    // Asking a different question throws away the answer to the last one.
    guard: (s) => s.proposed && s.phase === 'idle',
    effects: (s) => [{ ...s, explained: false, accepted: false }],
    tla: [
      'Repropose ==',
      '  /\\ proposed /\\ phase = "idle"',
      '  /\\ explained\' = FALSE',
      '  /\\ accepted\' = FALSE',
      '  /\\ UNCHANGED << proposed, committable, spent, phase,',
      '                  journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'BeginCommitment',
    guard: (s) => s.accepted && !s.spent && s.committable && s.phase === 'idle',
    effects: (s) => [{ ...s, spent: true, phase: 'reserve' }],
    tla: [
      'BeginCommitment ==',
      '  /\\ accepted /\\ ~spent /\\ committable /\\ phase = "idle"',
      '  /\\ spent\' = TRUE',
      '  /\\ phase\' = "reserve"',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted,',
      '                  journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'JournalIntent',
    params: ['v', 'st'],
    // Write down what is about to be attempted, before attempting it. This is
    // the action whose absence makes recovery impossible.
    guard: (s) => s.phase !== 'idle' && s.phase !== 'settled',
    effects: (s) => s.plan
      .filter((p) => phaseOf(p.rung, s) && !has(s.journalled, key(p.v, stepFor[p.rung])))
      .map((p) => ({ ...s, journalled: add(s.journalled, key(p.v, stepFor[p.rung])) })),
    tla: [
      'JournalIntent(v, st) ==',
      '  /\\ phase \\notin {"idle", "settled"}',
      '  /\\ ActsOn(v, st)',
      '  /\\ journalled\' = journalled \\cup {<<v, st>>}',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  phase, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'Perform',
    params: ['v', 'st'],
    // An effect may only happen after its intent is durable. This is the
    // invariant JournalBeforeEffect, expressed as a guard so the machine cannot
    // reach a state that violates it rather than being told off afterwards.
    guard: (s) => s.phase !== 'idle' && s.phase !== 'settled',
    effects: (s) => s.plan
      .filter((p) => phaseOf(p.rung, s)
        && has(s.journalled, key(p.v, stepFor[p.rung]))
        && !has(s.performed, key(p.v, stepFor[p.rung])))
      .map((p) => ({ ...s, performed: add(s.performed, key(p.v, stepFor[p.rung])) })),
    tla: [
      'Perform(v, st) ==',
      '  /\\ phase \\notin {"idle", "settled"}',
      '  /\\ ActsOn(v, st)',
      '  /\\ <<v, st>> \\in journalled',
      '  /\\ performed\' = performed \\cup {<<v, st>>}',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  phase, journalled, reversed, outcome >>',
    ],
  },
  {
    name: 'AdvancePhase',
    // A phase ends when everything it owns has been performed. Nothing may
    // begin the next phase early: that is what makes "irreversible last" true
    // by construction rather than by inspection.
    guard: (s) => s.phase !== 'idle' && s.phase !== 'settled' && phaseComplete(s),
    effects: (s) => [{ ...s, phase: PHASES[PHASES.indexOf(s.phase) + 1] }],
    tla: [
      'AdvancePhase ==',
      '  /\\ phase \\notin {"idle", "settled"}',
      '  /\\ PhaseComplete',
      '  /\\ phase\' = NextPhase(phase)',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  journalled, performed, reversed, outcome >>',
    ],
  },
  {
    name: 'Unwind',
    // A failure before the point of no return takes back everything reversible,
    // and nothing irreversible may have run.
    guard: (s) => ['reserve', 'execute'].includes(s.phase) && !s.outcome,
    effects: (s) => [{
      ...s,
      reversed: s.performed.filter((k) => !isIrreversible(s, k)),
      phase: 'settled',
      outcome: 'unwound',
    }],
    tla: [
      'Unwind ==',
      '  /\\ phase \\in {"reserve", "execute"}',
      '  /\\ outcome = "none"',
      '  /\\ reversed\' = { k \\in performed : ~IsIrreversible(k) }',
      '  /\\ phase\' = "settled"',
      '  /\\ outcome\' = "unwound"',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  journalled, performed >>',
    ],
  },
  {
    name: 'Settle',
    guard: (s) => s.phase === 'confirm' && phaseComplete(s) && !s.outcome,
    effects: (s) => [{ ...s, phase: 'settled', outcome: 'committed' }],
    tla: [
      'Settle ==',
      '  /\\ phase = "confirm" /\\ PhaseComplete /\\ outcome = "none"',
      '  /\\ phase\' = "settled"',
      '  /\\ outcome\' = "committed"',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  journalled, performed, reversed >>',
    ],
  },
  {
    name: 'Refuse',
    guard: (s) => s.proposed && !s.committable && s.phase === 'idle' && !s.outcome,
    effects: (s) => [{ ...s, phase: 'settled', outcome: 'refused' }],
    tla: [
      'Refuse ==',
      '  /\\ proposed /\\ ~committable /\\ phase = "idle" /\\ outcome = "none"',
      '  /\\ phase\' = "settled"',
      '  /\\ outcome\' = "refused"',
      '  /\\ UNCHANGED << proposed, committable, explained, accepted, spent,',
      '                  journalled, performed, reversed >>',
    ],
  },
];

/** Does this rung act in the current phase? */
function phaseOf(rung, s) {
  if (s.phase === 'reserve') return rung === 'reservable';
  if (s.phase === 'execute') return rung === 'compensable';
  if (s.phase === 'irreversible') return rung === 'irreversible';
  if (s.phase === 'confirm') return false;   // confirm is modelled by Settle
  return false;
}

function phaseComplete(s) {
  return s.plan
    .filter((p) => phaseOf(p.rung, s))
    .every((p) => has(s.performed, key(p.v, stepFor[p.rung])));
}

const isIrreversible = (s, k) =>
  s.plan.some((p) => p.rung === 'irreversible' && key(p.v, stepFor[p.rung]) === k);

/**
 * The safety properties. Every one is checked in every reachable state.
 *
 * These are the sentences the README makes. Here they are the thing a machine
 * refuses to let the model violate.
 */
export const INVARIANTS = [
  {
    name: 'NoEffectWithoutAcceptance',
    doc: 'nothing is ever contacted unless a person accepted a guarantee first',
    holds: (s) => s.performed.length === 0 || (s.accepted && s.spent),
    tla: 'NoEffectWithoutAcceptance == (performed # {}) => (accepted /\\ spent)',
  },
  {
    name: 'NoAcceptanceOfRefused',
    doc: 'a plan with no honest guarantee can never be accepted',
    holds: (s) => !s.accepted || s.committable,
    tla: 'NoAcceptanceOfRefused == accepted => committable',
  },
  {
    name: 'JournalBeforeEffect',
    doc: 'no effect happens whose intent was not written down first',
    holds: (s) => s.performed.every((k) => has(s.journalled, k)),
    tla: 'JournalBeforeEffect == performed \\subseteq journalled',
  },
  {
    name: 'IrreversibleIsLast',
    doc: 'nothing irreversible is touched while anything reversible is unsettled',
    holds: (s) => !s.performed.some((k) => isIrreversible(s, k))
      || s.plan.filter((p) => p.rung !== 'irreversible')
        .every((p) => has(s.performed, key(p.v, stepFor[p.rung]))),
    tla: [
      'IrreversibleIsLast ==',
      '  (\\E k \\in performed : IsIrreversible(k))',
      '    => (\\A p \\in Reversible : <<p, StepOf(p)>> \\in performed)',
    ].join('\n'),
  },
  {
    name: 'AtMostOneIrreversible',
    doc: 'a committable plan never contains two things that cannot be taken back',
    holds: (s) => !s.committable || s.plan.filter((p) => p.rung === 'irreversible').length <= 1,
    tla: 'AtMostOneIrreversible == committable => Cardinality(Irreversible) <= 1',
  },
  {
    name: 'UnwoundMeansNothingIrreversibleRan',
    doc: '"this did not happen" is never said after something that cannot be undone',
    holds: (s) => s.outcome !== 'unwound' || !s.performed.some((k) => isIrreversible(s, k)),
    tla: [
      'UnwoundMeansNothingIrreversibleRan ==',
      '  (outcome = "unwound") => ~(\\E k \\in performed : IsIrreversible(k))',
    ].join('\n'),
  },
  {
    name: 'UnwoundMeansEverythingReversed',
    doc: 'an unwound commitment left nothing standing',
    holds: (s) => s.outcome !== 'unwound'
      || s.performed.every((k) => has(s.reversed, k)),
    tla: 'UnwoundMeansEverythingReversed == (outcome = "unwound") => performed \\subseteq reversed',
  },
  {
    name: 'CommitToolIffUnspentAcceptance',
    doc: 'the commit tool is registered exactly when a person has accepted and not yet spent it',
    holds: (s) => commitRegistered(s) === Boolean(s.accepted && !s.spent && s.committable),
    tla: [
      'CommitToolIffUnspentAcceptance ==',
      '  CommitRegistered <=> (accepted /\\ ~spent /\\ committable)',
    ].join('\n'),
  },
  {
    // Derived, not independent -- and said so because the difference matters.
    // Every mutation of the model that should break this one breaks
    // NoAcceptanceOfRefused or NoEffectWithoutAcceptance first: a refused plan
    // cannot be accepted, and nothing is contacted without an acceptance, so a
    // state with a refusal and an effect in it is unreachable by those two
    // together. It is stated anyway because it is the sentence a person
    // actually wants to hear, but it is not load-bearing on its own.
    name: 'RefusedTouchesNothing',
    doc: 'a refusal is computed before contact, so a refused commitment contacted nobody',
    holds: (s) => s.outcome !== 'refused' || s.performed.length === 0,
    tla: 'RefusedTouchesNothing == (outcome = "refused") => performed = {}',
  },
];

/**
 * The surface, as the model sees it. Deliberately the same shape as
 * desiredNames() in concord/agent-surface.mjs, and checked against the real one
 * by concord/model.test.mjs -- this is what ties the two together.
 */
export const commitRegistered = (s) => Boolean(s.accepted && !s.spent && s.committable);
