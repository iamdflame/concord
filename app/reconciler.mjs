// Registration as the permission system.
//
// Concord's whole claim is that an agent cannot overpromise because the words
// for it do not exist. Until now that was three-quarters true: the four tools
// were registered when the page booted, and concord_commit refused inside
// execute() if the guarantee had not been explained. A refusal is a good
// answer and a bad mechanism. It puts the constraint in a branch, where it can
// be got wrong, where an agent must call the tool to discover it, and where
// anyone reading getTools() sees a commit tool sitting there looking callable.
//
// Absence is the stronger statement, and it is the one WebMCP is shaped for:
// AbortController is the only unregister the API has, so the set of tools *is*
// the set of permissions, live. This module keeps that set honest.
//
// Everything below exists because of something that goes wrong without it:
//
//   - one AbortController per tool, because aborting the batch to remove one
//     tool removes all of them;
//   - a serialized queue, because registerTool is async and two overlapping
//     reconciles leave a tool registered that both of them meant to remove;
//   - an in-flight guard, because unregistering a tool whose execute is still
//     running tells the agent its call failed, and a commit that reports
//     failure after committing is the single worst outcome this project has;
//   - argument checking in execute, because the browser does not validate
//     inputSchema and a typo'd key would otherwise arrive as undefined and be
//     acted on;
//   - an output budget, because a truncated JSON blob is worse than a short
//     list that says how many it left out.

const BUDGET = 1800;

/** Refuse arguments the schema did not describe, and say which. */
function checkArgs(name, schema, args) {
  const allowed = new Set(Object.keys(schema?.properties ?? {}));
  const extra = Object.keys(args ?? {}).filter((k) => !allowed.has(k));
  if (extra.length) {
    const near = (k) => [...allowed].find((a) => a.toLowerCase() === k.toLowerCase());
    return `${name} has no parameter ${extra.map((k) => {
      const guess = near(k);
      return guess ? `"${k}" (did you mean "${guess}"?)` : `"${k}"`;
    }).join(', ')}. It takes ${allowed.size ? [...allowed].join(', ') : 'no parameters'}.`;
  }
  const missing = (schema?.required ?? []).filter((k) => args?.[k] === undefined);
  if (missing.length) return `${name} needs ${missing.join(', ')}.`;
  return null;
}

/**
 * Keep a long answer useful instead of merely short.
 *
 * Trimming the serialised string produces invalid JSON, which is worse than
 * either the long version or an honest summary. Arrays lose entries from the
 * end and say how many.
 */
export function budget(value, limit = BUDGET) {
  let out = value;
  // How long each list was to begin with. Counting against the previous pass
  // instead reported the last trim rather than the total -- sixty entries cut
  // to fifteen announced "15 omitted", which is a smaller lie than truncated
  // JSON and still a lie.
  const was = new Map();
  for (let i = 0; i < 8 && JSON.stringify(out).length > limit; i++) {
    const arrays = Object.entries(out ?? {}).filter(([k, v]) =>
      Array.isArray(v) && v.length > 1 && !k.endsWith('Omitted'));
    if (!arrays.length) break;
    const [key, list] = arrays.sort((a, b) => b[1].length - a[1].length)[0];
    if (!was.has(key)) was.set(key, list.length);
    const keep = Math.max(1, Math.floor(list.length / 2));
    out = { ...out, [key]: list.slice(0, keep), [`${key}Omitted`]: was.get(key) - keep };
  }
  return out;
}

export class Reconciler {
  #mc;
  #live = new Map();      // name -> { controller, retire }
  #inflight = new Set();
  #queue = Promise.resolve();
  #onSync;

  /** onSync fires after each reconcile, with the set that is now registered. */
  constructor(mc, onSync = () => {}) { this.#mc = mc; this.#onSync = onSync; }

  /** What is registered right now, as the agent would see it. */
  get names() { return [...this.#live.keys()].sort(); }

  /**
   * Make the registered set equal `wanted`.
   *
   * Serialized: registerTool is async, and two reconciles in flight at once
   * interleave into a set neither of them asked for. Callers get a promise for
   * their own turn, not for the queue.
   */
  sync(wanted, definitions) {
    this.#queue = this.#queue
      .then(() => this.#reconcile(wanted, definitions))
      .catch((err) => { console.error('[concord] reconcile failed', err); });
    return this.#queue;
  }

  async #reconcile(wanted, definitions) {
    const want = new Set(wanted);

    for (const [name, entry] of [...this.#live]) {
      if (want.has(name)) continue;
      if (this.#inflight.has(name)) {
        // Deferred, not skipped. Aborting now would cancel a call already in
        // progress; the wrapper retires it once the call has settled.
        entry.retire = true;
        continue;
      }
      entry.controller.abort();
      this.#live.delete(name);
    }

    for (const name of want) {
      if (this.#live.has(name)) continue;
      const def = definitions[name];
      if (!def) throw new Error(`no definition for ${name}`);
      const controller = new AbortController();
      const entry = { controller, retire: false };
      this.#live.set(name, entry);
      await this.#mc.registerTool({
        name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
        execute: this.#wrap(name, def, entry),
      }, { signal: controller.signal });
    }

    this.#onSync(this.names);
  }

  #wrap(name, def, entry) {
    return async (args, callCtx) => {
      const complaint = checkArgs(name, def.inputSchema, args);
      if (complaint) return def.refuse(complaint);

      this.#inflight.add(name);
      try {
        return await def.execute(args, callCtx);
      } finally {
        this.#inflight.delete(name);
        if (entry.retire && this.#live.get(name) === entry) {
          // Past the end of this task, not inside it. Aborting a controller
          // while the call it belongs to is still unwinding is the same hazard
          // this guard exists for, one turn later.
          setTimeout(() => {
            if (this.#live.get(name) === entry) {
              entry.controller.abort();
              this.#live.delete(name);
            }
          }, 0);
        }
      }
    };
  }

  /** Take everything down. Used when the page is going away. */
  async stop() {
    await this.sync([], {});
  }
}
