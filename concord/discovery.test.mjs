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
function context({ dead = [], slow = [] } = {}) {
  const calls = [];
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
