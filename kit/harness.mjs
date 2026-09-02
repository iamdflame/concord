// Shared reporting for the phase suites. Renders to the page for a human and
// publishes a machine-readable result for tools/probe.mjs.

export function createSuite(name) {
  const rows = document.getElementById('rows');
  const results = [];

  const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

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
 * Wait for participants, and report who arrived and who did not.
 *
 * Each origin is asked on its own. A batched getTools({ fromOrigins }) rejects
 * for the whole call when one origin is unreachable, which made a single dead
 * participant look like six dead participants -- and took the coordinator's
 * page down with it.
 *
 * This resolves rather than rejects. Who is present is a fact the caller has to
 * act on, not an exception: a commitment is over whoever granted, and a
 * coordinator that refuses to start because one site is down is a coordinator
 * that has made itself as fragile as the marketplace it replaces. Deciding
 * what to do about an absence belongs to whoever is going to display it.
 */
export async function awaitParticipants(ctx, origins, ms = 8000) {
  const deadline = Date.now() + ms;
  const present = new Map();

  for (;;) {
    await Promise.all(origins.map(async (origin) => {
      if (present.has(origin)) return;
      try {
        const tools = await ctx.getTools({ fromOrigins: [origin] });
        if (tools.some((t) => t.origin === origin && t.name === 'concord.protocol')) {
          present.set(origin, tools);
        }
      } catch { /* this one is not here; the others still might be */ }
    }));
    if (present.size === origins.length || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    present: origins.filter((o) => present.has(o)),
    absent: origins.filter((o) => !present.has(o)),
  };
}

/**
 * Resolves once a predicate holds over discovered tools, rather than on a sleep.
 *
 * Kept for the phase suites, which are testing one origin at a time and do want
 * a rejection when it never appears.
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
