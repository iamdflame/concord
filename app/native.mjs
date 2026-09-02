// Does this browser have WebMCP, and does it behave the way Concord assumes?
//
// The project was built against a Chrome that predates the origin trial, so
// everything runs on a polyfill unless told otherwise. That is stated on every
// test run, but "provider=shim" in a terminal is not the same as knowing which
// specific assumptions hold on the real API. Each row below is one assumption
// the implementation makes, checked rather than believed.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const rows = [];
function row(state, what, observed) {
  rows.push({ state, what, observed: String(observed) });
  $('rows').insertAdjacentHTML('beforeend',
    `<tr><td class="r ${state === 'yes' ? 'ok' : state === 'no' ? 'no' : 'na'}">${
      { yes: '✓ yes', no: '✗ no', na: '– n/a' }[state]}</td>` +
    `<td>${esc(what)}</td><td class="n">${esc(observed)}</td></tr>`);
}

const surface = document.modelContext ? 'document.modelContext'
  : navigator.modelContext ? 'navigator.modelContext' : null;
const mc = document.modelContext ?? navigator.modelContext ?? null;

$('verdict').textContent = mc ? 'NATIVE WebMCP is present' : 'NO native WebMCP — the polyfill would be used';
$('verdict').dataset.s = mc ? 'native' : 'shim';
$('where').textContent = `${location.origin} · ${navigator.userAgent}`;

row(mc ? 'yes' : 'no', 'document.modelContext exists', surface ?? 'neither spelling is defined');

if (!mc) {
  row('na', 'everything below needs the native API', 'Concord installs its polyfill and runs; '
    + 'the security model is then enforced by its own JavaScript rather than by the browser');
} else {
  const name = `native_check_${Math.random().toString(36).slice(2, 8)}`;
  let registered = false;

  // 1 — registration resolves, and accepts exposedTo
  try {
    const p = mc.registerTool({
      name, title: 'Native check', description: 'Registered by Concord to test this browser.',
      inputSchema: { type: 'object', properties: { echo: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      execute: async ({ echo }) => ({ content: [{ type: 'text', text: `echo:${echo}` }], echo }),
    }, { exposedTo: [location.origin] });
    row(typeof p?.then === 'function' ? 'yes' : 'no', 'registerTool returns a promise',
      typeof p?.then === 'function' ? 'thenable' : typeof p);
    await p;
    registered = true;
    row('yes', 'registerTool accepts { exposedTo }', 'resolved without throwing');
  } catch (err) {
    row('no', 'registerTool accepts { exposedTo }', err.message);
  }

  // 2 — discovery
  let tool = null;
  try {
    const tools = await mc.getTools();
    tool = tools.find((t) => t.name === name);
    row(tool ? 'yes' : 'no', 'getTools() returns what was registered',
      `${tools.length} tool(s); ours ${tool ? 'present' : 'missing'}`);
  } catch (err) {
    row('no', 'getTools()', err.message);
  }

  try {
    const scoped = await mc.getTools({ fromOrigins: [location.origin] });
    row('yes', 'getTools({ fromOrigins }) is accepted', `${scoped.length} tool(s)`);
  } catch (err) {
    row('no', 'getTools({ fromOrigins }) is accepted', err.message);
  }

  // 3 — the argument and return contract, which the implementation depends on
  if (tool) {
    try {
      const out = await mc.executeTool(tool, JSON.stringify({ echo: 'hello' }));
      const kind = typeof out;
      let parsed = null;
      if (kind === 'string') { try { parsed = JSON.parse(out); } catch { /* a bare string */ } }
      row('yes', 'executeTool accepts a JSON string', `returned ${kind}`);
      row(kind === 'string' ? 'yes' : 'no', 'executeTool returns a string, as the docs show',
        kind === 'string'
          ? (parsed ? 'a JSON string, which is what Concord parses' : `a bare string: ${String(out).slice(0, 60)}`)
          : `an ${kind} — Concord handles both, but the docs say string`);
    } catch (err) {
      row('no', 'executeTool accepts a JSON string', err.message);
    }

    try {
      const out = await mc.executeTool(tool, { echo: 'hello' });
      row('yes', 'executeTool also accepts an object', `returned ${typeof out}`);
    } catch (err) {
      row('no', 'executeTool also accepts an object', `${err.name}: ${err.message}`);
    }
  }

  // 4 — duplicate names
  try {
    await mc.registerTool({ name, description: 'duplicate', execute: async () => ({}) });
    row('no', 'a duplicate tool name is rejected', 'it was accepted, which Concord does not expect');
  } catch (err) {
    row('yes', 'a duplicate tool name is rejected', `${err.name}: ${err.message}`);
  }

  // 5 — revocation through AbortSignal, which is how Concord unregisters
  try {
    const controller = new AbortController();
    const temp = `${name}_temp`;
    await mc.registerTool({ name: temp, description: 'temporary', execute: async () => ({}) },
      { signal: controller.signal });
    const before = (await mc.getTools()).some((t) => t.name === temp);
    controller.abort();
    await new Promise((r) => setTimeout(r, 120));
    const after = (await mc.getTools()).some((t) => t.name === temp);
    row(before && !after ? 'yes' : 'no', 'aborting a registration unregisters the tool',
      `present=${before}, then present=${after}`);
  } catch (err) {
    row('no', 'aborting a registration unregisters the tool', err.message);
  }

  // 6 — toolchange
  try {
    const fired = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 1500);
      mc.addEventListener('toolchange', () => { clearTimeout(t); resolve(true); }, { once: true });
      mc.registerTool({ name: `${name}_evt`, description: 'event probe', execute: async () => ({}) })
        .catch(() => {});
    });
    row(fired ? 'yes' : 'no', 'toolchange fires on registration', fired ? 'fired' : 'no event within 1.5s');
  } catch (err) {
    row('no', 'toolchange fires on registration', err.message);
  }

  if (registered) { try { await mc.unregisterTool?.(name); } catch { /* optional */ } }
}

// permissions policy, reported honestly
const api = document.permissionsPolicy ?? document.featurePolicy ?? null;
let policy = 'unreadable';
if (api?.allowsFeature) {
  try {
    const known = typeof api.features === 'function' ? api.features().includes('tools') : true;
    policy = !known ? 'unsupported by this browser' : api.allowsFeature('tools') ? 'granted' : 'withheld';
  } catch { policy = 'unreadable'; }
}
row(policy === 'granted' ? 'yes' : 'na', 'the "tools" permissions policy', policy);

const report = [
  `Concord native WebMCP check`,
  `${location.origin}`,
  `${navigator.userAgent}`,
  ``,
  mc ? `NATIVE (${surface})` : `NO NATIVE WEBMCP — polyfill would be used`,
  ``,
  ...rows.map((r) => `${r.state === 'yes' ? '[ok]  ' : r.state === 'no' ? '[FAIL]' : '[n/a] '} ${r.what}\n        ${r.observed}`),
].join('\n');

$('report').textContent = report;
$('copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(report); $('copyBtn').textContent = 'Copied — paste it back'; }
  catch { $('report').hidden = false; $('copyBtn').textContent = 'Select the text below and copy it'; }
});

globalThis.__RING0_RESULTS__ = { done: true, verdict: mc ? 'PASS' : 'FAIL', provider: mc ? 'native' : 'shim',
  rows: rows.map((r) => ({ id: r.what, state: r.state === 'yes' ? 'pass' : r.state === 'no' ? 'fail' : 'warn' })) };
