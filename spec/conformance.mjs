// The Concord conformance suite.
//
// A specification nobody can check is a description. This runs against a live
// participant over WebMCP and reports which level it meets, so a third party can
// point it at their own implementation and get an answer rather than an opinion.
//
//   L1  declares      concord.protocol, exposed, honest about its rung
//   L2  recoverable   plus concord.status and idempotent steps
//   L3  attesting     plus signed statements and a published key document
//
// Every check names the section of SPEC.md it enforces, because a conformance
// failure should send you to the paragraph rather than to the source.

import { classify } from '../concord/ladder.mjs';
import { canonical } from '../kit/canonical.mjs';
import { fetchKeys, verifyStatement, keyValidAt } from '../concord/receipt.mjs';
import { schemaOf } from '../concord/client.mjs';

const RUNGS = { 3: 'reservable', 2: 'compensable', 1: 'irreversible' };

export async function conform({ ctx, origin, exec }) {
  const checks = [];
  const note = (level, id, section, ok, why = '') =>
    checks.push({ level, id, section, ok, why });

  const call = exec ?? (async (tool, args) => {
    const raw = await ctx.executeTool(tool, JSON.stringify(args ?? {}));
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value?.structuredContent ?? value;
  });

  const tools = await ctx.getTools({ fromOrigins: [origin] });
  const mine = tools.filter((t) => t.origin === origin);
  const byName = Object.fromEntries(mine.map((t) => [t.name, t]));

  // ── L1 ────────────────────────────────────────────────────────────────────
  const declaration = byName['concord.protocol'];
  note(1, 'declares', '§3', Boolean(declaration),
    declaration ? '' : 'no concord.protocol tool is exposed to this coordinator');
  if (!declaration) return { origin, level: 0, checks };

  note(1, 'declaration-is-read-only', '§3', declaration.annotations?.readOnlyHint === true,
    'concord.protocol MUST be readOnlyHint: true and perform nothing');

  const protocol = await call(declaration, {});
  note(1, 'declares-own-origin', '§3', protocol?.origin === origin,
    `declares origin "${protocol?.origin}", served from "${origin}"`);

  let rung = null;
  try {
    const c = classify({ id: protocol?.id, protocol });
    rung = c.rung;
    note(1, 'classifiable', '§4', c.rung !== null, c.unusable ?? '');
  } catch (err) {
    note(1, 'classifiable', '§4', false, err.message);
  }

  const steps = protocol?.steps ?? {};
  const declared = Object.entries(steps).filter(([k]) => k !== 'status');
  note(1, 'declared-tools-exist', '§3',
    declared.every(([, v]) => byName[v.tool]),
    declared.filter(([, v]) => !byName[v.tool]).map(([k, v]) => `${k} names ${v.tool}, which is not exposed`).join('; '));

  if (rung === 3) {
    note(1, 'reserve-declares-ttl', '§6', Number.isFinite(steps.reserve?.ttlSeconds),
      'a reservable participant SHOULD declare how long its hold lives');
  }

  // ── L2 ────────────────────────────────────────────────────────────────────
  const status = byName['concord.status'];
  note(2, 'has-status', '§8', Boolean(status),
    'without it, an interrupted commitment is a permanent unknown for this participant');

  if (status) {
    note(2, 'status-is-read-only', '§8', status.annotations?.readOnlyHint === true,
      'concord.status MUST perform nothing');
    const params = Object.keys(schemaOf(status)?.properties ?? {});
    note(2, 'status-parameter-name', '§8', params.includes('lookupKey') && !params.includes('idempotencyKey'),
      `takes [${params.join(', ')}] — reusing "idempotencyKey" means the key being asked about is `
      + 'overwritten by the key of the asking');

    const unknown = await call(status, { lookupKey: `conformance-${crypto.randomUUID()}` });
    note(2, 'status-answers-unknown-keys', '§8', unknown?.happened === false,
      'a key it has never honoured MUST report happened: false');
  }

  // Idempotency, exercised rather than assumed.
  const first = declared.find(([k]) => k === 'reserve' || k === 'execute');
  if (first) {
    const tool = byName[first[1].tool];
    const key = `conformance.${crypto.randomUUID()}.${first[0]}`;
    const args = { idempotencyKey: key, sagaId: 'conformance', parties: [protocol.id],
                   plan: { parties: [protocol.id], guarantee: 'atomic', steps: [`${protocol.id}.${first[0]}`] },
                   ...sampleArgs(tool) };
    const a = await call(tool, args);
    const b = await call(tool, args);
    note(2, 'idempotent', '§7', canonical(strip(a)) === canonical(strip(b)),
      'the same idempotency key MUST return the first answer rather than doing the work twice');

    if (status) {
      const seen = await call(status, { lookupKey: key });
      note(2, 'status-sees-what-happened', '§8', seen?.happened === true,
        'after a step, its key MUST report happened: true');
    }

    // ── L3 ──────────────────────────────────────────────────────────────────
    const attestation = a?.attestation;
    note(3, 'attests', '§9', Boolean(attestation?.statement && attestation?.signature),
      'steps MUST return a signed statement');

    if (attestation) {
      const st = attestation.statement;
      note(3, 'statement-carries-origin', '§9', st.origin === origin,
        `signs origin "${st.origin}" — a verifier resolves the key from this and nowhere else`);
      note(3, 'statement-carries-plan', '§9', Boolean(st.plan?.steps),
        'a statement MUST attest to the shape of the whole commitment');
      note(3, 'statement-is-timestamped', '§9', Number.isFinite(Date.parse(st.at ?? '')),
        'without a timestamp the key validity window cannot be applied');

      let published = null;
      try { published = await fetchKeys(origin); } catch (err) {
        note(3, 'publishes-keys', '§10', false, err.message);
      }
      if (published) {
        note(3, 'publishes-keys', '§10', published.vendor === protocol.id,
          `the key document names "${published.vendor}", the declaration says "${protocol.id}"`);
        const record = published.keys[attestation.keyId];
        note(3, 'key-is-published', '§10', Boolean(record),
          `signed with ${attestation.keyId}, which is not in the key document`);
        if (record) {
          note(3, 'signature-verifies', '§9',
            await verifyStatement({ statement: st, signature: attestation.signature }, record),
            'the published key MUST verify the signature the participant produced');
          note(3, 'key-in-force', '§10', keyValidAt({ ...record, vendor: protocol.id }, st.at).ok,
            keyValidAt({ ...record, vendor: protocol.id }, st.at).why ?? '');
        }
      }
    }
  }

  const met = [1, 2, 3].filter((l) => checks.filter((c) => c.level === l).every((c) => c.ok));
  const level = met.includes(1) ? (met.includes(2) ? (met.includes(3) ? 3 : 2) : 1) : 0;
  return { origin, id: protocol?.id, rung: RUNGS[rung] ?? 'unusable', level, checks };
}

/** Drop the parts that legitimately differ between two identical calls. */
const strip = (v) => {
  const { attestation, replayed, ...rest } = v ?? {};
  return rest;
};

/** Plausible values for a participant's own declared parameters. */
function sampleArgs(tool) {
  const out = {};
  for (const [k, spec] of Object.entries(schemaOf(tool)?.properties ?? {})) {
    if (['idempotencyKey', 'sagaId', 'parties', 'plan'].includes(k)) continue;
    out[k] = spec.enum?.[0] ?? (spec.type === 'number' ? 1 : `conformance-${k}`);
  }
  return out;
}
