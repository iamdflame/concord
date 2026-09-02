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
//   - commit() refuses a proposal that has not been explained, so the human has
//     always seen the honest guarantee before anything happens;
//   - a refused plan yields no committable proposal at all.
//
// An agent cannot overpromise here because the words for it do not exist.

import { plan as buildPlan, describe, GUARANTEE } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';

export class Refused extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'Refused'; Object.assign(this, detail); }
}

export class AgentSurface {
  #participants; #inputs; #journal; #bind; #proposals = new Map(); #onEvent;

  constructor({ participants, inputs = {}, journal = null, bind, onEvent = () => {} }) {
    this.#participants = participants;
    this.#inputs = inputs;
    this.#journal = journal;
    this.#bind = bind;
    this.#onEvent = onEvent;
  }

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
      explained: false, committed: false,
    };
    this.#proposals.set(id, proposal);
    this.#onEvent({ type: 'proposed', id, guarantee: planned.guarantee, intent });

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
  explain({ proposalId }) {
    const p = this.#proposals.get(proposalId);
    if (!p) throw new Refused(`no proposal ${proposalId}`);
    p.explained = true;
    this.#onEvent({ type: 'explained', id: proposalId });

    return {
      proposalId,
      guarantee: p.planned.guarantee,
      summary: p.planned.refusal ? `Cannot be done as one commitment. ${p.planned.refusal}` : describe(p.planned),
      caveats: p.planned.caveats,
      order: p.planned.order,
      pointOfNoReturn: p.planned.pointOfNoReturn === null ? null : p.planned.order[p.planned.pointOfNoReturn],
      recoverable: p.planned.recoverable,
      committable: p.committable,
    };
  }

  /** The only effectful thing an agent can reach, and it is heavily fenced. */
  async commit({ proposalId }) {
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
    if (p.committed) throw new Refused('this proposal has already been committed');
    p.committed = true;

    const call = this.#bind(p.participants);
    const out = await runSaga({
      plan: p.planned, participants: p.participants, call,
      journal: this.#journal, onEvent: this.#onEvent,
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
