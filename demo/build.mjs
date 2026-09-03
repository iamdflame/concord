#!/usr/bin/env node
// Render a page of cards to PNGs, one per card, supersampled at 2x.
//
// Same fonts, same palette and the same mark as the product: a title card set
// in a different typeface than the thing it introduces reads as a template
// somebody dropped the project into.
//
//   CHROME=/path/to/chrome node demo/build.mjs
//   PAGE=thumbnail.html W=1280 H=720 OUT=. DOWNSCALE=1 node demo/build.mjs
//
// DOWNSCALE keeps the 2x render as supersampling and hands back a file at
// exactly W x H, which is what YouTube asks for and what keeps a flat dark
// PNG comfortably under its 2MB ceiling.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? 'google-chrome';
const PAGE = process.env.PAGE ?? 'cards.html';
const OUT = process.env.OUT ?? 'cards';
const W = Number(process.env.W ?? 1920);
const H = Number(process.env.H ?? 1080);
const PORT = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pillow, rather than a JPEG-quality argument to Chrome: a box filter over a
// 2x render is why the type has no jaggies at 1280 wide.
const downscale = (file) => new Promise((res, rej) => {
  const py = spawn('python3', ['-c', `
import sys
from PIL import Image
f = sys.argv[1]
im = Image.open(f).convert('RGB').resize((${W}, ${H}), Image.LANCZOS)
im.save(f, optimize=True)
`, file], { stdio: ['ignore', 'ignore', 'inherit'] });
  py.on('exit', (c) => (c === 0 ? res() : rej(new Error(`downscale failed (${c}) for ${file}`))));
});

const profile = await mkdtemp(join(tmpdir(), 'concord-cards-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--window-size=${W},${H}`, '--default-background-color=00000000',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

try {
  await mkdir(join(HERE, OUT), { recursive: true });
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
    { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send('Page.navigate', { url: `file://${join(HERE, PAGE)}` }, sessionId);

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
    // --default-background-color is a flag for the browser's own painting; it
    // does not reach a CDP screenshot, which composites onto opaque white
    // unless the override below is set. A lower third with no alpha is a white
    // rectangle over the whole recording, so this is not cosmetic.
    const transparent = await run(`globalThis.__SHOW__(${JSON.stringify(name)})`);
    await send('Emulation.setDefaultBackgroundColorOverride',
      transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {}, sessionId);
    await sleep(120);
    const { data } = await send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false }, sessionId);
    const file = join(HERE, OUT, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    if (process.env.DOWNSCALE) await downscale(file);
    console.log(`  ${relative(process.cwd(), file)}`);
  }
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) {
    try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
  }
}
