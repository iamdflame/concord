// The capability policy engine.
//
// Deny by default. A call is permitted only if some allow rule matches it and
// no deny rule does. Rules are declarative because a refusal has to be readable
// out loud at the moment it happens -- "denied by rule 4" tells a user nothing,
// and a policy nobody can read is a policy nobody can audit.
//
// The kernel takes effect and trust from the platform where the platform has
// them: readOnlyHint gives us effect, untrustedContentHint gives us the taint
// source. Only egress class is declared here, because WebMCP has no notion of
// what a tool can reach.

const CLASSES = ['none', 'network', 'funds', 'identity'];

function glob(pattern) {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${rx}$`);
}

class ParseError extends Error {
  constructor(msg, lineNo, line) {
    super(`policy line ${lineNo}: ${msg}\n    ${line.trim()}`);
    this.name = 'ParseError';
  }
}

function parsePredicate(tokens, lineNo, line) {
  const [subject, op, ...rest] = tokens;
  const value = rest.join(' ');

  if (subject === 'effect' && op === '==') {
    if (!['read', 'write'].includes(value)) throw new ParseError(`unknown effect "${value}"`, lineNo, line);
    return { kind: 'effect', op, value, describe: `effect is ${value}` };
  }
  if (subject === 'egress' && (op === '==' || op === '!=')) {
    if (!CLASSES.includes(value)) throw new ParseError(`unknown egress class "${value}"`, lineNo, line);
    return { kind: 'egress', op, value, describe: `egress ${op === '==' ? 'is' : 'is not'} ${value}` };
  }
  if (subject === 'origin' && (op === '==' || op === '!=')) {
    return { kind: 'origin', op, value, describe: `origin ${op === '==' ? 'is' : 'is not'} ${value}` };
  }
  if (subject === 'labels' && (op === 'includes' || op === 'excludes')) {
    return { kind: 'labels', op, value, describe: `labels ${op} ${value}` };
  }
  throw new ParseError(`cannot parse condition "${tokens.join(' ')}"`, lineNo, line);
}

export function parsePolicy(source) {
  const rules = [];
  const capabilities = [];

  const lines = source.split('\n');
  // A rule may continue across lines while indented, so `where` clauses can be
  // read down the page instead of running off the side of it.
  const logical = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '');
    if (!line.trim()) return;
    if (/^\s/.test(raw) && logical.length) logical[logical.length - 1].text += ' ' + line.trim();
    else logical.push({ text: line.trim(), lineNo: i + 1, raw });
  });

  for (const { text, lineNo, raw } of logical) {
    let rest = text;
    let reason = null;
    const reasonMatch = rest.match(/\breason\s+"([^"]*)"\s*$/);
    if (reasonMatch) { reason = reasonMatch[1]; rest = rest.slice(0, reasonMatch.index).trim(); }

    let confirm = null;
    const confirmMatch = rest.match(/\band\s+confirm\s*==\s*(\w+)/) ?? rest.match(/\bconfirm\s*==\s*(\w+)/);
    if (confirmMatch) { confirm = confirmMatch[1]; rest = rest.replace(confirmMatch[0], '').trim(); }

    const [verb, target, ...tail] = rest.split(/\s+/);

    if (verb === 'capability') {
      const [kw, cls] = tail;
      if (kw !== 'egress') throw new ParseError('expected: capability <tool> egress <class>', lineNo, raw);
      if (!CLASSES.includes(cls)) throw new ParseError(`unknown egress class "${cls}"`, lineNo, raw);
      capabilities.push({ match: glob(target.replace(/^tool:/, '')), egress: cls, source: target });
      continue;
    }

    if (verb !== 'allow' && verb !== 'deny') {
      throw new ParseError(`expected allow, deny or capability, found "${verb}"`, lineNo, raw);
    }

    const conditions = [];
    if (tail.length) {
      if (tail[0] !== 'where') throw new ParseError(`expected "where", found "${tail[0]}"`, lineNo, raw);
      for (const clause of tail.slice(1).join(' ').split(/\s+and\s+/)) {
        if (clause.trim()) conditions.push(parsePredicate(clause.trim().split(/\s+/), lineNo, raw));
      }
    }

    rules.push({
      verb, confirm, reason, conditions, lineNo,
      match: glob(target.replace(/^tool:/, '')),
      source: text,
    });
  }

  return new Policy(rules, capabilities);
}

function holds(cond, call) {
  switch (cond.kind) {
    case 'effect': return call.effect === cond.value;
    case 'egress': return cond.op === '==' ? call.egress === cond.value : call.egress !== cond.value;
    case 'origin': return cond.op === '==' ? call.origin === cond.value : call.origin !== cond.value;
    case 'labels': {
      const present = call.label.has(cond.value);
      return cond.op === 'includes' ? present : !present;
    }
    default: return false;
  }
}

export class Policy {
  constructor(rules, capabilities) { this.rules = rules; this.capabilities = capabilities; }

  egressOf(toolId) {
    // Most specific declaration wins, so a broad default can be narrowed.
    let best = { egress: 'none', width: Infinity };
    for (const cap of this.capabilities) {
      if (cap.match.test(toolId) && cap.source.length < best.width) {
        best = { egress: cap.egress, width: cap.source.length };
      }
    }
    return best.egress;
  }

  /** @returns {{allow:boolean, confirm:string|null, reason:string, rule:object|null}} */
  check(call) {
    const applicable = (r) => r.match.test(call.toolId) && r.conditions.every((c) => holds(c, call));

    for (const rule of this.rules) {
      if (rule.verb === 'deny' && applicable(rule)) {
        return {
          allow: false,
          confirm: null,
          reason: rule.reason ?? `denied by policy: ${rule.source}`,
          rule,
        };
      }
    }

    for (const rule of this.rules) {
      if (rule.verb === 'allow' && applicable(rule)) {
        return { allow: true, confirm: rule.confirm, reason: rule.reason ?? 'permitted', rule };
      }
    }

    return {
      allow: false,
      confirm: null,
      reason: `no rule permits ${call.effect} on ${call.toolId} (egress ${call.egress})`,
      rule: null,
    };
  }
}
