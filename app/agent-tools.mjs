// Concord's agent-facing surface, published over WebMCP.
//
// This is the part that matters for an agentic web. The tools below are the
// only things an agent can reach, and between them they cannot overpromise:
// there is nothing here that spends anything directly, commit refuses a plan
// the ladder would not guarantee, and it refuses any proposal whose guarantee
// has not been read out first.
//
// They are registered with document.modelContext.registerTool, so the agent
// driving them can be the one in this page, or ChatGPT's, or Gemini's. Concord
// does not care which, and does not need to: the constraint is in the shape of
// the surface rather than in anyone's instructions.

import { AgentSurface, Refused } from '/concord/agent-surface.mjs';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const asRefusal = (err) => asText({
  refused: true,
  reason: err.message,
  ...(err.needs && { youMustFirst: err.needs }),
  ...(err.refusal && { because: err.refusal }),
});

export async function publishAgentTools({ ctx, participants, inputs, journal, bind, onEvent }) {
  const surface = new AgentSurface({ participants, inputs, journal, bind, onEvent });

  // The canonical registration form, against the real API where it exists.
  const mc = document.modelContext ?? navigator.modelContext ?? ctx;

  await mc.registerTool({
    name: 'concord_list_vendors',
    title: 'List the vendors present',
    description: 'Returns the independent vendors in this tab and what each one can commit to: '
      + 'whether it can hold and release, commit and compensate, or only act irreversibly. '
      + 'Contacts nobody and changes nothing.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => asText(surface.listVendors()),
  });

  await mc.registerTool({
    name: 'concord_propose_commitment',
    title: 'Propose a commitment across several vendors',
    description: 'Works out what could honestly be promised if these vendors were committed to '
      + 'together, without contacting any of them. Returns a proposal and a guarantee, which may '
      + 'be that no honest promise is available. Call this before doing anything else.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: "What the person asked for, in their own words" },
        vendors: { type: 'array', items: { type: 'string' },
          description: 'Vendor ids from concord_list_vendors' },
      },
      required: ['intent', 'vendors'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ intent, vendors }) => {
      try { return asText(surface.propose({ intent, vendors })); }
      catch (err) { return asRefusal(err); }
    },
  });

  await mc.registerTool({
    name: 'concord_explain_guarantee',
    title: 'Read out what this commitment does and does not promise',
    description: 'Returns the guarantee in full: what is settled first, which single step cannot '
      + 'be undone, which effects become briefly real before being reversed, and whether any '
      + 'vendor could not be asked afterwards what happened. You must relay this to the person '
      + 'before committing — concord_commit will refuse a proposal that has not been explained.',
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string', description: 'From concord_propose_commitment' } },
      required: ['proposalId'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ proposalId }) => {
      try { return asText(surface.explain({ proposalId })); }
      catch (err) { return asRefusal(err); }
    },
  });

  await mc.registerTool({
    name: 'concord_commit',
    title: 'Carry out a proposed commitment',
    description: 'Executes a proposal across every vendor at once, or leaves nothing standing. '
      + 'Refuses any proposal the ladder would not guarantee, and any whose guarantee has not '
      + 'been explained first. Returns what actually stands, which may be less than was asked '
      + 'for — report it as returned rather than as success.',
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string', description: 'From concord_propose_commitment' } },
      required: ['proposalId'],
    },
    // The one effectful tool on the surface, and it can only run what was
    // already approved and already explained.
    annotations: { readOnlyHint: false },
    execute: async ({ proposalId }) => {
      try { return asText(await surface.commit({ proposalId })); }
      catch (err) { return asRefusal(err); }
    },
  });

  return surface;
}

export { Refused };
