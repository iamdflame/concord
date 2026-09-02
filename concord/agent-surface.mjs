// The surface an agent is allowed to have.
//
// An agent that can spend your money across sites is the thing everyone is
// racing to ship and nobody can ship safely. The blocker was never capability
// -- models have been able to call tools for a while. The blocker is that an
// agent cannot make a promise it is able to keep. It says "I've booked your
// trip" having booked half of it, or "done" when a charge went through and a
// booking did not, because nothing underneath it can compute what is actually
// being risked.
//
// Concord computes exactly that. So the agent's job here is not to decide. It
// is to translate an intent into a proposal, and then to say out loud what the
// ladder worked out -- including when the answer is that no honest promise is
// available.
//
// The interesting part is that this is not a prompt asking an agent to behave.
// It is the shape of the tools it has:
//
//   - there is no tool that moves money. The only effectful tool is commit(),
//     and it will only run a plan the ladder already approved;
//   - commit() is not registered at all until a person has accepted the exact
//     guarantee they were shown. Not disabled, not refusing: absent from
//     getTools(). A refusal inside execute() is a good answer and a bad
//     mechanism -- it puts the constraint in a branch, it makes an agent call
//     the tool to find out, and it leaves a commit tool sitting in the surface
//     looking callable;
//   - a refused plan yields no committable proposal at all, and explaining a
//     refusal does not conjure one.
//
// An agent cannot overpromise here because the words for it do not exist.

import { plan as buildPlan, describe, GUARANTEE } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';
import { canonical } from '../kit/canonical.mjs';

/**
 * The fingerprint of an explanation.
 *
 * What a person accepts is a specific set of promises, not a proposal id. The
 * digest is over the canonical form of the explanation itself, so a coordinator
 * that showed one guarantee and committed another has to produce a matching
 * hash for the one it showed -- and an agent that proposes twice cannot carry
 * an acceptance from the first over to the second.
 *
 * The digest field is stripped before hashing, so the returned object hashes to
 * the value it carries and anyone can check that without knowing the order the
 * fields were assembled in.
 */
export const PROMISED = Object.freeze([
  'proposalId', 'guarantee', 'summary', 'caveats', 'order',
  'pointOfNoReturn', 'recoverable', 'committable',
]);

export async function digestOf(explanation) {
  // Exactly these fields, named, and not "everything except the digest".
  // Hashing the whole object meant that adding one envelope field -- whether
  // the person had accepted yet -- silently changed the digest of an unchanged
  // guarantee, so nobody could recompute it from what they had been handed.
  // A list is also the honest documentation of what an acceptance covers.
  const subject = Object.fromEntries(PROMISED.map((k) => [k, explanation?.[k] ?? null]));
  const bytes = new TextEncoder().encode(canonical(subject));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Which tools should exist, given what has actually happened.
 *
 * This function is the permission model. It is pure, it is nine lines, and it
 * is the thing to read if you want to know what an agent can do here. It lives
 * beside the surface rather than beside the registration code because what may
 * be called is a property of the commitment, not of how tools get published.
 */
export function desiredNames(state) {
  const names = ['concord_list_vendors', 'concord_inspect_vendor',
                 'concord_propose_commitment', 'concord_get_surface'];
  if (state.proposalId) names.push('concord_explain_guarantee');
  // Every condition, including that there is a proposal at all. state() cannot
  // currently produce accepted-without-a-proposal, but this function is the
  // permission model and being right only because of how its caller happens to
  // build its argument is how a hole gets opened by a change somewhere else.
  if (state.proposalId && state.committable && state.explained
      && state.accepted && !state.committed) {
    names.push('concord_commit');
  }
  return names;
}

/**
 * Names that must never appear on this surface, in any state.
 *
 * A tool that grants permission is a tool an agent can use to grant itself
 * permission, which would make every other control here decoration. There is
 * no such tool and there is not going to be one, so the prohibition is written
 * down and tested rather than left to whoever adds the next feature.
 */
export const FORBIDDEN = Object.freeze([
  'accept', 'approve', 'arm', 'authorise', 'authorize', 'consent', 'grant',
  'go_ahead', 'confirm_guarantee', 'i_understand', 'override', 'proceed',
]);

export class Refused extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'Refused'; Object.assign(this, detail); }
}

export class AgentSurface {
  #participants; #inputs; #journal; #bind; #proposals = new Map(); #onEvent; #onChange;
  #current = null;   // the proposal the surface is currently shaped around

  constructor({ participants, inputs = {}, journal = null, bind,
                onEvent = () => {}, onChange = () => {} }) {
    this.#participants = participants;
    this.#inputs = inputs;
    this.#journal = journal;
    this.#bind = bind;
    this.#onEvent = onEvent;
    // Fired whenever the set of tools that should exist has changed. The
    // surface does not register anything itself; it says what ought to be
    // there and something else makes that true.
    this.#onChange = onChange;
  }

