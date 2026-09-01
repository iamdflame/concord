// Drives headless Chrome over the DevTools protocol and reports what the
// browser actually is. No dependencies: Node ships a WebSocket client.
//
// An earlier version scraped --dump-dom under --virtual-time-budget. Virtual
// time fast-forwards timers but not cross-frame message round trips, so the
// shim's own timeouts fired first and the suite reported failures the code did
// not have. Real time, real event loop, explicit completion signal.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'google-chrome';
const URL_   = process.env.URL ?? 'http://localhost:5173/';
const PORT   = 9222 + Math.floor(Math.random() * 400);
const DEBUG  = process.env.DEBUG_WIRE === '1';

const profile = await mkdtemp(join(tmpdir(), 'ring0-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  // Harmless on browsers without WebMCP; required on those that gate it.
  '--enable-features=WebMCP,WebMachineLearningModelContext',
  '--enable-blink-features=WebMCP',
  'about:blank',
], { stdio: 'ignore' });

// Chrome keeps writing its profile for a moment after SIGKILL, so removing it
// immediately races and throws ENOTEMPTY. Teardown must never decide the exit
// code of a test run.
const cleanup = async () => {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(profile, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
};
process.on('exit', () => chrome.kill('SIGKILL'));

async function endpoint(deadline = Date.now() + 12000) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome never opened a DevTools endpoint');
}

function client(ws) {
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) listeners.forEach((fn) => fn(m));
  });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    }),
    on: (fn) => listeners.push(fn),
  };
}

let exitCode = 0;
try {
  const wsUrl = await endpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = client(ws);

  const version = await cdp.send('Browser.getVersion');
  const major = Number(version.product.match(/\/(\d+)\./)?.[1] ?? 0);
  console.log(`browser   ${version.product}`);
  console.log(`url       ${URL_}\n`);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const problems = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: URL_ }, sessionId);

  const deadline = Date.now() + 25000;
  let out = null;
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'globalThis.__RING0_RESULTS__ ?? null',
      returnByValue: true,
    }, sessionId);
    if (result.value?.done) { out = result.value; break; }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!out) {
    console.log('the suite never signalled completion within 25s.');
    problems.forEach((p) => console.log(`  console: ${p}`));
    exitCode = 2;
  } else if (out.verdict === 'THREW') {
    console.log(`the suite threw: ${out.error}`);
    exitCode = 2;
  } else {
    const rowText = await cdp.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('#rows tr')].map(r =>
        [...r.cells].map(c => c.textContent.trim()))`,
      returnByValue: true,
    }, sessionId);
    for (const [id, state, assertion, observed] of rowText.result.value ?? []) {
      const mark = { PASS: '  ok  ', FAIL: ' FAIL ', WARN: ' warn ' }[state] ?? '  ??  ';
      console.log(`${mark} ${id}  ${assertion}`);
      console.log(`        ${observed}`);
    }
    // The page names itself; the probe must not assume which suite it ran.
    const { result: banner } = await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('verdict')?.textContent ?? ''`,
      returnByValue: true,
    }, sessionId);
    console.log(`\n${banner.value || out.verdict}` +
                ` — provider=${out.provider}, tools-policy=${out.policy}`);

    if (DEBUG && out.wire?.length) {
      console.log('\nwire trace (kernel frame):');
      for (const w of out.wire) {
        console.log(`  ${String(w.t).padStart(5)}ms  ${w.dir.padEnd(4)} ${String(w.kind).padEnd(11)}` +
                    ` ${w.tool ?? ''} ${w.from ?? w.to ?? ''}`);
      }
    }
    exitCode = out.verdict === 'PASS' ? 0 : 1;
  }

  if (problems.length) {
    console.log('\npage problems:');
    [...new Set(problems)].forEach((p) => console.log(`  ${p.split('\n')[0]}`));
  }

  if (out?.provider !== 'native') {
    console.log(`\nWebMCP is NOT native in this browser (Chrome ${major}).`);
    console.log('Origin trial is Chrome 149-156; the API is in no stable channel.');
    console.log('These assertions prove the kernel logic. They prove nothing about the platform.');
  }
} catch (err) {
  console.error(`probe failed: ${err.message}`);
  exitCode = 2;
} finally {
  await cleanup();
}
process.exit(exitCode);
