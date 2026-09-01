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
  async prune(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    const done = new Set(this.#rows
      .filter((r) => r.phase === PHASE.SETTLED && r.at < cutoff).map((r) => r.sagaId));
    const before = this.#rows.length;
    this.#rows = this.#rows.filter((r) => !done.has(r.sagaId));
    return before - this.#rows.length;
  }
}

/**
 * Survives a reload, and appends in constant time.
 *
 * The first version kept the whole journal in one localStorage string and
 * re-serialised all of it on every append. Three things were wrong with that,
 * and each gets worse the more there is to protect: it was O(n²); it was a
 * read-modify-write, so two open tabs silently lost each other's rows; and at
 * roughly five megabytes setItem throws, which aborted the saga from inside the
 * write that was supposed to make it recoverable.
 *
 * IndexedDB appends one record per transaction, which is atomic across tabs and
 * has room to spare.
 */
export class IndexedStore {
  #db = null;
  constructor(name = 'concord', store = 'journal') { this.name = name; this.store = store; }

  async #open() {
    if (this.#db) return this.#db;
    this.#db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.store)) {
          db.createObjectStore(this.store, { keyPath: 'seq', autoIncrement: true })
            .createIndex('sagaId', 'sagaId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.#db;
  }

  async #tx(mode, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, mode);
      const out = fn(tx.objectStore(this.store));
      tx.oncomplete = () => resolve(out?.result ?? out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('journal transaction aborted'));
    });
  }

  async append(row) { await this.#tx('readwrite', (s) => s.add(row)); }

  async read() {
    const rows = await this.#tx('readonly', (s) => s.getAll());
    return [...rows].sort((a, b) => a.seq - b.seq);
  }

  async clear() { await this.#tx('readwrite', (s) => s.clear()); }

  /** Drop rows belonging to sagas that reached a terminal state long enough ago. */
  async prune(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const rows = await this.read();
    const cutoff = Date.now() - olderThanMs;
    const done = new Set(rows.filter((r) => r.phase === PHASE.SETTLED && r.at < cutoff).map((r) => r.sagaId));
    if (!done.size) return 0;
    const doomed = rows.filter((r) => done.has(r.sagaId));
    await this.#tx('readwrite', (s) => { for (const r of doomed) s.delete(r.seq); });
    return doomed.length;
  }
}

/** Kept for environments without IndexedDB. Same caveats as before; use sparingly. */
export class LocalStore {
  constructor(key = 'concord.journal') { this.key = key; }
  #load() { try { return JSON.parse(localStorage.getItem(this.key) ?? '[]'); } catch { return []; } }
  async append(row) { localStorage.setItem(this.key, JSON.stringify([...this.#load(), row])); }
  async read() { return this.#load(); }
  async clear() { localStorage.removeItem(this.key); }
}

export const PHASE = {
  STARTED: 'started',   // the plan, recorded before the first call
  INTENT: 'intent',     // about to call; the side effect may or may not follow
  RESULT: 'result',     // the call returned, and this is what it returned
  FAILED: 'failed',     // the call threw; whether it took effect is unknown
  SETTLED: 'settled',   // the saga reached a terminal state
};

export class Journal {
  constructor(store = new MemoryStore()) { this.store = store; }

  /**
   * The plan, written before the first call.
   *
   * Without it, a saga that finished every step but died before the settled
   * marker is indistinguishable from one that died half way -- and recovery
   * cannot tell "there is nothing to do" from "undo everything". That gap
   * refunded a hotel for a trip that had completed.
   */
  async started(sagaId, steps) {
    await this.store.append({ phase: PHASE.STARTED, sagaId, steps, at: Date.now() });
  }

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

  /** Settled sagas are history, not state. Keeping them forever is how the
   *  durability layer eventually becomes the thing that fails. */
  async prune(olderThanMs) {
    return this.store.prune ? this.store.prune(olderThanMs) : 0;
  }

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
      const saga = sagas.get(row.sagaId)
        ?? { sagaId: row.sagaId, steps: new Map(), settled: null, plan: null };
      if (row.phase === PHASE.SETTLED) saga.settled = row.outcome;
      else if (row.phase === PHASE.STARTED) saga.plan = row.steps;
      else {
        const step = saga.steps.get(row.idempotencyKey)
          ?? { vendor: row.vendor, step: row.step, idempotencyKey: row.idempotencyKey,
               args: row.args, at: row.at };
        if (row.phase === PHASE.INTENT) { step.intended = true; step.at = row.at; }
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
        plan: s.plan,
        // Ordered as they were attempted, so a reversal can run newest-first
        // and mean it.
        all: [...s.steps.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        completed: [...s.steps.values()].filter((x) => x.done).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        // Intent written, nothing after it. The process died mid-call, so the
        // vendor may or may not have acted. Only the vendor knows.
        uncertain: [...s.steps.values()].filter((x) => x.intended && !x.done && !x.failed),
        failed: [...s.steps.values()].filter((x) => x.failed),
      }));
  }
}
