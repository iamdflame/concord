// Binds the protocol to WebMCP.
//
// Discovery is the interesting part. Concord does not know what these vendors
// are, has no agreement with them, and cannot see their code. It asks each one
// the same question -- what can you commit to? -- and everything after that is
// built from the answers.

export async function discover(ctx, origins) {
  const tools = await ctx.getTools({ fromOrigins: origins });
  const participants = [];

  for (const origin of origins) {
    const mine = tools.filter((t) => t.origin === origin);
    const declaration = mine.find((t) => t.name === 'concord.protocol');
    // A vendor that will not say what it can commit to is not a participant.
    // Guessing on its behalf is how you end up promising atomicity you cannot
    // deliver, which is the one failure this whole design exists to prevent.
    if (!declaration) continue;

    const protocol = JSON.parse(await ctx.executeTool(declaration, {}));
    participants.push({
      id: protocol.id,
      title: protocol.title,
      origin,
      protocol,
      tools: Object.fromEntries(mine.map((t) => [t.name, t])),
    });
  }
  return participants;
}

/** The call surface the saga executor drives, bound to a set of participants. */
export function bind(ctx, participants) {
  const byId = new Map(participants.map((p) => [p.id, p]));

  return async function call(id, toolName, args, { idempotencyKey }) {
    const participant = byId.get(id);
    const tool = participant?.tools[toolName];
    if (!tool) throw new Error(`${id} does not expose ${toolName}`);

    // The key travels in the arguments because WebMCP has no call metadata.
    // It is a declared parameter on every commitment step, not a smuggled one.
    const raw = await ctx.executeTool(tool, { ...args, idempotencyKey });
    const value = JSON.parse(raw);
    if (value?.error) throw new Error(value.error);
    return value;
  };
}

/** Attach the inputs a plan should carry to each participant. */
export function withInputs(participants, inputs) {
  return participants.map((p) => ({ ...p, input: inputs[p.id] ?? {} }));
}
