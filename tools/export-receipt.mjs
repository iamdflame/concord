#!/usr/bin/env node
// Run a commitment in a real browser and write the receipt to a file.
//
// The receipt has to be able to leave the tab, or a vendor is still taking the
// coordinator's word for it. This is the other half of tools/verify-receipt.mjs:
// one produces the artefact, the other checks it with nothing else to hand.
//
//   node tools/export-receipt.mjs receipt.json [trip|nofee|hold]
//
// It asks the agent, waits for the guarantee to be read back, and consents --
// the same path a person takes, because there is no other one.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2];
const scenario = process.argv[3] ?? 'trip';
if (!out) {
  console.error('usage: node tools/export-receipt.mjs <receipt.json> [trip|nofee|hold]');
  process.exit(2);
}

const CHROME = process.env.CHROME ?? 'google-chrome';
const URL_ = process.env.URL ?? 'http://localhost:5173/concord.html';
const PORT = 9800 + Math.floor(Math.random() * 190);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(join(tmpdir(), 'concord-export-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});
const evaluate = (expression, sessionId) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);

let code = 0;
try {
  let endpoint;
  for (let i = 0; i < 90 && !endpoint; i++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  if (!endpoint) throw new Error('Chrome never opened a DevTools endpoint');

  ws = new WebSocket(endpoint);
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

  for (let i = 0; i < 100; i++) {
    const { result } = await evaluate('Boolean(globalThis.__CONCORD_READY__)', sessionId);
    if (result.value) break;
    await sleep(200);
  }

  // Drive the agent, not the buttons. There is no way to commit that does not
  // go through a proposal the agent explained first, which is the point.
  const ASKS = {
    trip:  'Book me London for three nights — flight, hotel and the visa fee.',
    nofee: 'A flight and a hotel, nothing I cannot take back.',
    hold:  'Just hold me a seat.',
  };
  const ask = ASKS[scenario] ?? ASKS.trip;
  await evaluate(
    `(() => { document.getElementById('q').value = ${JSON.stringify(ask)};
              document.getElementById('ask').requestSubmit(); })()`, sessionId);

  // Wait for the agent to have read the guarantee back and offered the choice.
  let offered = false;
  for (let i = 0; i < 80; i++) {
    const { result } = await evaluate(
      `(() => { const b = document.getElementById('commit'); return Boolean(b && !b.hidden); })()`, sessionId);
    if (result.value) { offered = true; break; }
    await sleep(250);
  }
  if (!offered) {
    const { result } = await evaluate(
      `document.querySelector('#transcript .msg.agent:last-child p')?.textContent ?? ''`, sessionId);
    throw new Error(`the agent did not offer a commitment: ${String(result.value).slice(0, 160)}`);
  }

  await evaluate(`document.getElementById('commit').click()`, sessionId);
  for (let i = 0; i < 160; i++) {
    const { result } = await evaluate('Boolean(globalThis.__CONCORD_RECEIPT__)', sessionId);
    if (result.value) break;
    await sleep(250);
  }

  const { result } = await evaluate('JSON.stringify(globalThis.__CONCORD_RECEIPT__ ?? null)', sessionId);
  if (!result.value || result.value === 'null') throw new Error('the commitment produced no receipt');

  await writeFile(out, result.value);
  const receipt = JSON.parse(result.value);
  console.log(`wrote ${out}`);
  console.log(`  saga    ${receipt.sagaId}  ${receipt.outcome}`);
  console.log(`  root    ${receipt.root}`);
  console.log(`  ${receipt.entries.length} statements from ${new Set(receipt.entries.map((e) => e.statement.vendor)).size} vendors`);
  console.log(`\nverify it with:  node tools/verify-receipt.mjs ${out}`);
} catch (err) {
  console.error(`could not export a receipt: ${err.message}`);
  console.error('is `npm run dev` running?');
  code = 2;
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) { try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); } }
}
process.exit(code);
