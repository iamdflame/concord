// Binds the protocol to WebMCP.
//
// Discovery is the interesting part. Concord does not know what these vendors
// are, has no agreement with them, and cannot see their code. It asks each one
// the same question -- what can you commit to? -- and everything after that is
// built from the answers.

/**
 * Chrome's imperative API takes tool arguments as a JSON **string**:
 *
 *   await document.modelContext.executeTool(tool, '{"text": "Buy milk"}')
 *
 * The shim accepted objects, so everything was green locally and every vendor
 * call would have failed on the native API -- the one path judges actually run.
 * Arguments go out as a string; the shim was taught to accept both.
 */
async function invokeTool(ctx, tool, args, signal) {
  const raw = await ctx.executeTool(tool, JSON.stringify(args), signal ? { signal } : {});
  if (typeof raw !== 'string') return raw;          // an implementation that returns values
  try { return JSON.parse(raw); } catch { return raw; }   // …or a bare string, per the docs
}

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

    const protocol = await invokeTool(ctx, declaration, {});
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

/**
 * The call surface the saga executor drives.
 *
 * Attestations are lifted out here rather than handed on, so the executor keeps
 * working in plain results and the receipt is assembled from signed statements
 * the coordinator only ever forwards.
 */
export function bind(ctx, participants) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const attestations = [];

  const call = async function call(id, toolName, args, { idempotencyKey, sagaId, parties, signal }) {
    const participant = byId.get(id);
    const tool = participant?.tools[toolName];
    if (!tool) throw new Error(`${id} does not expose ${toolName}`);

    // Both travel in the arguments because WebMCP has no call metadata. They
    // are declared parameters on every commitment step, not smuggled ones.
    const value = await invokeTool(ctx, tool, { ...args, idempotencyKey, sagaId, parties }, signal);
    if (value?.error) throw new Error(value.error);

    const { attestation, ...result } = value;
    if (attestation) attestations.push(attestation);
    return result;
  };

  call.attestations = attestations;
  // Where each vendor publishes its keys, taken from its own declaration. The
  // coordinator forwards the address; it never forwards a key.
  call.vendors = Object.fromEntries(participants
    .filter((p) => p.protocol?.keyId)
    .map((p) => [p.id, { origin: p.protocol.origin ?? p.origin, keyId: p.protocol.keyId }]));
  return call;
}

/** Attach the inputs a plan should carry to each participant. */
export function withInputs(participants, inputs) {
  return participants.map((p) => ({ ...p, input: inputs[p.id] ?? {} }));
}
