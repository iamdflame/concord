// The gate. Every tool call the kernel makes passes through here.
//
// Order is not arbitrary. The policy check runs before anything is validated or
// executed, because a denied call must have no side effect at all -- including
// the side effect of a schema error telling an attacker what shape to send.

import { Label, Provenance, UNTRUSTED, originTag } from './labels.mjs';
import { Transcript } from './transcript.mjs';

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
  transcript = new Transcript();

  constructor({ modelContext, policy, confirm }) {
    this.#ctx = modelContext;
    this.#policy = policy;
    this.#provenance = new Provenance();
    // No confirmation handler means no confirmable call succeeds. Failing
    // closed is the only safe default for a prompt that was never shown.
    this.#confirm = confirm ?? (async () => false);
  }

  get provenance() { return this.#provenance; }

  // contextAfter is recorded so replay can be checked against what actually
  // held, rather than trusted to agree with itself.
  #record(entry) {
    return this.transcript.append({
      t: Math.round(performance.now()),
      ...entry,
      contextAfter: this.#provenance.context.tags,
    });
  }

  async dispatch(tool, args = {}, options = {}) {
    if (!tool?.name || !tool?.origin) {
      throw new TypeError('dispatch needs a registered tool descriptor; got ' + JSON.stringify(tool));
    }
    const toolId = `${tool.origin}/${tool.name}`;
    const effect = tool.annotations?.readOnlyHint ? 'read' : 'write';
    const egress = this.#policy.egressOf(toolId);
    const { label, evidence } = this.#provenance.labelFor(args);

    const call = { toolId, origin: tool.origin, effect, egress, label };
    const ruling = this.#policy.check(call);

    if (!ruling.allow) {
      const entry = await this.#record({
        kind: 'deny', toolId, args, label: String(label), labelTags: label.tags,
        effect, egress, reason: ruling.reason, rule: ruling.rule?.source ?? null, evidence,
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
        const entry = await this.#record({
          kind: 'deny', toolId, args, label: String(label), labelTags: label.tags,
          effect, egress, reason: `a human declined this ${egress} call`,
          rule: ruling.rule?.source ?? null, evidence,
        });
        const err = new Error(entry.reason);
        err.name = 'ConfirmationDeclined';
        err.entry = entry;
        throw err;
      }
    }

    validate(tool.inputSchema, args, toolId);

    const started = performance.now();
    // Chrome's API takes arguments as a JSON string and returns one. Passing an
    // object is rejected with "Failed to parse input arguments" -- which the
    // polyfill accepted, so this only ever failed on the real thing.
    const raw = await this.#ctx.executeTool(tool, JSON.stringify(args), { signal: options.signal });
    const ms = Math.max(1, Math.round(performance.now() - started));
    let value = raw;
    if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = raw; } }

    // Propagate. Everything a tool returns carries its origin; a tool that
    // declared itself a source of untrusted content also carries UNTRUSTED.
    let outLabel = label.join(Label.of(originTag(tool.origin)));
    if (tool.annotations?.untrustedContentHint) outLabel = outLabel.join(Label.of(UNTRUSTED));
    this.#provenance.observe(value, outLabel, toolId);

    await this.#record({
      kind: 'call', toolId, args, label: String(outLabel), labelTags: outLabel.tags,
      effect, egress, ms, confirmed: Boolean(ruling.confirm), result: value,
    });
    return value;
  }
}
