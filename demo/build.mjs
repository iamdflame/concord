#!/usr/bin/env node
// Render demo/cards.html to 1920x1080 PNGs, one per card, at 2x.
//
// Same fonts, same palette and the same mark as the product: a title card set
// in a different typeface than the thing it introduces reads as a template
// somebody dropped the project into.
//
//   CHROME=/path/to/chrome node demo/build.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? 'google-chrome';
const PORT = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(join(tmpdir(), 'concord-cards-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=1920,1080', '--default-background-color=00000000',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

try {
  await mkdir(join(HERE, 'cards'), { recursive: true });
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
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send('Page.navigate', { url: `file://${join(HERE, 'cards.html')}` }, sessionId);

  const run = async (expression) => (await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;

  for (let i = 0; i < 100; i++) {
    if (await run('Boolean(globalThis.__READY__)')) break;
    await sleep(100);
  }
  // The fonts are the point; a card shot before they load is set in Times.
  await run('document.fonts.ready.then(() => true)');
  await sleep(400);

  const names = await run('globalThis.__CARDS__');
  for (const name of names) {
    await run(`globalThis.__SHOW__(${JSON.stringify(name)})`);
    await sleep(120);
    const { data } = await send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false }, sessionId);
    await writeFile(join(HERE, 'cards', `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  demo/cards/${name}.png`);
  }
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) {
    try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
  }
}
