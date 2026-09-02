// A spec-faithful WebMCP implementation used only when the browser has none.
//
// WebMCP ships in the Chrome 149-156 origin trial. It is in no stable browser.
// The kernel's real work -- taint propagation, capability policy, deterministic
// replay -- is independent of who provides document.modelContext, so we develop
// against this and switch to native by feature detection, never by edit.
//
// Semantics implemented from the W3C draft:
//   registerTool(tool, {exposedTo, signal})  exposedTo gates cross-origin reads
//   getTools({fromOrigins})                  callers must name origins explicitly
//   executeTool(tool, args, {signal})        resolves to a JSON *string*
//   toolchange                               fires across the frame tree
//
// Not implemented: the "tools" permissions policy, which only a real browser can
// enforce. adapter.mjs reports that gap rather than papering over it.

const WIRE = '__ring0_webmcp__';
const ORIGIN = location.origin;

/** Ordered record of everything that crossed the frame boundary. */
export const wire = [];
const trace = (dir, msg, extra = {}) =>
  wire.push({ t: Math.round(performance.now()), dir, kind: msg.kind, id: msg.id, ...extra });
globalThis.__RING0_WIRE__ = wire;

/** Every window in this tab's frame tree. `frames` stays readable cross-origin. */
function frameTree(root = window.top) {
  const out = [];
  (function walk(w) {
    out.push(w);
    let n = 0;
    try { n = w.frames.length; } catch { return; }
    for (let i = 0; i < n; i++) { try { walk(w.frames[i]); } catch { /* opaque */ } }
  })(root);
  return out;
}

class ShimModelContext extends EventTarget {
  #local = new Map();      // name -> { tool, exposedTo }
  #pending = new Map();    // request id -> resolver
  #running = new Map();    // request id -> the controller for work in flight
  #seq = 0;

  constructor() {
    super();
    addEventListener('message', (e) => this.#onMessage(e));
  }

  /** A peer may see a tool if it is same-origin, or was explicitly exposed to it. */
  #visibleTo(entry, origin) {
    return origin === ORIGIN || (entry.exposedTo ?? []).includes(origin);
  }

