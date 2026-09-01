// Phase 01 — prove the interception, and nothing else.
//
// Two modes have to hold or the whole architecture is wrong:
//
//   Mode A  kernel as agent  — the kernel discovers and dispatches another
//                              origin's tools itself, so every call crosses it
//                              by construction.
//   Mode B  kernel as shim   — the kernel registers a *proxy* tool. An external
//                              agent (ChatGPT's browser, Gemini in Chrome) can
//                              only see the proxy, so its entire affordance
//                              surface is mediated even though we do not own it.
//
// Mode B is the one that matters, because it protects agents we do not control.

import { resolveModelContext } from '/shim/adapter.mjs';
import { createSuite, awaitTools } from './harness.mjs';

const WORKLOAD = 'http://localhost:5174';
const { record, finish } = createSuite('PHASE 01');

const { ctx, provider, surface, policy } = await resolveModelContext();

// ── A1 ── which implementation are we actually testing against?
record('A1', true,
  'A model context is available',
  `${surface} · provider=${provider} · tools-policy=${policy}`,
  provider !== 'native');

// ── A2/A3 ── cross-origin discovery under mutual opt-in
const discovered = await awaitTools(ctx, [WORKLOAD], (t) => t.some((x) => x.name === 'get_balance'));
const balanceTool = discovered.find((t) => t.name === 'get_balance' && t.origin === WORKLOAD);

record('A2', discovered.length > 0,
  'Workload registers tools and the kernel observes the change',
  discovered.length ? `${discovered.length} tool(s) visible` : 'no tools observed before timeout');

record('A3', Boolean(balanceTool),
  'getTools({fromOrigins}) returns the cross-origin tool granted via exposedTo',
  balanceTool ? `${balanceTool.origin}/${balanceTool.name} · readOnly=${balanceTool.annotations?.readOnlyHint}`
              : 'get_balance not discoverable');

// ── A4 ── MODE A: the kernel dispatches across the origin boundary
let modeA = null;
try {
  const raw = await ctx.executeTool(balanceTool, { account: 'acct_main' });
  const parsed = JSON.parse(raw);
  modeA = parsed?.minor ?? parsed?.structuredContent?.minor;
  record('A4', modeA === 184230,
    'MODE A — kernel executes the cross-origin tool directly',
    `executeTool → ${raw.slice(0, 90)}`);
} catch (err) {
  record('A4', false, 'MODE A — kernel executes the cross-origin tool directly', `threw: ${err.message}`);
}

// ── A5/A6 ── the exposure boundary is real, not merely undocumented
record('A5', !discovered.some((t) => t.name === 'private_note'),
  'A tool with no exposedTo grant is invisible to this origin',
  discovered.some((t) => t.name === 'private_note') ? 'LEAKED — private_note was discoverable'
                                                    : 'private_note absent from discovery');

// Hiding a tool from discovery is not access control. Forge a descriptor
// pointing straight at it and confirm execution is refused too.
try {
  const forged = { name: 'private_note', origin: WORKLOAD, window: document.getElementById('workload').contentWindow };
  const leaked = await ctx.executeTool(forged, {});
  record('A6', !String(leaked).includes('CANARY'),
    'Execution of an ungranted tool is refused, not just hidden',
    `LEAKED — ${String(leaked).slice(0, 80)}`);
} catch (err) {
  // A timeout is not a refusal. Only an explicit denial proves the boundary,
  // so anything else fails here even though it also blocked the call.
  const refused = /not exposed|denied|not allowed/i.test(err.message);
  record('A6', refused,
    'Execution of an ungranted tool is refused, not just hidden',
    refused ? `refused: ${err.message}` : `inconclusive — blocked but not refused: ${err.message}`);
}

// ── A7/A8 ── MODE B: the proxy an external agent would see
let intercepted = null;
await ctx.registerTool({
  name: 'ring0.get_balance',
  title: 'Get account balance (mediated)',
  description: 'Kernel-mediated balance lookup. Every call is scheduled, labelled and recorded.',
  inputSchema: {
    type: 'object',
    properties: { account: { type: 'string', description: 'Account identifier' } },
    required: ['account'],
  },
  annotations: { readOnlyHint: true },
  async execute(args, { signal }) {
    // Phase 02 replaces this line with the policy gate and the taint lattice.
    // Phase 01 only has to prove the call is genuinely ours to intercept.
    intercepted = { tool: 'get_balance', args, at: performance.now() };
    const raw = await ctx.executeTool(balanceTool, args, { signal });
    return { content: [{ type: 'text', text: raw }], mediatedBy: 'ring0' };
  },
});

const own = await ctx.getTools();
const proxy = own.find((t) => t.name === 'ring0.get_balance');
record('A7', Boolean(proxy),
  'Kernel registers a proxy tool that an external agent can discover',
  proxy ? `${proxy.origin}/${proxy.name}` : 'proxy not registered');

try {
  // Exactly the path a browser agent takes: discover, then execute by descriptor.
  const raw = await ctx.executeTool(proxy, { account: 'acct_main' });
  const forwarded = raw.includes('184230');
  record('A8', forwarded && intercepted !== null && intercepted.args.account === 'acct_main',
    'MODE B — the proxy forwards and the kernel observed the call',
    `intercepted=${intercepted ? `get_balance(${intercepted.args.account})` : 'NO'} · forwarded=${forwarded}`);
} catch (err) {
  record('A8', false, 'MODE B — the proxy forwards and the kernel observed the call', `threw: ${err.message}`);
}

// ── verdict ──
finish({ provider, surface, policy });

// This suite makes a claim about the platform, so it says which one it tested.
if (provider !== 'native') {
  const el = document.getElementById('verdict');
  if (el && el.dataset.s === 'pass') {
    el.textContent = 'PHASE 01 PASSED — SHIM ONLY (kernel logic proven, browser unproven)';
  }
}
