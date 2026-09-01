// The gate. Every tool call the kernel makes passes through here.
//
// Order is not arbitrary. The policy check runs before anything is validated or
// executed, because a denied call must have no side effect at all -- including
// the side effect of a schema error telling an attacker what shape to send.

import { Label, Provenance, UNTRUSTED, originTag } from './labels.mjs';

/** Minimal JSON Schema check. The platform has no input validation. */
function validate(schema, args, toolId) {
  if (!schema || schema.type !== 'object') return;
  for (const key of schema.required ?? []) {
    if (!(key in args)) throw new TypeError(`${toolId}: missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const want = spec.type === 'integer' ? 'number' : spec.type;
    if (want && actual !== want) {
      throw new TypeError(`${toolId}: "${key}" should be ${spec.type}, got ${actual}`);
    }
  }
}

export class Kernel {
  #ctx; #policy; #provenance; #confirm;
  transcript = [];

  constructor({ modelContext, policy, confirm }) {
    this.#ctx = modelContext;
    this.#policy = policy;
    this.#provenance = new Provenance();
    // No confirmation handler means no confirmable call succeeds. Failing
    // closed is the only safe default for a prompt that was never shown.
    this.#confirm = confirm ?? (async () => false);
  }

  get provenance() { return this.#provenance; }

  #record(entry) {
    this.transcript.push({ seq: this.transcript.length, t: Math.round(performance.now()), ...entry });
    return this.transcript.at(-1);
  }

  async dispatch(tool, args = {}, options = {}) {
    const toolId = `${tool.origin}/${tool.name}`;
    const effect = tool.annotations?.readOnlyHint ? 'read' : 'write';
    const egress = this.#policy.egressOf(toolId);
    const { label, evidence } = this.#provenance.labelFor(args);

    const call = { toolId, effect, egress, label };
    const ruling = this.#policy.check(call);

    if (!ruling.allow) {
      const entry = this.#record({
        kind: 'deny', toolId, args, label: String(label), effect, egress,
        reason: ruling.reason, rule: ruling.rule?.source ?? null, evidence,
      });
      const err = new Error(ruling.reason);
      err.name = 'PolicyDenial';
      err.entry = entry;
      err.evidence = evidence;
      throw err;
    }

    if (ruling.confirm) {
      const approved = await this.#confirm({ toolId, args, label: String(label), effect, egress, reason: ruling.reason });
      if (!approved) {
        const entry = this.#record({
          kind: 'deny', toolId, args, label: String(label), effect, egress,
          reason: `a human declined this ${egress} call`, rule: ruling.rule?.source ?? null, evidence,
        });
        const err = new Error(entry.reason);
        err.name = 'ConfirmationDeclined';
        err.entry = entry;
        throw err;
      }
    }

    validate(tool.inputSchema, args, toolId);

    const raw = await this.#ctx.executeTool(tool, args, { signal: options.signal });
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }

    // Propagate. Everything a tool returns carries its origin; a tool that
    // declared itself a source of untrusted content also carries UNTRUSTED.
    let outLabel = label.join(Label.of(originTag(tool.origin)));
    if (tool.annotations?.untrustedContentHint) outLabel = outLabel.join(Label.of(UNTRUSTED));
    this.#provenance.observe(value, outLabel, toolId);

    this.#record({
      kind: 'call', toolId, args, label: String(outLabel), effect, egress,
      confirmed: Boolean(ruling.confirm), result: value,
    });
    return value;
  }
}
