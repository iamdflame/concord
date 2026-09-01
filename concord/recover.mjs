// Recovery.
//
// A coordinator that dies mid-commitment leaves real holds and real charges
// behind. The journal says what it was about to do; it cannot say whether the
// vendor acted, because the process stopped between the call and the reply. The
// idempotency key resolves that: it was written before the call, and every
// vendor can be asked whether it ever honoured that key.
//
// Two things this has to get right, and an earlier version got both wrong:
//
//   Completion.    A saga that finished every step and died before its settled
//                  marker looks, in the log, exactly like one that stopped half
//                  way. Undoing it destroys a valid transaction -- a ticketed
//                  seat with the hotel refunded underneath it. So the plan is
//                  journalled at the start and recovery checks it first.
//
//   Supersession.  A reserve that was later confirmed is not a hold any more.
//                  Cancelling it does nothing at the vendor and everything to
//                  the report, which then claims to have reversed something
//                  that still stands.
//
// Anything it cannot resolve is named, never assumed: assuming a step did not
// happen strands money, and assuming it did refunds a booking never made.

import { OUTCOME, stepKey } from './saga.mjs';
import { expectedSteps } from './ladder.mjs';

const FORWARD = new Set(['reserve', 'execute', 'confirm']);

/** The journal records {vendor, rung}; the ladder speaks in {id, rung}. */
const plannedSteps = (plan) => plan
  ? expectedSteps(plan.map(({ vendor, rung }) => ({ id: vendor, rung })))
  : null;

export async function recover({ journal, participants, call, onEvent = () => {} }) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const outstanding = await journal.incomplete();
  const reports = [];

  for (const saga of outstanding) {
    const emit = (type, detail = {}) => onEvent({ type, sagaId: saga.sagaId, ...detail });
    emit('recovering', {
      completed: saga.completed.length,
      uncertain: saga.uncertain.length,
      failed: saga.failed.length,
    });

    // ── resolve what the log could not settle ──────────────────────────────
    const resolved = [];
    const unresolved = [];

    for (const step of saga.uncertain) {
      const vendor = byId.get(step.vendor);
      const statusTool = vendor?.protocol?.steps?.status?.tool;
      if (!statusTool) {
        unresolved.push({ ...step, why: `${step.vendor} declares no status step, so this cannot be resolved` });
        emit('unresolvable', { vendor: step.vendor, step: step.step });
        continue;
      }
      try {
        const status = await call(step.vendor, statusTool, { lookupKey: step.idempotencyKey },
          { idempotencyKey: `${step.idempotencyKey}.status`, step: 'status', sagaId: saga.sagaId });
        emit('probed', { vendor: step.vendor, step: step.step, happened: status.happened });
        if (status.happened) resolved.push({ ...step, result: status.result });
      } catch (err) {
        unresolved.push({ ...step, why: `${step.vendor} could not be reached: ${err.message}` });
        emit('unreachable', { vendor: step.vendor, step: step.step, error: err.message });
      }
    }

    // Probed steps go back where they belong in time, not on the end. Reversal
    // order is only meaningful if the sequence is the real one.
    const happened = [...saga.completed, ...resolved]
      .filter((s) => FORWARD.has(s.step))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

    // ── did this saga actually finish? ─────────────────────────────────────
    const expected = plannedSteps(saga.plan);
    const doneKeys = new Set(happened.map((s) => `${s.vendor}.${s.step}`));
    const complete = expected && expected.every((k) => doneKeys.has(k));

    if (complete && !unresolved.length) {
      // Every planned step happened. The commitment stands, and the only thing
      // missing was the marker saying so. Reversing here is what destroyed a
      // valid trip; the correct action is to finish writing the record.
      await journal.settled(saga.sagaId, OUTCOME.COMMITTED).catch(() => {});
      emit('already_committed', { steps: expected.length });
      reports.push({
        sagaId: saga.sagaId, outcome: OUTCOME.COMMITTED, reversals: [], unresolved: [],
        stands: happened.map((s) => ({ vendor: s.vendor, step: s.step })),
        note: 'Every step of this commitment had already succeeded. Nothing was undone.',
      });
      continue;
    }

    // ── what is still reversible ───────────────────────────────────────────
    // A reserve that was later confirmed is a booking, not a hold.
    const confirmed = new Set(happened.filter((s) => s.step === 'confirm').map((s) => s.vendor));

    const reversals = [];
    const stands = [];

    for (const step of [...happened].reverse()) {
      const vendor = byId.get(step.vendor);

      if (step.step === 'confirm' || (step.step === 'reserve' && confirmed.has(step.vendor))) {
        stands.push({ vendor: step.vendor, step: step.step, why: 'confirmed; this is a booking, not a hold' });
        emit('stands', { vendor: step.vendor, step: step.step });
        continue;
      }

      const undoStep = step.step === 'reserve' ? 'cancel'
        : step.step === 'execute' && vendor?.protocol?.steps?.compensate ? 'compensate'
        : null;

      if (!undoStep) {
        stands.push({ vendor: step.vendor, step: step.step, why: `${step.step} on ${step.vendor} cannot be undone` });
        emit('irreversible', { vendor: step.vendor, step: step.step });
        continue;
      }

      // Recovery journals its own intent too. It condemned the saga for not
      // doing this; it does not get an exemption.
      const undoKey = stepKey(saga.sagaId, step.vendor, undoStep);
      // Recovery journals its own intent, but a log it cannot write must not
      // stop it from undoing what is already outstanding.
      await journal.intent(saga.sagaId, step.vendor, undoStep, undoKey, { ref: step.result?.ref })
        .catch(() => {});
      try {
        const tool = vendor.protocol.steps[undoStep].tool;
        const out = await call(step.vendor, tool, { ref: step.result?.ref ?? step.result },
          { idempotencyKey: undoKey, step: undoStep, sagaId: saga.sagaId });
        await journal.result(saga.sagaId, step.vendor, undoStep, undoKey, out).catch(() => {});
        reversals.push({ ...step, reversed: true, via: undoStep });
        emit('reversed', { vendor: step.vendor, step: step.step, via: undoStep });
      } catch (err) {
        await journal.failed(saga.sagaId, step.vendor, undoStep, undoKey, err.message).catch(() => {});
        reversals.push({ ...step, reversed: false, why: err.message });
        emit('reversal_failed', { vendor: step.vendor, step: step.step, error: err.message });
      }
    }

    const clean = unresolved.length === 0
      && stands.length === 0
      && reversals.every((r) => r.reversed);
    const outcome = clean ? OUTCOME.UNWOUND : OUTCOME.IN_DOUBT;
    // If the marker cannot be written the saga is simply revisited, which is
    // safe: every reversal above is idempotent under its own key.
    await journal.settled(saga.sagaId, outcome).catch(() => {});
    emit('recovered', {
      outcome, reversed: reversals.filter((r) => r.reversed).length,
      stands: stands.length, unresolved: unresolved.length,
    });

    reports.push({ sagaId: saga.sagaId, outcome, reversals, stands, unresolved });
  }

  return reports;
}
