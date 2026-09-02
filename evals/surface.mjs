#!/usr/bin/env node
// The surface matrix.
//
// Concord's central claim is not that concord_commit refuses when it should.
// It is that concord_commit does not exist until a person has accepted the
// exact guarantee they were shown, and stops existing the moment that stops
// being true. A claim like that is worth nothing asserted in a README: it is
// checkable from outside, in a browser, through the same getTools() an agent
// would call, so that is where it is checked.
//
// Every row below is a state the coordinator can be in and the exact set of
// tool names an agent may see in it. A tool that appears early is a hole in
// the permission model; a tool that never appears is a broken product. Both
// fail here.
//
//   node evals/surface.mjs                     against npm run dev
//   URL=https://… node evals/surface.mjs       against a deployment

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'google-chrome';
const URL_ = process.env.URL ?? 'http://localhost:5173/concord.html';
const PORT = 9700 + Math.floor(Math.random() * 200);

const READ_ONLY = [
  'concord_get_surface', 'concord_inspect_vendor',
  'concord_list_vendors', 'concord_propose_commitment',
];
const WITH_EXPLAIN = [...READ_ONLY, 'concord_explain_guarantee'].sort();
const WITH_COMMIT = [...WITH_EXPLAIN, 'concord_commit'].sort();

// Nothing that grants permission may ever be a tool. If one of these is ever
// registered, an agent can arm itself and the entire design is decoration.
const FORBIDDEN = /^(accept|approve|arm|authoriz?e|consent|grant|go_ahead|proceed|override)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'concord-surface-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--window-size=1200,900',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0, failures = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  ws = new WebSocket(target);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: URL_ }, sessionId);

  const run = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''));
    return result.value;
  };

  for (let i = 0; i < 150; i++) {
    if (await run('Boolean(globalThis.__CONCORD_READY__ || globalThis.__CONCORD_ERROR__)')) break;
    await sleep(200);
  }
  if (await run('globalThis.__CONCORD_ERROR__ ?? null')) {
    throw new Error(`the coordinator did not start: ${await run('globalThis.__CONCORD_ERROR__')}`);
  }

  // Installed once and left running: every tool set the document ever offers
  // is recorded, so a tool that flickers into existence for one turn is caught
  // rather than missed between two polls.
  await run(`(() => {
    const ctx = document.modelContext ?? navigator.modelContext;
    globalThis.__SEEN__ = [];
    globalThis.__NAMES__ = async () =>
      (await ctx.getTools()).map((t) => t.name).sort();
    globalThis.__RECORD__ = async () => {
      const n = await globalThis.__NAMES__();
      const last = globalThis.__SEEN__.at(-1);
      if (!last || last.join() !== n.join()) globalThis.__SEEN__.push(n);
      return n;
    };
    ctx.addEventListener?.('toolchange', () => { globalThis.__RECORD__(); });
    return true;
  })()`);

  const names = () => run('globalThis.__RECORD__()');
  const concord = (list) => list.filter((n) => n.startsWith('concord_')).sort();

  console.log(`\n  ${URL_}\n`);

  // ── 1. boot ──────────────────────────────────────────────────────────────
  const booted = await names();
  check(JSON.stringify(concord(booted)) === JSON.stringify(READ_ONLY),
    'at boot, only the four read-only tools are registered', concord(booted).join(' '));

  // Vendor tools live on vendor origins and are exposed to this document, but
  // they must never be part of the surface an agent drives here: an agent that
  // can call hold_seat has walked around the ladder entirely.
  const strays = booted.filter((n) => !n.startsWith('concord_'));
  check(strays.length === 0,
    'no vendor tool is on the coordinator surface', strays.join(' ') || 'none');

  // ── 2. a proposal, explained ─────────────────────────────────────────────
  // Waited for, not budgeted for. Under load this machine has taken twenty
  // seconds to get a proposal on screen, and a fixed poll that gives up early
  // then asserts anyway reports the permission model as broken when what
  // actually happened is that nothing had been proposed yet.
  const proposed = await run(`(async () => {
    const $ = (id) => document.getElementById(id);
    $('q').value = 'Book me London for three nights — flight, hotel and the visa fee.';
    $('ask').requestSubmit();
    for (let i = 0; i < 600 && $('commit').hidden; i++) {
      await globalThis.__RECORD__();
      await new Promise((r) => setTimeout(r, 100));
    }
    return !$('commit').hidden;
  })()`);
  check(proposed, 'a proposal reaches the screen with a guarantee to accept',
    proposed ? '' : 'nothing was proposed in sixty seconds; the checks below mean nothing');

  const explained = await names();
  check(JSON.stringify(concord(explained)) === JSON.stringify(WITH_EXPLAIN),
    'after proposing and explaining, there is still no concord_commit', concord(explained).join(' '));

  // ── 3. the human accepts ─────────────────────────────────────────────────
  await run(`document.getElementById('commit').click()`);
  let armed = null;
  for (let i = 0; i < 1500 && !armed; i++) {
    const n = concord(await names());
    if (n.includes('concord_commit')) armed = n;
    await sleep(20);
  }
  check(Boolean(armed) && JSON.stringify(armed) === JSON.stringify(WITH_COMMIT),
    'accepting the guarantee registers concord_commit, and nothing else',
    armed ? armed.join(' ') : 'concord_commit never appeared');

  // ── 4. spent ─────────────────────────────────────────────────────────────
  let after = null;
  for (let i = 0; i < 900; i++) {
    const n = concord(await names());
    if (!n.includes('concord_commit')) { after = n; break; }
    await sleep(50);
  }
  check(Boolean(after), 'the moment a commitment starts, concord_commit is unregistered',
    after ? after.join(' ') : 'it was still registered when the run ended');

  // It goes the instant commit() marks itself spent, which is before the saga
  // runs -- deliberately, so a second call arriving mid-flight finds nothing.
  // That means its absence is not a signal that the commitment has finished,
  // and the page ignores a new question while one is still running. Waiting
  // for the outcome is what makes the next step mean anything.
  const settled = await run(`(async () => {
    for (let i = 0; i < 900 && !globalThis.__CONCORD_LAST__; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return globalThis.__CONCORD_LAST__?.outcome ?? null;
  })()`);
  check(settled === 'committed', 'and the commitment it was spent on settles', String(settled));

  // ── 5. a refusal ─────────────────────────────────────────────────────────
  // Waited on a change, not on a phrase appearing within a fixed budget. The
  // headline is the only signal this step has -- there is no button that
  // appears -- so the wait is "until it is not what it was", which is true as
  // soon as the answer lands however long that takes.
  const refusedHero = await run(`(async () => {
    const $ = (id) => document.getElementById(id);
    const before = $('verdict').textContent;
    $('q').value = 'Flight, visa fee and the entry permit.';
    $('ask').requestSubmit();
    for (let i = 0; i < 900; i++) {
      await globalThis.__RECORD__();
      if ($('verdict').textContent !== before) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Settle: the surface reconciles a beat after the headline changes.
    await new Promise((r) => setTimeout(r, 600));
    await globalThis.__RECORD__();
    return $('verdict').textContent;
  })()`);
  check(/not a promise I can make/.test(String(refusedHero)),
    'the second ask is refused rather than quietly planned', String(refusedHero).slice(0, 60));
  const refused = concord(await names());
  check(!refused.includes('concord_commit'),
    'a refused plan, explained in full, still registers no concord_commit', refused.join(' '));

  // ── 6. nothing that grants permission is ever a tool ─────────────────────
  const everySet = await run('globalThis.__SEEN__');
  const everyName = [...new Set(everySet.flat())];
  const granting = everyName.filter((n) => FORBIDDEN.test(n.replace(/^concord_/, '')));
  check(granting.length === 0,
    'no tool that grants permission was registered at any point in the run',
    granting.join(' ') || `${everyName.length} distinct names seen, none of them grant anything`);

  console.log(`\n  ${everySet.length} distinct surfaces observed:`);
  for (const set of everySet) console.log(`    ${concord(set).map((n) => n.replace('concord_', '')).join(' ')}`);
} catch (err) {
  check(false, 'the eval itself failed', err.message);
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) {
    try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
  }
}

console.log(failures ? `\nSURFACE FAILED — ${failures} check(s)` : '\nSURFACE PASSED');
process.exit(failures ? 1 : 0);
