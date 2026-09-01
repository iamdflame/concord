// The write-ahead journal.
//
// Until now the coordinator held `held` and `done` in JavaScript arrays. Close
// the tab after Rowan House has been charged and before the irreversible step,
// and $567 is stranded with nothing anywhere that knows to unwind it. That is
// the failure that costs money in production, and no amount of protocol
// correctness above it helps.
//
// So intent is recorded *before* the call, not after. The distinction is the
// whole point: a log that only records outcomes cannot tell "I was about to
// reserve" from "I never reserved", and those need opposite recoveries.
//
// The store is pluggable because durability means different things in a tab and
// on a server. What does not change is that the record is append-only and is
// flushed before the side effect it describes.

export class MemoryStore {
  #rows = [];
  async append(row) { this.#rows.push(row); }
  async read() { return [...this.#rows]; }
  async clear() { this.#rows = []; }
}

/** Survives a reload. A real deployment writes to its own durable store. */
export class LocalStore {
  constructor(key = 'concord.journal') { this.key = key; }
  #load() { try { return JSON.parse(localStorage.getItem(this.key) ?? '[]'); } catch { return []; } }
  async append(row) { localStorage.setItem(this.key, JSON.stringify([...this.#load(), row])); }
  async read() { return this.#load(); }
  async clear() { localStorage.removeItem(this.key); }
}

export const PHASE = {
  INTENT: 'intent',     // about to call; the side effect may or may not follow
  RESULT: 'result',     // the call returned, and this is what it returned
  FAILED: 'failed',     // the call threw; whether it took effect is unknown
  SETTLED: 'settled',   // the saga reached a terminal state
};

export class Journal {
  constructor(store = new MemoryStore()) { this.store = store; }

  /**
   * Record what we are about to do, before doing it.
   *
   * The idempotency key is written here and nowhere else invented, because it
   * is what recovery uses to ask the vendor whether this ever happened.
   */
  async intent(sagaId, vendor, step, idempotencyKey, args) {
    await this.store.append({ phase: PHASE.INTENT, sagaId, vendor, step, idempotencyKey, args, at: Date.now() });
  }
  async result(sagaId, vendor, step, idempotencyKey, result) {
    await this.store.append({ phase: PHASE.RESULT, sagaId, vendor, step, idempotencyKey, result, at: Date.now() });
  }
  async failed(sagaId, vendor, step, idempotencyKey, error) {
    await this.store.append({ phase: PHASE.FAILED, sagaId, vendor, step, idempotencyKey, error, at: Date.now() });
  }
  async settled(sagaId, outcome) {
    await this.store.append({ phase: PHASE.SETTLED, sagaId, outcome, at: Date.now() });
  }

  async read() { return this.store.read(); }

  /**
   * Sagas that started and never reached a terminal state.
   *
   * Each in-flight step is classified by what the log can prove, not by what is
   * likely: a step with an intent and no result is genuinely unknown, and
   * treating it as either done or not-done is how coordinators lose money.
   */
  async incomplete() {
    const rows = await this.read();
    const sagas = new Map();

    for (const row of rows) {
      const saga = sagas.get(row.sagaId) ?? { sagaId: row.sagaId, steps: new Map(), settled: null };
      if (row.phase === PHASE.SETTLED) saga.settled = row.outcome;
      else {
        const step = saga.steps.get(row.idempotencyKey)
          ?? { vendor: row.vendor, step: row.step, idempotencyKey: row.idempotencyKey, args: row.args };
        if (row.phase === PHASE.INTENT) step.intended = true;
        if (row.phase === PHASE.RESULT) { step.done = true; step.result = row.result; }
        if (row.phase === PHASE.FAILED) { step.failed = true; step.error = row.error; }
        saga.steps.set(row.idempotencyKey, step);
      }
      sagas.set(row.sagaId, saga);
    }

    return [...sagas.values()]
      .filter((s) => s.settled === null)
      .map((s) => ({
        sagaId: s.sagaId,
        completed: [...s.steps.values()].filter((x) => x.done),
        // Intent written, nothing after it. The process died mid-call, so the
        // vendor may or may not have acted. Only the vendor knows.
        uncertain: [...s.steps.values()].filter((x) => x.intended && !x.done && !x.failed),
        failed: [...s.steps.values()].filter((x) => x.failed),
      }));
  }
}
