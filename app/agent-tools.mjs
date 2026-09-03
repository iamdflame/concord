// Concord's agent-facing surface, published over WebMCP.
//
// The set of registered tools *is* the permission model, and it is live. Three
// tools are always there and they only read. Two more exist only under
// conditions, and when a condition stops holding the tool is unregistered --
// not disabled, not left up to refuse. Absence is the stronger statement and
// the one this API is shaped for: AbortController is the only unregister
// WebMCP has, so a tool that must not be callable is a tool that is not there.
//
// The condition on concord_commit is the whole design in one line: it exists
// only after a person has clicked Accept on the exact guarantee they were
// shown, identified by the hash of that guarantee. There is no tool that
// grants that, and there never will be. An agent driving this surface --
// ChatGPT's, Gemini's, the one in this page -- watches concord_commit appear
// when a human accepts and vanish when they ask for something else.
//
// concord_get_surface exists because a tool that disappears without
// explanation is indistinguishable from a broken page. It reports what is
// registered, what is not, and why.

import { AgentSurface, Refused, desiredNames, FORBIDDEN } from '/concord/agent-surface.mjs';
import { Reconciler, budget } from './reconciler.mjs';
import { askForAttention } from './attention.mjs';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const asRefusal = (err) => asText({
  refused: true,
  reason: typeof err === 'string' ? err : err.message,
  ...(err.needs && { youMustFirst: err.needs }),
  ...(err.refusal && { because: err.refusal }),
  ...(err.expected && { expectedDigest: err.expected, gotDigest: err.got }),
  thenCall: 'concord_get_surface',
});

/** Why each tool that is not registered is not registered, in the reader's terms. */
function absences(state) {
  const why = [];
  if (!state.proposalId) {
    why.push({ tool: 'concord_explain_guarantee', missing: 'nothing has been proposed yet' });
  }
  if (!desiredNames(state).includes('concord_commit')) {
    why.push({
      tool: 'concord_commit',
      missing: !state.proposalId ? 'nothing has been proposed yet'
        : !state.committable ? 'no honest guarantee is available for this proposal, so there is '
          + 'nothing that could be committed'
        : !state.explained ? 'the guarantee has not been explained yet'
        : !state.accepted ? 'the person has not accepted this guarantee. They accept it by '
          + 'clicking on the page. There is no tool for it and there will not be one'
        : 'this proposal has already been committed',
    });
  }
  return why;
}

