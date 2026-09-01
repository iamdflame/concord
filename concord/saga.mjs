// The executor.
//
// Phase order is the safety property, not an implementation detail:
//
//   1 reserve      every reservable participant takes a hold. Cancellable.
//   2 execute      every compensable participant commits. Reversible, visibly.
//   3 commit       the one irreversible participant runs, if there is one.
//                  Announced first, because this is the point of no return.
//   4 confirm      reservations are turned into bookings.
//
// Confirm comes last for a reason. A confirmed reservation cannot be cancelled,
// so confirming before the irreversible step would strand it if that step
// failed. Putting confirm at the end means the only operation after the point
// of no return is the one the vendor has already promised to honour -- the
// highest-probability call in the system.
//
// It can still fail. When it does, no unwind is possible and pretending
// otherwise would be the lie this whole design exists to avoid: the saga
// retries confirm under the same idempotency key, and if that is exhausted it
// reports IN DOUBT, naming exactly what is stranded and what will happen to it.
//
// Every call carries an idempotency key that is stable across retries, so a
// vendor that already did the work returns the same answer instead of doing it
// twice.

import { GUARANTEE, RUNG } from './ladder.mjs';

export const OUTCOME = {
  COMMITTED: 'committed',
  UNWOUND: 'unwound',
  IN_DOUBT: 'in-doubt',
  REFUSED: 'refused',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSaga({
  plan: planned,
  participants,
  call,
  onEvent = () => {},
  confirmRetries = 3,
  retryDelayMs = 120,
  sagaId = `saga_${Math.random().toString(36).slice(2, 10)}`,
}) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  // Rungs come from the plan, never re-derived here. Two places deciding what a
  // participant can promise is two places to disagree.
  const rungOf = new Map(planned.rungs?.map((r) => [r.id, r.rung]) ?? []);
  const journal = [];
  const emit = (type, detail = {}) => {
    const event = { seq: journal.length, type, sagaId, ...detail };
    journal.push(event);
    onEvent(event);
    return event;
  };

  const key = (id, step) => `${sagaId}.${id}.${step}`;
  const toolFor = (id, step) => byId.get(id).protocol.steps[step]?.tool;

  const invoke = async (id, step, args) => {
    const tool = toolFor(id, step);
    if (!tool) throw new Error(`${id} declares no "${step}" step`);
    return call(id, tool, args, { idempotencyKey: key(id, step), step });
  };

  if (planned.guarantee === GUARANTEE.REFUSED) {
    emit('refused', { refusal: planned.refusal });
    return { outcome: OUTCOME.REFUSED, refusal: planned.refusal, journal, held: [], done: [] };
  }

  emit('plan', {
    guarantee: planned.guarantee,
    order: planned.order,
    pointOfNoReturn: planned.pointOfNoReturn,
    caveats: planned.caveats,
  });

  const held = [];        // reserved, not yet confirmed — cancellable
  const done = [];        // executed compensables — reversible
  const committed = [];   // irreversible, or confirmed — final

  /** Reverse everything that can be reversed, newest first. */
  async function unwind(cause) {
    emit('unwind', { cause: cause.message, reversible: held.length + done.length });
    const failures = [];

    for (const record of [...done].reverse()) {
      try {
        emit('compensate', { id: record.id });
        await invoke(record.id, 'compensate', { ref: record.ref });
        record.reversed = true;
      } catch (err) {
        // A failed compensation is the worst case in any saga. It is recorded,
        // never swallowed, because someone has to go and fix it by hand.
        failures.push({ id: record.id, step: 'compensate', error: err.message });
        emit('compensate_failed', { id: record.id, error: err.message });
      }
    }

    for (const record of [...held].reverse()) {
      try {
        emit('cancel', { id: record.id });
        await invoke(record.id, 'cancel', { ref: record.ref });
        record.released = true;
      } catch (err) {
        failures.push({ id: record.id, step: 'cancel', error: err.message });
        emit('cancel_failed', { id: record.id, error: err.message });
      }
    }

    const outcome = failures.length ? OUTCOME.IN_DOUBT : OUTCOME.UNWOUND;
    emit('done', { outcome, cause: cause.message, failures });
    return { outcome, cause: cause.message, failures, journal, held, done, committed };
  }

  const inputsFor = (id) => byId.get(id).input ?? {};

  try {
    // ── 1. reserve ──────────────────────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.RESERVABLE) continue;
      emit('reserve', { id });
      const ref = await invoke(id, 'reserve', inputsFor(id));
      held.push({ id, ref });
      emit('reserved', { id, ref, ttlSeconds: byId.get(id).protocol.steps.reserve.ttlSeconds ?? null });
    }

    // ── 2. execute the compensables ─────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.COMPENSABLE) continue;
      emit('execute', { id });
      const ref = await invoke(id, 'execute', inputsFor(id));
      done.push({ id, ref });
      emit('executed', { id, ref });
    }

    // ── 3. the point of no return ───────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.IRREVERSIBLE) continue;
      emit('point_of_no_return', { id, note: `${id} cannot be undone once it succeeds` });
      const ref = await invoke(id, 'execute', inputsFor(id));
      committed.push({ id, ref, irreversible: true });
      emit('committed', { id, ref, irreversible: true });
    }

    // ── 4. confirm ──────────────────────────────────────────────────────────
    for (const record of [...held]) {
      let lastError = null;
      for (let attempt = 1; attempt <= confirmRetries; attempt++) {
        try {
          emit('confirm', { id: record.id, attempt });
          const ref = await invoke(record.id, 'confirm', { ref: record.ref });
          record.confirmed = true;
          committed.push({ id: record.id, ref });
          emit('confirmed', { id: record.id, ref });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          emit('confirm_retry', { id: record.id, attempt, error: err.message });
          if (attempt < confirmRetries) await sleep(retryDelayMs * attempt);
        }
      }

      if (lastError) {
        // Past the point of no return there is nothing honest left to do but
        // say what is stranded and what will become of it.
        const stranded = [
          ...committed.filter((c) => c.irreversible).map((c) => `${c.id} has committed and cannot be reversed`),
          `${record.id} holds a reservation that was never confirmed and will expire on its own`,
          ...held.filter((h) => h !== record && !h.confirmed).map((h) => `${h.id} is also unconfirmed`),
        ];
        emit('in_doubt', { id: record.id, error: lastError.message, stranded });
        emit('done', { outcome: OUTCOME.IN_DOUBT, cause: lastError.message });
        return {
          outcome: OUTCOME.IN_DOUBT, cause: lastError.message, stranded,
          journal, held, done, committed,
        };
      }
    }

    emit('done', { outcome: OUTCOME.COMMITTED, participants: planned.order });
    return { outcome: OUTCOME.COMMITTED, journal, held, done, committed };
  } catch (err) {
    return unwind(err);
  }
}
