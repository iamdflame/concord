import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AgentSurface, Refused, digestOf, desiredNames, FORBIDDEN } from './agent-surface.mjs';
import { OUTCOME } from './saga.mjs';

const ws = (steps) => ({ ...steps, status: { tool: 'lookup' } });
const fly  = { id: 'fly',  title: 'Northwind Air', origin: 'https://fly.example',
  protocol: { steps: ws({ reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } }) } };
const stay = { id: 'stay', title: 'Rowan House', origin: 'https://stay.example',
  protocol: { steps: ws({ execute: { tool: 'book' }, compensate: { tool: 'refund' } }) } };
const visa = { id: 'visa', title: 'Consular Fee', origin: 'https://visa.example',
  protocol: { steps: ws({ execute: { tool: 'charge' } }) } };
const permit = { id: 'permit', title: 'Entry Permit', origin: 'https://permit.example',
  protocol: { steps: ws({ execute: { tool: 'pay' } }) } };

function surface(participants = [fly, stay, visa], onChange = () => {}) {
  const touched = [];
  const bind = () => {
    const call = async (id, tool, args, { step }) => { touched.push(`${id}.${step}`); return { ref: `${id}-ref` }; };
    call.attestations = []; call.vendors = {};
    return call;
  };
  return { s: new AgentSurface({ participants, bind, onChange }), touched };
}

test('nothing that grants permission is a tool, in any state', () => {
  // The safety property is the shape of the surface, not a prompt asking an
  // agent to behave. desiredNames() is the whole permission model, so it is
  // swept exhaustively rather than sampled: every combination of what may have
  // happened, and what an agent may call in each.
  const bits = ['committable', 'explained', 'accepted', 'committed'];
  const states = [];
  for (let mask = 0; mask < 32; mask++) {
    states.push({
      proposalId: mask & 16 ? 'proposal_x' : null,
      ...Object.fromEntries(bits.map((b, i) => [b, Boolean(mask & (1 << i))])),
    });
  }

  const READ_ONLY = ['concord_get_surface', 'concord_inspect_vendor',
                     'concord_list_vendors', 'concord_propose_commitment'];

  for (const state of states) {
    const names = desiredNames(state).sort();
    const where = JSON.stringify(state);

    // The four read tools are unconditional. A page that cannot be asked what
    // it can do is a page nobody can use safely.
    for (const n of READ_ONLY) assert.ok(names.includes(n), `${n} missing in ${where}`);

    // Nothing grants permission, ever.
    for (const n of names) {
      assert.ok(!FORBIDDEN.some((f) => n.replace(/^concord_/, '').startsWith(f)),
        `${n} is a permission-granting tool, offered in ${where}`);
    }

    // And the one that matters: commit exists only when every one of these is
    // true at once. Any single bit off and the tool is not there to call.
    const mayCommit = Boolean(state.proposalId) && state.committable
      && state.explained && state.accepted && !state.committed;
    assert.equal(names.includes('concord_commit'), mayCommit,
      `concord_commit ${mayCommit ? 'should' : 'must not'} be registered in ${where}`);
  }

  // One state in thirty-two. Written down because it is the number that makes
  // the claim concrete, and because if it ever goes up somebody has widened the
  // gate and this line is where they will have to say so.
  assert.equal(states.filter((st) => desiredNames(st).includes('concord_commit')).length, 1,
    'exactly one of the thirty-two states permits committing');
});

