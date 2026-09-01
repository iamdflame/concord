// Runs the synthesiser against real, unprepared sites and reports what came
// back -- including how much of it was read from the site's own declarations
// versus guessed from markup. The tier split is the honest measure: a
// synthesiser that cannot say how much it invented cannot be trusted.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'google-chrome';
const PORT = 9700 + Math.floor(Math.random() * 300);
const VERBOSE = process.env.VERBOSE === '1';
const SITES = process.argv.slice(2);

const source = await readFile(new URL('../synth/synthesize.mjs', import.meta.url), 'utf8');
const profile = await mkdtemp(join(tmpdir(), 'ring0synth-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=1280,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'],
  { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

const totals = { sites: 0, reached: 0, tools: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0 };

try {
  let url;
  for (let i = 0; i < 90 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    }
  });

  for (const site of SITES) {
    totals.sites += 1;
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);

    try {
      await send('Page.navigate', { url: site }, sessionId);
      await sleep(3200);   // let client-rendered markup settle

      await send('Runtime.evaluate', { expression: source }, sessionId);
      const { result } = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(__RING0_SYNTH__())', returnByValue: true,
      }, sessionId);

      const out = JSON.parse(result.value);
      totals.reached += 1;
      totals.tools += out.tools.length;
      for (const k of ['tier1', 'tier2', 'tier3', 'tier4']) totals[k] += out.counts[k] ?? 0;

      const split = ['tier1', 'tier2', 'tier3', 'tier4']
        .map((k) => `${k.replace('tier', 'T')}:${out.counts[k] ?? 0}`).join(' ');
      console.log(`\n\x1b[1m${new URL(site).hostname}\x1b[0m  ${out.tools.length} tools  [${split}]`);
      console.log(`  ${out.title.slice(0, 76)}`);

      for (const t of out.tools.slice(0, VERBOSE ? 99 : 5)) {
        const params = Object.entries(t.inputSchema.properties ?? {})
          .map(([k, v]) => `${k}:${v.enum ? `enum(${v.enum.length})` : v.type}`).join(', ');
        console.log(`  T${t._tier}  ${t.name}(${params || '—'})`);
        console.log(`      ${t.description.slice(0, 96)}`);
        if (VERBOSE) console.log(`      via ${t._origin}`);
      }
      if (!VERBOSE && out.tools.length > 5) console.log(`  … ${out.tools.length - 5} more`);
    } catch (err) {
      console.log(`\n\x1b[1m${new URL(site).hostname}\x1b[0m  unreachable — ${err.message.split('\n')[0]}`);
    }
    await send('Target.closeTarget', { targetId });
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${totals.reached}/${totals.sites} sites reached · ${totals.tools} tools synthesised`);
  const declared = totals.tier1 + totals.tier2 + totals.tier3;
  console.log(`read from the site's own declarations: ${declared}/${totals.tools}` +
              ` (${totals.tools ? Math.round((declared / totals.tools) * 100) : 0}%)`);
  console.log(`  T1 schema.org actions   ${totals.tier1}`);
  console.log(`  T2 OpenSearch           ${totals.tier2}`);
  console.log(`  T3 labelled forms       ${totals.tier3}`);
  console.log(`  T4 guessed from markup  ${totals.tier4}`);
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  for (let i = 0; i < 5; i++) { try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(200); } }
}