  /**
   * What determines which tools exist, and why the missing ones are missing.
   *
   * This is the whole permission model in one object, and it is readable by an
   * agent through concord_get_surface -- because a tool that vanishes without
   * explanation is indistinguishable from a broken page.
   */
  state() {
    const p = this.#current;
    return {
      proposalId: p?.id ?? null,
      committable: p?.committable ?? false,
      explained: Boolean(p?.explained),
      accepted: Boolean(p?.accepted),
      committed: Boolean(p?.committed),
      guarantee: p?.planned?.guarantee ?? null,
      hasReceipt: Boolean(p?.committed),
    };
  }

  #changed() { this.#onChange(this.state()); }

  get proposals() { return this.#proposals; }

  /**
   * Replace the set of participants.
   *
   * A commitment is over whoever is present, and who is present can change: a
   * site can register while the page is open, and the coordinator finds out
   * from a toolchange rather than from a deployment. Proposals already made are
   * left alone -- they were computed over the participants of their moment, and
   * silently re-planning something a person was shown would be a different kind
   * of dishonesty.
   */
  update(participants) { this.#participants = participants; }

  /**
   * One participant, in detail.
   *
   * Separate from listVendors because the interesting fields are long and
   * because a vendor's own prose -- its title and its note -- is written by
   * somebody else and reaches the agent as data. It is marked as such where
   * this tool is registered.
   */
  inspectVendor({ vendor }) {
    const p = this.#participants.find((v) => v.id === vendor);
    if (!p) throw new Refused(`there is no vendor called ${vendor} here`);
    const steps = p.protocol?.steps ?? {};
    return {
      id: p.id,
      title: p.title,
      origin: p.origin,
      note: p.protocol?.note ?? null,
      steps: Object.fromEntries(Object.entries(steps).map(([phase, spec]) => [phase, {
        tool: spec.tool,
        ...(spec.ttlSeconds && { holdsForSeconds: spec.ttlSeconds }),
        ...(spec.refund && { refund: spec.refund }),
      }])),
      canBeAskedWhatHappened: Boolean(steps.status),
      declaresIrreversible: Boolean(p.protocol?.irreversible),
    };
  }

  /** What is available, and what each one can commit to. Read-only. */
  listVendors() {
    return this.#participants.map((p) => ({
      id: p.id,
      title: p.title,
      origin: p.origin,
      steps: Object.keys(p.protocol?.steps ?? {}),
      canBeAskedWhatHappened: Boolean(p.protocol?.steps?.status),
    }));
  }

  /**
   * Turn an intent into a proposal, and work out what could be promised.
   *
   * Nothing is contacted. A proposal is a question about the future, and the
   * answer to it may be no.
   */
  propose({ intent, vendors }) {
    const chosen = this.#participants.filter((p) => vendors?.includes(p.id));
    const unknown = (vendors ?? []).filter((v) => !this.#participants.some((p) => p.id === v));
    if (unknown.length) {
      throw new Refused(`there is no vendor called ${unknown.join(', ')} here`, { unknown });
    }
    if (!chosen.length) throw new Refused('a commitment needs at least one vendor');

    const withInput = chosen.map((p) => ({ ...p, input: this.#inputs[p.id] ?? {} }));
    const planned = buildPlan(withInput);
    const id = `proposal_${crypto.randomUUID()}`;

    const proposal = {
      id, intent, participants: withInput, planned,
      // A refused plan is recorded so it can be explained, and can never be
      // committed. The agent is expected to relay the reason, not route round it.
      committable: planned.guarantee !== GUARANTEE.REFUSED,
      explained: false, accepted: false, committed: false, digest: null,
    };
    this.#proposals.set(id, proposal);
    // Asking for something else is not a refinement of the last question. The
    // surface re-shapes around the new proposal, which means any acceptance of
    // the previous one stops existing -- along with the commit tool it bought.
    this.#current = proposal;
    this.#onEvent({ type: 'proposed', id, guarantee: planned.guarantee, intent });
    this.#changed();

    return {
      proposalId: id,
      intent,
      guarantee: planned.guarantee,
      committable: proposal.committable,
      order: planned.order,
      refusal: planned.refusal,
    };
  }

  /**
   * The honest promise, in full, and the record that it was given.
   *
   * commit() will not run until this has been called, so a human cannot be
   * committed to something nobody told them the shape of.
   */
  async explain({ proposalId }) {
    const p = this.#proposals.get(proposalId);
    if (!p) throw new Refused(`no proposal ${proposalId}`);

    const explanation = {
      proposalId,
      guarantee: p.planned.guarantee,
      summary: p.planned.refusal ? `Cannot be done as one commitment. ${p.planned.refusal}` : describe(p.planned),
      caveats: p.planned.caveats,
      order: p.planned.order,
      pointOfNoReturn: p.planned.pointOfNoReturn === null ? null : p.planned.order[p.planned.pointOfNoReturn],
      recoverable: p.planned.recoverable,
      committable: p.committable,
    };
    p.digest = await digestOf(explanation);
    p.explained = true;
    this.#onEvent({ type: 'explained', id: proposalId, digest: p.digest });
    this.#changed();

    // Explaining a refusal is required and buys nothing. Nothing below this
    // line differs for a refused plan except that accepting it is impossible,
    // so the commit tool it would have unlocked never appears.
    return { ...explanation, explanationDigest: p.digest, acceptedByPerson: p.accepted };
  }

  /**
   * A person accepting the guarantee that is on their screen.
   *
   * This is not a tool and never will be. It is reachable only from a click in
   * this document -- an agent that could call it could grant itself permission,
   * which is the one thing the whole arrangement is designed to prevent. It is
   * also the only thing that causes concord_commit to exist.
   *
   * It takes the digest rather than trusting the caller: the coordinator page
   * hashes the explanation it actually rendered, and if that does not match the
   * explanation this surface issued, the two disagree about what was on screen
   * and nothing is armed.
   */
  accept({ proposalId, digest }) {
    const p = this.#proposals.get(proposalId);
    if (!p) throw new Refused(`no proposal ${proposalId}`);
    if (!p.explained) throw new Refused('nothing has been explained for this proposal yet');
    if (!p.committable) {
      throw new Refused('there is nothing here to accept: no honest guarantee is available',
        { refusal: p.planned.refusal });
    }
    if (digest !== p.digest) {
      throw new Refused(
        'the guarantee that was accepted is not the guarantee that was explained',
        { expected: p.digest, got: digest ?? null });
    }
    p.accepted = true;
    p.acceptedAt = new Date().toISOString();
    this.#onEvent({ type: 'accepted', id: proposalId, digest });
    this.#changed();
    return { proposalId, accepted: true, digest };
  }

  /**
   * The only effectful thing an agent can reach.
   *
   * Every check below is a second lock on a door that should not be reachable:
   * if any of them can fire, the surface was registered when it should not have
   * been. They stay because a tool that is absent for the right reason and
   * refuses for the same reason is a tool that cannot be got wrong in one
   * place. If one of these throws in production, that is a bug in the
   * reconciler and it has just been caught before it cost anybody money.
   */
  async commit({ proposalId, digest }, { signal } = {}) {
    const p = this.#proposals.get(proposalId);
    if (!p) throw new Refused(`no proposal ${proposalId}`);

    if (!p.committable) {
      throw new Refused(
        `this cannot be committed: ${p.planned.refusal}`,
        { guarantee: p.planned.guarantee, refusal: p.planned.refusal });
    }
    if (!p.explained) {
      // Not a formality. The whole claim is that nobody is committed to
      // something they were not first told the shape of.
      throw new Refused(
        'the guarantee for this proposal has not been explained yet, so it cannot be committed',
        { needs: 'explain_guarantee' });
    }
    if (!p.accepted) {
      throw new Refused(
        'nobody has accepted this guarantee, so there is nothing to carry out',
        { needs: 'a person to accept it on the page' });
    }
    if (digest !== undefined && digest !== p.digest) {
      throw new Refused(
        'this is not the guarantee that was accepted',
        { expected: p.digest, got: digest });
    }
    if (p.committed) throw new Refused('this proposal has already been committed');
    p.committed = true;
    // The commit tool stops existing here rather than when the saga returns:
    // a second call arriving mid-flight must find nothing to call.
    this.#changed();

    const call = this.#bind(p.participants);
    const out = await runSaga({
      plan: p.planned, participants: p.participants, call,
      journal: this.#journal, onEvent: this.#onEvent, signal,
    });

    return {
      proposalId,
      outcome: out.outcome,
      stands: out.outcome === OUTCOME.COMMITTED ? p.planned.order : [],
      cause: out.cause ?? null,
      stranded: out.stranded ?? null,
      // A vendor that declared it could reverse something and then would not.
      // The agent has to be able to say whose promise was broken.
      broken: (out.failures ?? []).filter((f) => f.step === 'compensate' || f.step === 'cancel'),
      unrecorded: out.unrecorded ?? null,
      attestations: call.attestations,
      vendors: call.vendors,
      journal: out.journal,
    };
  }
}