test('every registered tool name is one the permission model names', () => {
  // agent-tools.mjs registers from a definitions table. A tool defined there
  // and not named by desiredNames() can never be reached, and one named and
  // not defined throws at registration; both are caught by reading the file,
  // because its browser-absolute imports mean it cannot be loaded here.
  const src = readFileSync(new URL('../app/agent-tools.mjs', import.meta.url), 'utf8');
  const defined = [...src.matchAll(/^    (concord_[a-z_]+): \{$/gm)].map((m) => m[1]).sort();
  const reachable = [...new Set([
    ...desiredNames({ proposalId: null }),
    ...desiredNames({ proposalId: 'p', committable: true, explained: true, accepted: true }),
  ])].sort();
  assert.deepEqual(defined, reachable,
    'the tools that exist and the tools that can ever be registered are the same set');
});

test('proposing contacts nobody', () => {
  const { s, touched } = surface();
  const out = s.propose({ intent: 'a trip to London', vendors: ['fly', 'stay', 'visa'] });
  assert.equal(out.guarantee, 'bounded');
  assert.deepEqual(touched, [], 'a proposal is a question about the future');
});

/** Everything the surface needs before commit may exist: explain, then accept. */
async function accept(s, proposalId) {
  const said = await s.explain({ proposalId });
  return s.accept({ proposalId, digest: said.explanationDigest });
}

test('an agent cannot commit something it has not explained', async () => {
  // This is the claim: nobody is committed to something they were not first
  // told the shape of.
  const { s, touched } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay'] });

  await assert.rejects(() => s.commit({ proposalId }), (e) =>
    e instanceof Refused && /has not been explained/.test(e.message) && e.needs === 'explain_guarantee');
  assert.deepEqual(touched, [], 'and nothing was contacted while refusing');

  await accept(s, proposalId);
  const done = await s.commit({ proposalId });
  assert.equal(done.outcome, OUTCOME.COMMITTED);
});

test('explaining is not accepting, and only a person can accept', async () => {
  // The gate that matters. An agent may explain as often as it likes; the
  // surface stays exactly as unarmed as it was, because accept() is not a tool
  // and is only reachable from a click in the coordinator's own document.
  const { s, touched } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay'] });

  await s.explain({ proposalId });
  await s.explain({ proposalId });
  assert.equal(s.state().explained, true);
  assert.equal(s.state().accepted, false, 'explaining twice is not consent');

  await assert.rejects(() => s.commit({ proposalId }), (e) =>
    e instanceof Refused && /nobody has accepted/.test(e.message));
  assert.deepEqual(touched, []);
});

test('what is accepted is the guarantee that was shown, not the proposal id', async () => {
  // A digest over the explanation itself. A coordinator that shows one set of
  // promises and commits another has to produce a hash of the one it showed,
  // and an acceptance cannot be carried from one proposal to the next.
  const { s } = surface();
  const a = s.propose({ intent: 'flight only', vendors: ['fly'] });
  const said = await s.explain({ proposalId: a.proposalId });

  assert.match(said.explanationDigest, /^[0-9a-f]{64}$/);
  assert.throws(() => s.accept({ proposalId: a.proposalId, digest: 'deadbeef' }),
    (e) => e instanceof Refused && /not the guarantee that was explained/.test(e.message));
  assert.equal(s.state().accepted, false);

  // The digest is over the explanation's content, so recomputing it from the
  // object anyone was handed reproduces it exactly.
  assert.equal(await digestOf(said), said.explanationDigest);
  s.accept({ proposalId: a.proposalId, digest: said.explanationDigest });
  assert.equal(s.state().accepted, true);

  // A different set of promises. Accepting the first cannot commit the second,
  // and asking again withdraws the first acceptance entirely.
  const b = s.propose({ intent: 'flight and hotel', vendors: ['fly', 'stay'] });
  assert.equal(s.state().accepted, false, 'a new question is not the accepted one');
  const alsoSaid = await s.explain({ proposalId: b.proposalId });
  assert.notEqual(alsoSaid.explanationDigest, said.explanationDigest);
  assert.throws(() => s.accept({ proposalId: b.proposalId, digest: said.explanationDigest }), Refused);
});

test('the state that decides which tools exist is reported, and changes are announced', async () => {
  // The reconciler registers from this and concord_get_surface reads it, so a
  // state that lies is a commit tool that exists when it should not.
  const seen = [];
  const { s } = surface(undefined, (state) => seen.push(state));

  assert.deepEqual(s.state(),
    { proposalId: null, committable: false, explained: false, accepted: false,
      committed: false, guarantee: null, hasReceipt: false });

  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay'] });
  assert.equal(s.state().committable, true);
  await accept(s, proposalId);
  assert.deepEqual(
    [s.state().explained, s.state().accepted, s.state().committed], [true, true, false]);

  await s.commit({ proposalId });
  assert.equal(s.state().committed, true);
  assert.deepEqual(seen.map((x) => [x.explained, x.accepted, x.committed]),
    [[false, false, false], [true, false, false], [true, true, false], [true, true, true]],
    'one announcement per change, in order');
});

test('a plan the ladder refused yields nothing an agent can commit', async () => {
  const { s, touched } = surface([fly, visa, permit]);
  const out = s.propose({ intent: 'trip with two irreversible fees', vendors: ['fly', 'visa', 'permit'] });

  assert.equal(out.committable, false);
  assert.match(out.refusal, /both irreversible/);

  // Explaining it works -- the agent is expected to relay the reason.
  const said = await s.explain({ proposalId: out.proposalId });
  assert.match(said.summary, /^Cannot be done as one commitment/);

  // But explaining a refusal must not unlock it, and neither must a person:
  // there is no guarantee here to accept, so the click that would arm the
  // commit tool has nothing to arm.
  assert.throws(() => s.accept({ proposalId: out.proposalId, digest: said.explanationDigest }),
    (e) => e instanceof Refused && /nothing here to accept/.test(e.message));
  await assert.rejects(() => s.commit({ proposalId: out.proposalId }),
    (e) => e instanceof Refused && /cannot be committed/.test(e.message));
  assert.deepEqual(touched, []);
});

test('the explanation names the point of no return by vendor, not by index', async () => {
  const { s } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay', 'visa'] });
  const said = await s.explain({ proposalId });
  assert.equal(said.pointOfNoReturn, 'visa');
  assert.match(said.caveats.join(' '), /cannot be reversed/);
  assert.equal(said.recoverable, true);
});

test('a commitment cannot be made twice', async () => {
  const { s } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly'] });
  await accept(s, proposalId);
  await s.commit({ proposalId });
  await assert.rejects(() => s.commit({ proposalId }), /already been committed/);
});

test('an agent cannot invent a vendor', () => {
  const { s } = surface();
  assert.throws(() => s.propose({ intent: 'x', vendors: ['fly', 'yacht'] }),
    (e) => e instanceof Refused && /no vendor called yacht/.test(e.message));
  assert.throws(() => s.propose({ intent: 'x', vendors: [] }), Refused);
});

test('an agent cannot commit a proposal it did not get from here', async () => {
  const { s } = surface();
  await assert.rejects(() => s.commit({ proposalId: 'proposal_made-up' }), /no proposal/);
  await assert.rejects(() => s.explain({ proposalId: 'proposal_made-up' }), /no proposal/);
  assert.throws(() => s.accept({ proposalId: 'proposal_made-up', digest: 'x' }), /no proposal/);
});

test('what an agent can see about a vendor includes whether it can be asked what happened', () => {
  const { s } = surface([fly, { ...stay, protocol: { steps: { execute: { tool: 'book' }, compensate: { tool: 'refund' } } } }]);
  const seen = s.listVendors();
  assert.equal(seen.find((v) => v.id === 'fly').canBeAskedWhatHappened, true);
  assert.equal(seen.find((v) => v.id === 'stay').canBeAskedWhatHappened, false);
});
