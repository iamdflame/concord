// Recovery.
//
// A coordinator that dies mid-commitment leaves real holds and real charges
// behind. The journal says what it was about to do; it cannot say whether the
// vendor acted, because the process stopped between the call and the reply.
//
// The idempotency key resolves it. It was written to the journal before the
// call, and every vendor can be asked whether it ever honoured that key. So
// recovery does not guess and does not retry blindly: it asks each vendor what
// actually happened, and only then decides what to undo.
//
// A vendor that declares no status step cannot be asked. That step is reported
// unresolved rather than assumed either way, because assuming it did not happen
// strands money and assuming it did can double-refund someone.

import { OUTCOME } from './saga.mjs';

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

    const happened = [...saga.completed];
    const unresolved = [];

    // ── resolve what the log could not settle ──────────────────────────────
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
        if (status.happened) happened.push({ ...step, result: status.result });
      } catch (err) {
        unresolved.push({ ...step, why: `${step.vendor} could not be reached: ${err.message}` });
        emit('unreachable', { vendor: step.vendor, step: step.step, error: err.message });
      }
    }

    // ── undo what really happened, newest first ────────────────────────────
    const reversals = [];
    for (const step of [...happened].reverse()) {
      const vendor = byId.get(step.vendor);
      const undoStep = step.step === 'reserve' ? 'cancel'
        : step.step === 'execute' && vendor?.protocol?.steps?.compensate ? 'compensate'
        : null;

      if (!undoStep) {
        // A confirmed booking or an irreversible charge. Nothing to do but say so.
        reversals.push({ ...step, reversed: false, why: `${step.step} on ${step.vendor} cannot be undone` });
        emit('irreversible', { vendor: step.vendor, step: step.step });
        continue;
      }
      try {
        const tool = vendor.protocol.steps[undoStep].tool;
        await call(step.vendor, tool, { ref: step.result?.ref ?? step.result },
          { idempotencyKey: `${step.idempotencyKey}.undo`, step: undoStep, sagaId: saga.sagaId });
        reversals.push({ ...step, reversed: true, via: undoStep });
        emit('reversed', { vendor: step.vendor, step: step.step, via: undoStep });
      } catch (err) {
        reversals.push({ ...step, reversed: false, why: err.message });
        emit('reversal_failed', { vendor: step.vendor, step: step.step, error: err.message });
      }
    }

    const clean = unresolved.length === 0 && reversals.every((r) => r.reversed);
    const outcome = clean ? OUTCOME.UNWOUND : OUTCOME.IN_DOUBT;
    await journal.settled(saga.sagaId, outcome);
    emit('recovered', { outcome, reversed: reversals.filter((r) => r.reversed).length, unresolved: unresolved.length });

    reports.push({ sagaId: saga.sagaId, outcome, reversals, unresolved });
  }

  return reports;
}