export async function publishAgentTools({ ctx, participants, inputs, journal, bind,
                                         onEvent, onSurfaceChange = () => {} }) {
  const mc = document.modelContext ?? navigator.modelContext ?? ctx;
  const reconciler = new Reconciler(mc, onSurfaceChange);

  const surface = new AgentSurface({
    participants, inputs, journal, bind, onEvent,
    // Every change to what has happened is a change to what may be called.
    onChange: (state) => reconciler.sync(desiredNames(state), definitions),
  });

  /**
   * Wrap a surface method as a tool execute.
   *
   * `budgeted` is off for exactly one tool, and the reason is worth writing
   * down: an output budget shortens what an agent has to read, and commit's
   * result is not only read. It carries the vendors' signed attestations, and
   * the page builds the receipt out of them. Budgeting it halved that array
   * until the whole result fitted -- so a commitment across three vendors
   * produced a receipt with one statement in it, which then failed to verify.
   * The commitment had happened. The evidence for it had been trimmed to fit a
   * character count.
   *
   * Trimming evidence is not a size optimisation. Anything an agent reads may
   * be shortened; anything anyone later needs to check may not.
   */
  const guard = (fn, { budgeted = true } = {}) => async (args, callCtx) => {
    try {
      const value = await fn(args, callCtx);
      return asText(budgeted ? budget(value) : value);
    } catch (err) { return asRefusal(err); }
  };

  // outputSchema on every tool. An agent that knows the shape of what comes
  // back can check it rather than pattern-match prose, and for the two that
  // matter -- the guarantee and the outcome -- the enum is the honest set of
  // answers rather than a free string it has to interpret.
  const definitions = {
    concord_list_vendors: {
      title: 'List the vendors present',
      description: 'Returns the independent vendors in this tab and what each one can commit to: '
        + 'whether it can hold and release, commit and compensate, or only act irreversibly. '
        + 'Contacts nobody and changes nothing.',
      inputSchema: { type: 'object', properties: {} },
      // Vendor titles are written by the vendor. They arrive here as data.
      outputSchema: {
        type: 'object',
        properties: {
          vendors: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, title: { type: 'string' }, origin: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            canBeAskedWhatHappened: { type: 'boolean' },
          } } },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: guard(() => surface.listVendors()),
      refuse: asRefusal,
    },

    concord_inspect_vendor: {
      title: 'Look at one vendor in detail',
      description: 'Returns one vendor’s declared commitment protocol: which steps it names, '
        + 'how long a hold lasts, whether a compensation refunds in full, and whether it can be '
        + 'asked afterwards what happened. Contacts nobody.',
      inputSchema: {
        type: 'object',
        properties: { vendor: { type: 'string', description: 'A vendor id from concord_list_vendors' } },
        required: ['vendor'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, origin: { type: 'string' },
          note: { type: ['string', 'null'] },
          steps: { type: 'object' },
          canBeAskedWhatHappened: { type: 'boolean' },
          declaresIrreversible: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: guard(({ vendor }) => surface.inspectVendor({ vendor })),
      refuse: asRefusal,
    },

    concord_propose_commitment: {
      title: 'Propose a commitment across several vendors',
      description: 'Works out what could honestly be promised if these vendors were committed to '
        + 'together, without contacting any of them. Returns a proposal and a guarantee, which may '
        + 'be that no honest promise is available. Call this before doing anything else. Proposing '
        + 'again replaces the last proposal, including any acceptance it had.',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'What the person asked for, in their own words' },
          vendors: { type: 'array', items: { type: 'string' },
            description: 'Vendor ids from concord_list_vendors' },
        },
        required: ['intent', 'vendors'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          intent: { type: 'string' },
          guarantee: { type: 'string', enum: ['atomic', 'compensated', 'bounded', 'refused'] },
          committable: { type: 'boolean' },
          order: { type: 'array', items: { type: 'string' } },
          refusal: { type: ['string', 'null'] },
        },
        required: ['proposalId', 'guarantee', 'committable'],
      },
      annotations: { readOnlyHint: true },
      execute: guard(({ intent, vendors }) => surface.propose({ intent, vendors })),
      refuse: asRefusal,
    },

    concord_get_surface: {
      title: 'What can be called right now, and why anything missing is missing',
      description: 'Returns the tools registered on this document at this moment, and for each '
        + 'one that is absent, the reason. Tools here appear and disappear as the commitment '
        + 'progresses: that is the permission system, not a fault. Call this whenever a tool you '
        + 'expected is not there.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          registered: { type: 'array', items: { type: 'string' } },
          absent: { type: 'array', items: { type: 'object', properties: {
            tool: { type: 'string' }, missing: { type: 'string' } } } },
          state: { type: 'object' },
          note: { type: 'string' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: guard(() => ({
        registered: reconciler.names,
        absent: absences(surface.state()),
        state: surface.state(),
        note: 'There is no tool that accepts a guarantee, and no tool that moves money. '
          + 'A person accepts by clicking on the page, and concord_commit is registered only '
          + 'while that acceptance stands.',
      })),
      refuse: asRefusal,
    },

    concord_explain_guarantee: {
      title: 'Read out what this commitment does and does not promise',
      description: 'Returns the guarantee in full: what is settled first, which single step '
        + 'cannot be undone, which effects become briefly real before being reversed, and whether '
        + 'any vendor could not be asked afterwards what happened. Relay this to the person. It '
        + 'also returns explanationDigest, the identity of these exact promises — what the '
        + 'person accepts is that, not the proposal id.',
      inputSchema: {
        type: 'object',
        properties: { proposalId: { type: 'string', description: 'From concord_propose_commitment' } },
        required: ['proposalId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          guarantee: { type: 'string', enum: ['atomic', 'compensated', 'bounded', 'refused'] },
          summary: { type: 'string' },
          caveats: { type: 'array', items: { type: 'string' } },
          order: { type: 'array', items: { type: 'string' } },
          pointOfNoReturn: { type: ['string', 'null'] },
          recoverable: { type: 'boolean' },
          committable: { type: 'boolean' },
          explanationDigest: { type: 'string',
            description: 'SHA-256 of these promises. What a person accepts is this, not the id.' },
          acceptedByPerson: { type: 'boolean' },
          attention: {
            type: 'object',
            description: 'Whether the browser was able to bring a person to the page. '
              + 'If asked is false, relay the guarantee yourself and wait — nobody has been '
              + 'summoned. This never grants anything either way.',
            properties: { asked: { type: 'boolean' }, why: { type: 'string' } },
            required: ['asked', 'why'],
          },
        },
        required: ['proposalId', 'guarantee', 'summary', 'explanationDigest'],
      },
      annotations: { readOnlyHint: true },
      execute: guard(async ({ proposalId }) => {
        const explained = await surface.explain({ proposalId });
        // The second door. Explaining is the moment a person is needed, so this
        // is where the host is asked to fetch them -- and the answer is
        // reported rather than assumed, because an agent that thinks somebody
        // has been summoned when nobody has will wait forever. Nothing about
        // what is registered depends on this call; see app/attention.mjs.
        const attention = explained.committable
          ? await askForAttention(mc, { reason: 'a person needs to accept this guarantee' })
          : { asked: false, why: 'there is no honest guarantee here to accept' };
        return { ...explained, attention };
      }),
      refuse: asRefusal,
    },

    concord_commit: {
      title: 'Carry out the commitment the person accepted',
      description: 'Executes the accepted proposal across every vendor at once, or leaves nothing '
        + 'standing. This tool exists only while a person has accepted this exact guarantee; if '
        + 'you cannot see it, nobody has. Returns what actually stands, which may be less than was '
        + 'asked for — report it as returned rather than as success.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'From concord_propose_commitment' },
          digest: { type: 'string',
            description: 'explanationDigest from concord_explain_guarantee. Optional; if given it '
              + 'must be the guarantee the person accepted.' },
        },
        required: ['proposalId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          outcome: { type: 'string', enum: ['committed', 'unwound', 'in-doubt', 'refused'] },
          stands: { type: 'array', items: { type: 'string' },
            description: 'What is still true afterwards. May be less than was asked for.' },
          cause: { type: ['string', 'null'] },
          stranded: { type: ['array', 'null'], items: { type: 'string' } },
          broken: { type: 'array', items: { type: 'object' },
            description: 'Vendors that declared a reversal and then would not perform it.' },
          unrecorded: { type: ['string', 'null'] },
        },
        required: ['outcome', 'stands'],
      },
      annotations: { readOnlyHint: false },
      // The host's signal is handed to the saga, so an agent runtime that
      // cancels a call cancels the work -- but only where stopping is safe.
      // An unwind already in progress finishes.
      execute: guard(({ proposalId, digest }, callCtx) =>
        surface.commit({ proposalId, digest }, { signal: callCtx?.signal }),
        { budgeted: false }),
      refuse: asRefusal,
    },
  };

  await reconciler.sync(desiredNames(surface.state()), definitions);
  surface.registered = () => reconciler.names;
  surface.reconciler = reconciler;
  return surface;
}

export { Refused, desiredNames, FORBIDDEN };
