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

import { GUARANTEE, RUNG, planSummary } from './ladder.mjs';

/**
 * The one place a step's idempotency key is derived.
 *
 * The live unwind and crash recovery used to build this differently, so a saga
 * that partly unwound and then crashed presented the vendor a key it had never
 * seen and the compensation ran a second time. One derivation, both paths.
 */
/**
 * A deadline that actually holds the process open until it fires.
 *
 * AbortSignal.timeout() alone is not enough: its timer is unref'd, so when the
 * only other pending work is a call that never settles, Node exits before the
 * abort is delivered and the deadline silently does not exist. Inside a test
 * runner or a browser there is always other work, so it appears to function --
 * which is the worst kind of bug, one that works everywhere you look.
 *
 * The signal is still handed to the vendor, because a vendor that can stop work
 * it will not be allowed to finish should be told to. The ref'd timer is what
 * makes the coordinator's own deadline real. Both are cleared on the way out,
 * or every completed call leaves a live timer behind for its full duration.
 */
function deadline(ms, message) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(message));
      reject(Object.assign(new Error(message), { timedOut: true }));
    }, ms);
  });
  // Nothing listens for an unhandled rejection on a race we may never lose.
  expired.catch(() => {});
  return { signal: controller.signal, expired, clear: () => clearTimeout(timer) };
}

