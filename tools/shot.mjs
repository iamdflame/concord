// Loads a page in headless Chrome, optionally drives it, and saves a PNG.
// Used to check the monitor with eyes rather than by assertion alone.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'google-chrome';
const URL_ = process.env.URL ?? 'http://localhost:5173/monitor.html';
const OUT = process.env.OUT ?? 'shot.png';
const STEPS = Number(process.env.STEPS ?? 0);   // ArrowLeft presses from the end
const PORT = 9600 + Math.floor(Math.random() * 300);

const profile = await mkdtemp(join(tmpdir(), 'ring0shot-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1400,900',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

try {
  let url;
  for (let i = 0; i < 80 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send('Page.navigate', { url: URL_ }, sessionId);

  for (let i = 0; i < 90; i++) {
    const { result } = await send('Runtime.evaluate',
      { expression: 'Boolean(globalThis.__RING0_MONITOR__)', returnByValue: true }, sessionId);
    if (result.value) break;
    await sleep(200);
  }

  // Arbitrary driving script, so a screenshot can capture a state the page only
  // reaches after someone interacts with it.
  if (process.env.DO) {
    await send('Runtime.evaluate', { expression: process.env.DO, awaitPromise: true }, sessionId);
    await sleep(Number(process.env.SETTLE ?? 1800));
  }

  if (STEPS > 0) {
    await send('Runtime.evaluate', { expression: `document.getElementById('scrub').focus()` }, sessionId);
    for (let i = 0; i < STEPS; i++) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, sessionId);
      await sleep(60);
    }
  }
  await sleep(400);

  const { result: state } = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      head: document.getElementById('headT')?.textContent ?? document.getElementById('verdict')?.textContent,
      tags: [...document.querySelectorAll('#tags .tag')].map(t => t.textContent),
      denied: document.getElementById('denied')?.textContent ?? '',
      chain: document.getElementById('chain')?.textContent ?? '',
      settled: document.getElementById('settled')?.textContent.trim().slice(0,70) ?? '',
      outcome: document.querySelector('.outcome b')?.textContent ?? '',
      stranded: document.querySelector('.outcome p')?.textContent?.slice(0,180) ?? '',
    })`, returnByValue: true }, sessionId);
  console.log(state.value);

  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(OUT, Buffer.from(data, 'base64'));
  console.log(`saved ${OUT}`);
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) { try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); } }
}
