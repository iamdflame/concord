// Shared reporting for the phase suites. Renders to the page for a human and
// publishes a machine-readable result for tools/probe.mjs.

export function createSuite(name) {
  const rows = document.getElementById('rows');
  const results = [];

  const esc = (s) => String(s).replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]));

  function record(id, ok, assertion, observed, soft = false) {
    const state = ok ? 'pass' : soft ? 'warn' : 'fail';
    results.push({ id, state, assertion });
    rows?.insertAdjacentHTML('beforeend',
      `<tr><td class="id">${id}</td><td class="st ${state}">${state.toUpperCase()}</td>` +
      `<td>${esc(assertion)}</td><td class="note">${esc(observed)}</td></tr>`);
    return ok;
  }

  function finish(extra = {}) {
    const failed = results.filter((r) => r.state === 'fail');
    const el = document.getElementById('verdict');
    if (el) {
      el.dataset.s = failed.length ? 'fail' : 'pass';
      el.textContent = failed.length
        ? `${name} FAILED — ${failed.map((r) => r.id).join(', ')}`
        : `${name} PASSED`;
    }
    document.title = `RING0_VERDICT ${failed.length ? 'FAIL' : 'PASS'}`;
    globalThis.__RING0_RESULTS__ = {
      done: true,
      verdict: failed.length ? 'FAIL' : 'PASS',
      rows: results,
      wire: globalThis.__RING0_WIRE__ ?? [],
      ...extra,
    };
  }

  // A suite that dies mid-run must say so, not hang looking like slow work.
  addEventListener('error', (e) => {
    globalThis.__RING0_RESULTS__ = { done: true, verdict: 'THREW', error: String(e.message) };
  });
  addEventListener('unhandledrejection', (e) => {
    globalThis.__RING0_RESULTS__ = { done: true, verdict: 'THREW', error: String(e.reason?.message ?? e.reason) };
  });

  return { record, finish, results };
}

/**
 * Resolves once a predicate holds over discovered tools, rather than on a sleep.
 *
 * On timeout it rejects. Resolving with whatever had arrived meant discovery
 * could silently come back short, a plan be computed over an incomplete set of
 * vendors, and a guarantee be displayed about parties never reached.
 */
export function awaitTools(ctx, origins, predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = async () => {
      let tools = [];
      try { tools = await ctx.getTools({ fromOrigins: origins }); } catch { /* not ready */ }
      if (predicate(tools)) return resolve(tools);
      if (Date.now() > deadline) {
        const found = [...new Set(tools.map((t) => t.origin))];
        return reject(new Error(
          `only ${found.length} of ${origins.length} participants answered within ${ms}ms`
          + ` (${origins.filter((o) => !found.includes(o)).join(', ')} did not)`));
      }
      setTimeout(poll, 120);
    };
    ctx.addEventListener?.('toolchange', poll, { once: true });
    poll();
  });
}