  #descriptor(name, entry) {
    const { tool } = entry;
    return {
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      origin: ORIGIN,
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint ?? false,
        untrustedContentHint: tool.annotations?.untrustedContentHint ?? false,
      },
    };
  }

  #broadcast(msg) {
    for (const w of frameTree()) {
      if (w !== window) { try { w.postMessage({ [WIRE]: msg }, '*'); } catch { /* gone */ } }
    }
  }

  async #onMessage(e) {
    const msg = e.data?.[WIRE];
    if (!msg) return;
    trace('recv', msg, { from: e.origin });

    if (msg.kind === 'query') {
      const tools = [...this.#local]
        .filter(([, entry]) => this.#visibleTo(entry, e.origin))
        .map(([name, entry]) => this.#descriptor(name, entry));
      // Addressed to the origin that asked, not broadcast. Tool descriptors and
      // arguments were going to every frame in the tab.
      e.source?.postMessage({ [WIRE]: { kind: 'tools', id: msg.id, tools } }, e.origin);
      return;
    }

    if (msg.kind === 'abort') {
      // The caller gave up. Without this the executing side kept running and
      // the deadline was a caller-side timeout wearing a cancellation's name.
      this.#running.get(msg.id)?.abort(new Error('the caller abandoned this call'));
      this.#running.delete(msg.id);
      return;
    }

    if (msg.kind === 'exec') {
      const entry = this.#local.get(msg.name);
      // The visibility check is the security boundary. A tool that was never
      // exposed to this origin must be unreachable, not merely undiscoverable.
      if (!entry || !this.#visibleTo(entry, e.origin)) {
        e.source?.postMessage({ [WIRE]: {
          kind: 'result', id: msg.id, ok: false,
          error: `tool "${msg.name}" is not exposed to ${e.origin}`,
        } }, e.origin);
        return;
      }
      try {
        const controller = new AbortController();
        this.#running.set(msg.id, controller);
        const value = await entry.tool.execute(msg.args ?? {}, { signal: controller.signal })
          .finally(() => this.#running.delete(msg.id));
        e.source?.postMessage({ [WIRE]: { kind: 'result', id: msg.id, ok: true, value: JSON.stringify(value) } }, e.origin);
      } catch (err) {
        e.source?.postMessage({ [WIRE]: { kind: 'result', id: msg.id, ok: false, error: String(err?.message ?? err) } }, e.origin);
      }
      return;
    }

    if (msg.kind === 'tools' || msg.kind === 'result') {
      const waiting = this.#pending.get(msg.id);
      // A reply is only a reply if it came back from the frame the request went
      // to. Request ids were a public counter, so without this any frame in the
      // tree could forge a tool result -- including a fabricated attestation --
      // by guessing the next number.
      if (!waiting) return;
      if (waiting.window && e.source !== waiting.window) return;
      this.#pending.delete(msg.id);
      waiting.resolve({ msg, source: e.source, origin: e.origin });
      return;
    }

    if (msg.kind === 'toolchange') this.dispatchEvent(new Event('toolchange'));
  }

  async registerTool(tool, options = {}) {
    if (!tool?.name || !tool?.description) throw new TypeError('name and description are required');
    if (typeof tool.execute !== 'function') throw new TypeError('execute must be a function');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) throw new TypeError(`illegal tool name "${tool.name}"`);
    if (this.#local.has(tool.name)) throw new DOMException(`duplicate tool "${tool.name}"`, 'InvalidStateError');

    this.#local.set(tool.name, { tool, exposedTo: options.exposedTo });

    // Registration lifetime is a capability handle: abort revokes the grant.
    options.signal?.addEventListener('abort', () => {
      this.#local.delete(tool.name);
      this.dispatchEvent(new Event('toolchange'));
      this.#broadcast({ kind: 'toolchange' });
    }, { once: true });

    this.dispatchEvent(new Event('toolchange'));
    this.#broadcast({ kind: 'toolchange' });
  }

  async getTools(options = {}) {
    const wanted = options.fromOrigins ?? [];
    const mine = [...this.#local].map(([name, entry]) => ({ ...this.#descriptor(name, entry), window }));

    const replies = await Promise.all(frameTree()
      .filter((w) => w !== window)
      .map((w) => {
        const id = `${ORIGIN}#${crypto.randomUUID()}`;
        const settled = new Promise((resolve) => {
          this.#pending.set(id, { resolve, window: w });
          setTimeout(() => { this.#pending.delete(id); resolve(null); }, 250);
        });
        try { trace('send', { kind: 'query', id }); w.postMessage({ [WIRE]: { kind: 'query', id } }, '*'); }
        catch { return null; }
        return settled;
      }));

    const remote = [];
    for (const reply of replies) {
      if (!reply?.msg?.tools) continue;
      // Same-origin peers are implicit; cross-origin peers must be named by the
      // caller. Discovery is opt-in on both sides, which is the whole point.
      if (reply.origin !== ORIGIN && !wanted.includes(reply.origin)) continue;
      for (const t of reply.msg.tools) remote.push({ ...t, origin: reply.origin, window: reply.source });
    }
    return [...mine, ...remote];
  }

  async executeTool(tool, args = {}, options = {}) {
    // Chrome's API takes a JSON string. Accepting both keeps one call site
    // working against the shim and the native implementation alike.
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (tool.origin === ORIGIN && this.#local.has(tool.name)) {
      const entry = this.#local.get(tool.name);
      const signal = options.signal ?? new AbortController().signal;
      return JSON.stringify(await entry.tool.execute(args, { signal }));
    }

    const id = `${ORIGIN}#${crypto.randomUUID()}`;
    const settled = new Promise((resolve, reject) => {
      this.#pending.set(id, {
        window: tool.window,
        resolve: ({ msg }) => msg.ok ? resolve(msg.value) : reject(new Error(msg.error)),
      });
      options.signal?.addEventListener('abort', () => {
        this.#pending.delete(id);
        // Tell the other frame to stop, rather than only stopping listening.
        try { tool.window.postMessage({ [WIRE]: { kind: 'abort', id } }, tool.origin); } catch { /* gone */ }
        reject(new DOMException('tool execution aborted', 'AbortError'));
      }, { once: true });
      setTimeout(() => { if (this.#pending.delete(id)) reject(new Error('tool execution timed out')); }, 8000);
    });
    trace('send', { kind: 'exec', id }, { tool: tool.name, to: tool.origin });
    // Addressed to the participant's origin. Arguments and results -- including
    // signed attestations -- were being posted to every frame in the tab.
    tool.window.postMessage({ [WIRE]: { kind: 'exec', id, name: tool.name, args } }, tool.origin);
    return settled;
  }
}

export function installShim() {
  const ctx = new ShimModelContext();
  Object.defineProperty(document, 'modelContext', { value: ctx, configurable: true });
  return ctx;
}
