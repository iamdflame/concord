import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSurface, Refused } from './agent-surface.mjs';
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

function surface(participants = [fly, stay, visa]) {
  const touched = [];
  const bind = () => {
    const call = async (id, tool, args, { step }) => { touched.push(`${id}.${step}`); return { ref: `${id}-ref` }; };
    call.attestations = []; call.vendors = {};
    return call;
  };
  return { s: new AgentSurface({ participants, bind }), touched };
}

test('the surface offers no way to move money', () => {
  // The safety property is the shape of the tools, not a prompt asking an agent
  // to behave. There is nothing here that spends anything directly.
  const callable = Object.getOwnPropertyNames(AgentSurface.prototype)
    .filter((n) => n !== 'constructor')
    .filter((n) => typeof Object.getOwnPropertyDescriptor(AgentSurface.prototype, n).value === 'function');
  assert.deepEqual(callable.sort(), ['commit', 'explain', 'listVendors', 'propose']);

  // And of those, exactly one has any effect in the world.
  const { s } = surface();
  const before = s.listVendors();
  s.propose({ intent: 'x', vendors: ['fly'] });
  assert.deepEqual(s.listVendors(), before, 'nothing but commit may change anything');
});

test('proposing contacts nobody', () => {
  const { s, touched } = surface();
  const out = s.propose({ intent: 'a trip to London', vendors: ['fly', 'stay', 'visa'] });
  assert.equal(out.guarantee, 'bounded');
  assert.deepEqual(touched, [], 'a proposal is a question about the future');
});

test('an agent cannot commit something it has not explained', async () => {
  // This is the claim: nobody is committed to something they were not first
  // told the shape of.
  const { s, touched } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay'] });

  await assert.rejects(() => s.commit({ proposalId }), (e) =>
    e instanceof Refused && /has not been explained/.test(e.message) && e.needs === 'explain_guarantee');
  assert.deepEqual(touched, [], 'and nothing was contacted while refusing');

  s.explain({ proposalId });
  const done = await s.commit({ proposalId });
  assert.equal(done.outcome, OUTCOME.COMMITTED);
});

test('a plan the ladder refused yields nothing an agent can commit', async () => {
  const { s, touched } = surface([fly, visa, permit]);
  const out = s.propose({ intent: 'trip with two irreversible fees', vendors: ['fly', 'visa', 'permit'] });

  assert.equal(out.committable, false);
  assert.match(out.refusal, /both irreversible/);

  // Explaining it works -- the agent is expected to relay the reason.
  const said = s.explain({ proposalId: out.proposalId });
  assert.match(said.summary, /^Cannot be done as one commitment/);

  // But explaining a refusal must not unlock it.
  await assert.rejects(() => s.commit({ proposalId: out.proposalId }),
    (e) => e instanceof Refused && /cannot be committed/.test(e.message));
  assert.deepEqual(touched, []);
});

test('the explanation names the point of no return by vendor, not by index', () => {
  const { s } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly', 'stay', 'visa'] });
  const said = s.explain({ proposalId });
  assert.equal(said.pointOfNoReturn, 'visa');
  assert.match(said.caveats.join(' '), /cannot be reversed/);
  assert.equal(said.recoverable, true);
});

test('a commitment cannot be made twice', async () => {
  const { s } = surface();
  const { proposalId } = s.propose({ intent: 'trip', vendors: ['fly'] });
  s.explain({ proposalId });
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
  assert.throws(() => s.explain({ proposalId: 'proposal_made-up' }), /no proposal/);
});

test('what an agent can see about a vendor includes whether it can be asked what happened', () => {
  const { s } = surface([fly, { ...stay, protocol: { steps: { execute: { tool: 'book' }, compensate: { tool: 'refund' } } } }]);
  const seen = s.listVendors();
  assert.equal(seen.find((v) => v.id === 'fly').canBeAskedWhatHappened, true);
  assert.equal(seen.find((v) => v.id === 'stay').canBeAskedWhatHappened, false);
});