/** The reference a later step names, as the vendor's own schema declares it. */
const handleOf = (result) => (typeof result === 'string' ? result : result?.ref ?? null);

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
  // Under a second of retrying is not resilience. Exponential backoff with
  // full jitter, so a coordinator retrying several vendors does not synchronise
  // its attempts into a burst against whatever is already struggling.
  confirmRetries = 5,
  retryDelayMs = 250,
  retryCapMs = 8_000,
  // A vendor that never answers used to hang the whole commitment while real
  // reservations sat outstanding. Real coordinators die from silence, not from
  // clean exceptions.
  callTimeoutMs = 10_000,
  // Per-call deadlines bound each step and bound nothing overall: enough slow
  // vendors, each answering just inside its limit, and a commitment can hold
  // real reservations for minutes.
  sagaTimeoutMs = 120_000,
  journal = null,
  // Unguessable: anything that can guess a sagaId can pre-poison a vendor's
  // dedupe map, in a protocol whose safety story rests on those keys.
  sagaId = `saga_${crypto.randomUUID()}`,
  // A signal from whoever asked for this: the host's, when an agent runtime
  // hands one to execute, or the page's Stop button. It bounds the same thing
  // sagaTimeoutMs bounds and for the same reason -- the difference is only who
  // decided it had gone on long enough.
  signal = null,
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

  // What every participant signs alongside its own statement. Signing only its
  // own part let a coordinator drop one of a vendor's two statements and
  // rebuild the receipt around what was left: every party still had a
  // statement, so nothing objected. Each vendor now attests to the shape of the
  // whole, so the survivors testify that something is missing.
  const plan = planSummary(planned);
  const startedAt = Date.now();
  const overallDeadline = () => {
    // Checked in the same place and treated the same way: whoever asked has
    // withdrawn the question, and no further exposure is taken on. What is
    // already outstanding is still unwound -- an abort is not permission to
    // walk away from a hold.
    if (signal?.aborted) {
      throw Object.assign(
        new Error(signal.reason?.message ?? 'this commitment was stopped'),
        { sagaTimedOut: true, stopped: true });
    }
    if (Date.now() - startedAt <= sagaTimeoutMs) return;
    throw Object.assign(
      new Error(`this commitment exceeded ${Math.round(sagaTimeoutMs / 1000)}s overall and was abandoned`),
      { sagaTimedOut: true });
  };
  const toolFor = (id, step) => byId.get(id).protocol.steps[step]?.tool;

  /**
   * Ask a vendor whether it ever honoured a key. Performs nothing.
   *
   * This runs on the failure path, which is exactly when a vendor is most
   * likely to be the thing that is broken -- so it gets its own deadline. A
   * probe without one turned a silent vendor into a coordinator that hung
   * forever while holding real reservations.
   */
  const probe = async (id, idempotencyKey) => {
    const statusTool = byId.get(id)?.protocol?.steps?.status?.tool;
    if (!statusTool) return null;
    const limit = deadline(Math.min(callTimeoutMs, 5_000), `${id} did not answer the status probe`);
    try {
      return await Promise.race([
        call(id, statusTool, { lookupKey: idempotencyKey },
          { idempotencyKey: `${idempotencyKey}.status`, step: 'status', sagaId,
            parties: planned.order, plan, signal: limit.signal }),
        limit.expired,
      ]);
    } catch { return null; }
    finally { limit.clear(); }
  };

  /**
   * @param mustRecord  Whether an unwritable journal should stop this call.
   *
   * Before a new action, yes: a step nobody recorded is one recovery can never
   * find. While undoing one already outstanding, no -- refusing to release a
   * hold because the release could not be logged leaves the hold standing,
   * which is strictly worse than an unlogged release. Fail closed when taking
   * on exposure, fail open when giving it back.
   */
  const invoke = async (id, step, args, { mustRecord = true } = {}) => {
    // Not checked while unwinding: giving exposure back is always worth doing,
    // however long the attempt has already taken.
    if (mustRecord) overallDeadline();
    const tool = toolFor(id, step);
    if (!tool) throw new Error(`${id} declares no "${step}" step`);
    const idempotencyKey = key(id, step);
    const limit = deadline(callTimeoutMs, `${id} did not answer ${step} within ${callTimeoutMs}ms`);
    // Whoever asked can stop it, but only where stopping is safe. A vendor
    // call that is taking on exposure may be abandoned; one that is giving
    // exposure back is not, for the same reason its journal write is not
    // allowed to block it. Stopping an unwind mid-way is how a hold survives
    // the cancellation that was meant to release it.
    const stop = mustRecord && signal
      ? AbortSignal.any([limit.signal, signal])
      : limit.signal;

    // Intent is written before the call, never after. A log of outcomes alone
    // cannot distinguish "about to reserve" from "never reserved", and those
    // need opposite recoveries.
    //
    // If that write fails -- a full quota is the usual reason -- the call must
    // not proceed. An unrecorded step is one recovery can never find, so the
    // honest move is to stop before anything happens and say why.
    try {
      await journal?.intent(sagaId, id, step, idempotencyKey, args);
    } catch (err) {
      emit('journal_failed', { id, step, error: err.message, blocked: mustRecord });
      if (mustRecord) {
        throw Object.assign(
          new Error(`cannot record intent to ${step} on ${id}, so it was not attempted: ${err.message}`),
          { vendor: id, step, journalFailure: true });
      }
    }
    try {
      // The signal is handed on, and the deadline is also enforced here: a
      // coordinator that trusts every vendor to honour cancellation has no
      // deadline at all.
      const result = await Promise.race([
        call(id, tool, args,
          { idempotencyKey, step, sagaId, parties: planned.order, plan, signal: stop }),
        limit.expired,
      ]);
      await journal?.result(sagaId, id, step, idempotencyKey, result).catch(() => {});
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

      await journal?.failed(sagaId, id, step, idempotencyKey, err.message).catch(() => {});
      err.vendor = id;
      err.step = step;
      throw err;
    } finally {
      limit.clear();
    }
  };

  if (planned.guarantee === GUARANTEE.REFUSED) {
    emit('refused', { refusal: planned.refusal });
    return { outcome: OUTCOME.REFUSED, refusal: planned.refusal, journal: journal_, held: [], done: [] };
  }

  // Record the plan before the first call, so recovery can tell a saga that
  // finished from one that stopped half way.
  //
  // If even this cannot be written there is no recoverable commitment to be
  // had, so nothing is contacted. Refusing before touching a vendor is the same
  // answer the ladder gives to any plan that cannot be honestly promised.
  try {
    await journal?.started(sagaId, planned.rungs.map((r) => ({ vendor: r.id, rung: r.rung })));
  } catch (err) {
    const refusal = `the commitment log cannot be written (${err.message}), so nothing was attempted`;
    emit('refused', { refusal });
    return { outcome: OUTCOME.REFUSED, refusal, journal: journal_, held: [], done: [] };
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

  /**
   * Write the terminal marker, and carry on if it cannot be written.
   *
   * By the time this runs, reversals have really happened. Throwing here loses
   * that report entirely. An unwritten marker means recovery will look at this
   * saga again, which is safe -- every reversal is idempotent under its key --
   * so the honest outcome is to return the result and say the record is
   * incomplete.
   */
  const settle = async (outcome) => {
    try { await journal?.settled(sagaId, outcome); return null; }
    catch (err) {
      emit('settle_failed', { outcome, error: err.message });
      return `the outcome could not be recorded (${err.message}); recovery will revisit this commitment`;
    }
  };

  /** Reverse everything that can be reversed, newest first. */
  async function unwind(cause) {
    emit('unwind', { cause: cause.message, reversible: held.length + done.length });
    const failures = [];

    for (const record of [...done].reverse()) {
      try {
        emit('compensate', { id: record.id });
        await invoke(record.id, 'compensate', { ref: record.ref }, { mustRecord: false });
        record.reversed = true;
      } catch (err) {
        // A failed compensation is the worst case in any saga. It is recorded,
        // never swallowed, because someone has to go and fix it by hand.
        failures.push({ id: record.id, step: 'compensate', error: err.message });
        emit('compensate_failed', { id: record.id, error: err.message });
      }
    }

    const stands = [];
    for (const record of [...held].reverse()) {
      // A reservation that was already confirmed is a booking, not a hold.
      // Cancelling it does nothing at the vendor and everything to the report,
      // which would then claim to have reversed something that still stands.
      // Recovery learned this; the live unwind had not.
      if (record.confirmed) {
        stands.push({ id: record.id, why: 'already confirmed; this is a booking, not a hold' });
        emit('stands', { id: record.id, step: 'confirm' });
        continue;
      }
      try {
        emit('cancel', { id: record.id });
        await invoke(record.id, 'cancel', { ref: record.ref }, { mustRecord: false });
        record.released = true;
      } catch (err) {
        failures.push({ id: record.id, step: 'cancel', error: err.message });
        emit('cancel_failed', { id: record.id, error: err.message });
      }
    }

    // Anything left standing means this did not come to nothing, whatever the
    // reversals achieved.
    const outcome = (failures.length || stands.length) ? OUTCOME.IN_DOUBT : OUTCOME.UNWOUND;
    const unrecorded = await settle(outcome);
    emit('done', { outcome, cause: cause.message, failures });
    return { outcome, cause: cause.message, failures, stands, unrecorded,
             journal: journal_, held, done, committed };
  }

  const inputsFor = (id) => byId.get(id).input ?? {};

  try {
    // ── 1. reserve ──────────────────────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.RESERVABLE) continue;
      emit('reserve', { id });
      const result = await invoke(id, 'reserve', inputsFor(id));
      const ttlSeconds = byId.get(id).protocol.steps.reserve.ttlSeconds ?? null;
      // The handle a later step names, not the whole result. Passing the object
      // and letting each vendor unwrap it violated their own published schemas
      // -- which is the defect this protocol exists to argue against, committed
      // by the coordinator that argues it.
      held.push({ id, ref: handleOf(result), result, ttlSeconds, takenAt: Date.now() });
      emit('reserved', { id, ref: handleOf(result), ttlSeconds });
    }

    // ── 2. execute the compensables ─────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.COMPENSABLE) continue;
      emit('execute', { id });
      const result = await invoke(id, 'execute', inputsFor(id));
      done.push({ id, ref: handleOf(result), result });
      emit('executed', { id, ref: handleOf(result) });
    }

    // ── 3. the point of no return ───────────────────────────────────────────
    for (const id of planned.order) {
      if (rungOf.get(id) !== RUNG.IRREVERSIBLE) continue;
      emit('point_of_no_return', { id, note: `${id} cannot be undone once it succeeds` });
      const result = await invoke(id, 'execute', inputsFor(id));
      committed.push({ id, ref: handleOf(result), irreversible: true });
      emit('committed', { id, ref: handleOf(result), irreversible: true });
    }

    // ── 4. confirm ──────────────────────────────────────────────────────────
    // A hold that has outlived its TTL is already gone at the vendor, and
    // confirming it fails for a reason that was knowable. Checking every hold
    // once before the loop was not enough: confirming the first vendor can
    // take tens of seconds across retries and their backoff, and the second
    // vendor's hold was checked before any of that started.
    const checkHold = (record) => {
      if (!record.ttlSeconds) return;
      const left = record.ttlSeconds * 1000 - (Date.now() - record.takenAt);
      if (left <= 0) {
        emit('hold_expired', { id: record.id, ttlSeconds: record.ttlSeconds });
        throw Object.assign(
          new Error(`${record.id}'s ${record.ttlSeconds}s hold expired before this could be confirmed`),
          { vendor: record.id, step: 'confirm', expired: true });
      }
      if (left < record.ttlSeconds * 1000 * 0.2) {
        emit('hold_expiring', { id: record.id, secondsLeft: Math.round(left / 1000) });
      }
    };

    for (const record of [...held]) {
      checkHold(record);
      let lastError = null;
      for (let attempt = 1; attempt <= confirmRetries; attempt++) {
        try {
          emit('confirm', { id: record.id, attempt });
          const out = await invoke(record.id, 'confirm', { ref: record.ref });
          record.confirmed = true;
          committed.push({ id: record.id, ref: handleOf(out) });
          emit('confirmed', { id: record.id, ref: handleOf(out) });
          lastError = null;
          break;
        } catch (err) {
          // Retrying is only sane against a vendor that might answer next time.
          // A process that has died cannot retry anything, and pretending it
          // can turns a crash into an invented in-doubt outcome.
          if (err.fatal) throw err;
          // An abandoned commitment must not be retried into an in-doubt
          // outcome it never actually reached. Same shape as the dead-process
          // case: retrying is only sane when trying again could succeed.
          if (err.sagaTimedOut || err.expired) throw err;
          lastError = err;

          // A vendor that answered "no" has decided. Asking again is not
          // resilience, it is refusing to hear it.
          if (err.terminal) {
            emit('confirm_declined', { id: record.id, error: err.message });
            break;
          }

          if (attempt < confirmRetries) {
            const wait = Math.round(Math.random() * Math.min(retryCapMs, retryDelayMs * 2 ** (attempt - 1)));
            emit('confirm_retry', { id: record.id, attempt, error: err.message, waitMs: wait });
            await sleep(wait);
          } else {
            emit('confirm_retry', { id: record.id, attempt, error: err.message, waitMs: 0 });
          }
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
        const unrecorded = await settle(OUTCOME.IN_DOUBT);
        emit('done', { outcome: OUTCOME.IN_DOUBT, cause: lastError.message, unrecorded });
        return {
          outcome: OUTCOME.IN_DOUBT, cause: lastError.message, stranded,
          journal: journal_, held, done, committed,
        };
      }
    }

    const unrecorded = await settle(OUTCOME.COMMITTED);
    emit('done', { outcome: OUTCOME.COMMITTED, participants: planned.order });
    return { outcome: OUTCOME.COMMITTED, unrecorded, journal: journal_, held, done, committed };
  } catch (err) {
    // A process that has died does not unwind -- there is nothing left running
    // to do it. Recovery picks this up from the journal on the next start, and
    // simulating it any other way would test a code path that cannot happen.
    if (err.fatal) throw err;
    return unwind(err);
  }
}
