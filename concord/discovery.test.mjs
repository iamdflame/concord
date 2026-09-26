// One participant being down must not look like all of them being down.
//
// getTools({ fromOrigins }) rejects for the whole call when any one of the
// named origins cannot be reached. Discovery batched every origin into one
// such call and swallowed the rejection, so a single unreachable participant
// produced an empty result, the coordinator reported "0 of 6 answered" with
// five of them healthy, and replaced its page with a failure screen.
//
// That is the opposite of what this project argues. A commitment is over
// whoever granted; a coordinator that stops because one unrelated site is down
// is exactly as fragile as the marketplace it exists to replace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from './client.mjs';
import { awaitParticipants } from '../kit/harness.mjs';

const ORIGINS = ['https://a.example', 'https://b.example', 'https://c.example'];

/**
 * A model context where some origins answer and one does not.
 *
 * The dead origin *rejects* rather than returning nothing, because that is
 * what a browser does for an origin it cannot reach — and returning nothing is
 * the version of this that already worked.
 */
function context({ dead = [], slow = [], coldMs = 0 } = {}) {
  const calls = [];
  const bootedAt = Date.now() + coldMs;   // a serverless origin waking from cold
  const toolsFor = (origin) => [
    { origin, name: 'concord.protocol', inputSchema: { type: 'object', properties: {} } },
    { origin, name: 'hold', inputSchema: { type: 'object', properties: {} } },
  ];
  let ticks = 0;
  return {
    calls,
    async getTools({ fromOrigins } = {}) {
      calls.push(fromOrigins);
      const wanted = fromOrigins ?? ORIGINS;
      if (wanted.some((o) => dead.includes(o))) {
        throw new Error(`net::ERR_NAME_NOT_RESOLVED ${wanted.find((o) => dead.includes(o))}`);
      }
      // Cold is not dead. A deployment that has been idle rejects exactly like
      // an absent one for the first few seconds, and then answers.
      if (Date.now() < bootedAt) throw new Error(`net::ERR_CONNECTION_TIMED_OUT ${wanted[0]}`);
      const ready = wanted.filter((o) => !slow.includes(o) || ticks++ > 4);
      return ready.flatMap(toolsFor);
    },
    async executeTool(tool) {
      return JSON.stringify({ id: tool.origin.replace(/\W/g, ''), title: tool.origin,
        steps: { execute: { tool: 'hold' } } });
    },
  };
}

test('one unreachable participant does not hide the others', async () => {
  const ctx = context({ dead: ['https://b.example'] });
  const found = await discover(ctx, ORIGINS);

  assert.equal(found.length, 2, 'the two reachable participants are still found');
  assert.deepEqual(found.map((p) => p.origin), ['https://a.example', 'https://c.example']);

  // And the reason it works: nobody is asked about anybody else.
  assert.ok(ctx.calls.every((o) => o.length === 1),
    'every getTools call names exactly one origin, so one rejection cannot take the rest');
});

test('waiting reports who arrived and who did not, rather than failing', async () => {
  // It resolves. Who is present is a fact for the caller to display, not an
  // exception -- rejecting is what turned one dead site into a blank page.
  const ctx = context({ dead: ['https://b.example'] });
  const { present, absent } = await awaitParticipants(ctx, ORIGINS, 600);

  assert.deepEqual(present, ['https://a.example', 'https://c.example']);
  assert.deepEqual(absent, ['https://b.example']);
});

test('a participant that is merely slow is waited for', async () => {
  const ctx = context({ slow: ['https://c.example'] });
  const { present, absent } = await awaitParticipants(ctx, ORIGINS, 4000);
  assert.deepEqual(absent, [], 'slow is not the same as absent');
  assert.equal(present.length, 3);
});

test('when nothing answers at all, that is reported as everything absent', async () => {
  // The one case a coordinator genuinely cannot proceed from, and the only one
  // that should ever replace the page.
  const ctx = context({ dead: ORIGINS });
  const { present, absent } = await awaitParticipants(ctx, ORIGINS, 400);
  assert.deepEqual(present, []);
  assert.deepEqual(absent, ORIGINS);
  assert.deepEqual(await discover(ctx, ORIGINS), []);
});


test('an origin that is cold is not an origin that is gone', async () => {
  // The bug this encodes cost the live deployment a failure screen.
  //
  // Six participants are six independent serverless deployments. Idle for a
  // few weeks, they are six simultaneous cold starts, and for the first
  // several seconds every one of them rejects exactly the way an origin that
  // does not exist rejects. The coordinator waited eight seconds, concluded
  // nobody was there, and replaced its page -- for the first visitor after a
  // quiet period, which is the visitor it most needed to work for.
  //
  // Warm, these origins answer in about 3.5 seconds. That was never the
  // problem; the problem was one window and a dead end at the end of it.
  const ctx = context({ coldMs: 900 });

  // The short window: genuinely nobody, and the caller is told so rather than
  // being thrown at.
  const first = await awaitParticipants(ctx, ORIGINS, 300);
  assert.deepEqual(first.present, [], 'nothing has woken up yet');
  assert.deepEqual(first.absent, ORIGINS);

  // The second window, which is the fix. Same origins, more patience.
  const arrivals = [];
  const second = await awaitParticipants(ctx, ORIGINS, 4000, {
    onProgress: (p) => arrivals.push(p.origin),
  });
  assert.deepEqual(second.absent, [], 'cold origins answered once given time');
  assert.equal(second.present.length, ORIGINS.length);

  // And each one was reported as it arrived, so a visitor sees progress
  // instead of a blank page for the length of a cold start.
  assert.deepEqual([...arrivals].sort(), [...ORIGINS].sort());
});

test('progress is reported per participant, not only at the end', async () => {
  const ctx = context({ slow: ['https://c.example'] });
  const seen = [];
  await awaitParticipants(ctx, ORIGINS, 4000, { onProgress: (p) => seen.push(p) });

  assert.equal(seen.length, ORIGINS.length, 'one report per participant');
  assert.deepEqual(seen.at(-1).waiting, [], 'the last report says nobody is left');
  assert.equal(seen.at(-1).present.length, ORIGINS.length);
  assert.ok(seen.every((p) => typeof p.arrivedMs === 'number'),
    'each report says how long that participant took');
});
