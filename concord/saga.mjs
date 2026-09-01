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

/**
 * The one place a step's idempotency key is derived.
 *
 * The live unwind and crash recovery used to build this differently, so a saga
 * that partly unwound and then crashed presented the vendor a key it had never
 * seen and the compensation ran a second time. One derivation, both paths.
 */
export const stepKey = (sagaId, vendor, step) => `${sagaId}.${vendor}.${step}`;

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
  // At zero the retry loop never runs, lastError stays null, and the record
  // falls through as confirmed -- reporting COMMITTED for a call never made.
  confirmRetries = 3,
  retryDelayMs = 120,
  journal = null,
  sagaId = `saga_${Math.random().toString(36).slice(2, 10)}`,
}) {
  if (!(confirmRetries >= 1)) throw new TypeError('confirmRetries must be at least 1');

  const byId = new Map(participants.map((p) => [p.id, p]));
  // Rungs come from the plan, never re-derived here. Two places deciding what a
  // participant can promise is two places to disagree.
  const rungOf = new Map(planned.rungs?.map((r) => [r.id, r.rung]) ?? []);
  const journal_ = [];      // the event stream shown to a person
  const emit = (type, detail = {}) => {
    const event = { seq: journal_.length, type, sagaId, ...detail };
    journal_.push(event);
    onEvent(event);
    return event;
  };

  const key = (id, step) => stepKey(sagaId, id, step);
  const toolFor = (id, step) => byId.get(id).protocol.steps[step]?.tool;

  /** Ask a vendor whether it ever honoured a key. Performs nothing. */
  const probe = async (id, idempotencyKey) => {
    const statusTool = byId.get(id)?.protocol?.steps?.status?.tool;
    if (!statusTool) return null;
    try {
      return await call(id, statusTool, { lookupKey: idempotencyKey },
        { idempotencyKey: `${idempotencyKey}.status`, step: 'status', sagaId });
    } catch { return null; }
  };

  const invoke = async (id, step, args) => {
    const tool = toolFor(id, step);
    if (!tool) throw new Error(`${id} declares no "${step}" step`);
    const idempotencyKey = key(id, step);

    // Intent is written before the call, never after. A log of outcomes alone
    // cannot distinguish "about to reserve" from "never reserved", and those
    // need opposite recoveries.
    await journal?.intent(sagaId, id, step, idempotencyKey, args);
    try {
      const result = await call(id, tool, args, { idempotencyKey, step, sagaId });
      await journal?.result(sagaId, id, step, idempotencyKey, result);
      return result;
    } catch (err) {
      // A dead process writes nothing more, so a fatal error leaves the intent
      // standing alone -- which is exactly what recovery must see: a step that
      // may or may not have taken effect. Only a live coordinator gets to
      // record that a call came back and failed.
      if (err.fatal) throw err;

      // A thrown call is not the same as a call that did not happen. A dropped
      // reply on the consular fee used to send the whole saga into unwind while
      // the money was actually gone, and then report that nothing stood. The
      // status probe existed for exactly this and was only wired into crash
      // recovery; the live path now asks too.
      const probed = await probe(id, idempotencyKey);
      if (probed?.happened) {
        emit('reply_lost', { id, step, note: `${id} did perform ${step}; only the reply was lost` });
        await journal?.result(sagaId, id, step, idempotencyKey, probed.result);
        return probed.result;
      }

      await journal?.failed(sagaId, id, step, idempotencyKey, err.message);
      err.vendor = id;
      err.step = step;
      throw err;
    }
  };

  if (planned.guarantee === GUARANTEE.REFUSED) {
    emit('refused', { refusal: planned.refusal });
    return { outcome: OUTCOME.REFUSED, refusal: planned.refusal, journal: journal_, held: [], done: [] };
  }

  // Record the plan before the first call, so recovery can tell a saga that
  // finished from one that stopped half way.
  await journal?.started(sagaId, planned.rungs.map((r) => ({ vendor: r.id, rung: r.rung })));

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
    await journal?.settled(sagaId, outcome);
    emit('done', { outcome, cause: cause.message, failures });
    return { outcome, cause: cause.message, failures, journal: journal_, held, done, committed };
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
          // Retrying is only sane against a vendor that might answer next time.
          // A process that has died cannot retry anything, and pretending it
          // can turns a crash into an invented in-doubt outcome.
          if (err.fatal) throw err;
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
        await journal?.settled(sagaId, OUTCOME.IN_DOUBT);
        emit('done', { outcome: OUTCOME.IN_DOUBT, cause: lastError.message });
        return {
          outcome: OUTCOME.IN_DOUBT, cause: lastError.message, stranded,
          journal: journal_, held, done, committed,
        };
      }
    }

    await journal?.settled(sagaId, OUTCOME.COMMITTED);
    emit('done', { outcome: OUTCOME.COMMITTED, participants: planned.order });
    return { outcome: OUTCOME.COMMITTED, journal: journal_, held, done, committed };
  } catch (err) {
    // A process that has died does not unwind -- there is nothing left running
    // to do it. Recovery picks this up from the journal on the next start, and
    // simulating it any other way would test a code path that cannot happen.
    if (err.fatal) throw err;
    return unwind(err);
  }
}
