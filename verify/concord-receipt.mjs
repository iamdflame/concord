// <concord-receipt> — a receipt, verified in the visitor's own browser.
//
// The point of a Concord receipt is that checking it requires trusting nobody:
// every statement is signed by the party that made it, and every key is fetched
// from that party's own origin over TLS. A vendor showing a customer "your
// booking was confirmed" is asking to be believed. This element does not ask.
// It verifies in front of them, on their machine, and says what it found --
// including when the answer is no.
//
//   <script type="module" src="https://unpkg.com/concord-verify/concord-receipt.mjs"></script>
//
//   <concord-receipt src="/receipts/RH-9.json"></concord-receipt>
//   <concord-receipt><script type="application/json">{ … }</script></concord-receipt>
//
// Attributes
//   src        where to fetch the receipt from
//   compact    one line instead of the full ledger
//
// It has no dependencies, no styling opinions it will not let you override, and
// it never contacts the coordinator that produced the receipt -- which is the
// whole claim, and would be worth nothing if this element quietly phoned home.
// The only network calls it makes are: the receipt itself, and one key document
// per participating origin, fetched from the origin named inside the statement
// that origin signed.

import { verifyReceipt, originResolver, deriveOutcome } from './lib/receipt.mjs';

const CSS = `
  :host {
    display: block;
    --concord-ink: #101419;
    --concord-dim: #5c6570;
    --concord-rule: #e2e4e7;
    --concord-good: #1f7a4d;
    --concord-bad: #c23c1c;
    --concord-paper: #fff;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--concord-ink);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --concord-ink: #e9e8e2; --concord-dim: #99a0a8; --concord-rule: #2b3138;
      --concord-good: #45b477; --concord-bad: #e85b36; --concord-paper: #14181d;
    }
  }
  .card {
    border: 1px solid var(--concord-rule); border-radius: 10px;
    background: var(--concord-paper); padding: 16px 18px; max-width: 46rem;
  }
  .top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .verdict { font-weight: 650; }
  .ok { color: var(--concord-good); }
  .no { color: var(--concord-bad); }
  .quiet { color: var(--concord-dim); font-size: 13px; }
  .who { margin: 12px 0 0; border-collapse: collapse; width: 100%; }
  .who th, .who td {
    text-align: left; padding: 6px 10px 6px 0; border-top: 1px solid var(--concord-rule);
    font-weight: 400; vertical-align: top;
  }
  .who th { color: var(--concord-dim); font-size: 12px; letter-spacing: .02em; }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  ul { margin: 10px 0 0; padding-left: 18px; color: var(--concord-bad); }
  .spin { color: var(--concord-dim); }
  .dispute {
    margin: 12px 0 0; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--concord-bad); color: var(--concord-bad); font-size: 13px;
  }
  .dispute b { font-weight: 650; }
`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class ConcordReceipt extends HTMLElement {
  static observedAttributes = ['src', 'compact'];
  #root = this.attachShadow({ mode: 'open' });

  /**
   * How keys are resolved. Defaults to fetching each participant's key document
   * from the origin named inside the statement that origin signed, which is the
   * only setting that makes this element mean anything on a real page.
   *
   * Overridable for two honest reasons: a site that pins its counterparties'
   * keys rather than fetching them, and a test with ephemeral keys no origin
   * publishes. It is a property rather than an attribute deliberately -- markup
   * cannot set it, so a receipt cannot name its own verifier.
   *
   * When it is set, the element says so on its face. A page that swaps the
   * resolver and still prints "every key came from the origin that signed it"
   * is telling the reader the one thing this element exists to make checkable,
   * and telling it falsely.
   */
  resolve = null;

  connectedCallback() { this.#run(); }
  attributeChangedCallback() { if (this.isConnected) this.#run(); }

  #paint(html) { this.#root.innerHTML = `<style>${CSS}</style><div class="card">${html}</div>`; }

  async #load() {
    const src = this.getAttribute('src');
    if (src) {
      const res = await fetch(src, { credentials: 'omit' });
      if (!res.ok) throw new Error(`${src} returned ${res.status}`);
      return res.json();
    }
    const inline = this.querySelector('script[type="application/json"]');
    if (!inline) throw new Error('needs a src attribute or an inline <script type="application/json">');
    return JSON.parse(inline.textContent);
  }

  async #run() {
    this.#paint('<span class="spin">checking this receipt against each party’s own origin…</span>');
    let receipt, out;
    try {
      receipt = await this.#load();
      out = await verifyReceipt(receipt, this.resolve ?? originResolver());
    } catch (err) {
      this.#paint(`<div class="top"><span class="verdict no">Could not be checked</span></div>`
        + `<p class="quiet">${esc(err.message)}</p>`);
      this.dispatchEvent(new CustomEvent('concord-error', { detail: { error: err }, bubbles: true }));
      return;
    }

    // The outcome is derived from the entries, never read off the receipt.
    // receipt.outcome is the one field no vendor signs -- the coordinator
    // writes it -- so it is displayed only to be contradicted. An earlier
    // version of this element printed it as the answer, which is precisely the
    // thing the whole design exists to stop.
    const plan = receipt.entries?.[0]?.statement?.plan;
    const derived = plan ? deriveOutcome(plan, receipt.entries) : null;
    const claimed = receipt.outcome ?? null;
    const disputed = derived && claimed && derived !== claimed;

    const verdict = out.ok
      ? `<span class="verdict ok">Verified</span>`
      : `<span class="verdict no">Does not verify</span>`;
    const n = receipt.entries?.length ?? 0;
    const line = out.ok
      ? `${esc(derived ?? 'unknown')} · ${n} signed statement${n === 1 ? '' : 's'} · `
        + 'no coordinator was asked'
      : `${out.complaints.length} problem${out.complaints.length === 1 ? '' : 's'}`;

    const dispute = disputed
      ? `<p class="dispute">This receipt says <b>${esc(claimed)}</b>. The signed statements
           in it say <b>${esc(derived)}</b>. Nobody signs that field, so the statements win.</p>`
      : '';

    if (this.hasAttribute('compact')) {
      this.#paint(`<div class="top">${verdict}<span class="quiet">${line}</span></div>${dispute}`);
    } else {
      const rows = (receipt.entries ?? []).map((e) => `
        <tr><td>${esc(e.statement.vendor)}</td>
            <td>${esc(e.statement.step)}</td>
            <td><code>${esc(e.statement.origin)}</code></td></tr>`).join('');
      this.#paint(`
        <div class="top">${verdict}<span class="quiet">${line}</span></div>
        ${dispute}
        <table class="who">
          <tr><th>who</th><th>did what</th><th>key resolved from</th></tr>
          ${rows}
        </table>
        ${out.ok ? '' : `<ul>${out.complaints.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`}
        <p class="quiet">${this.resolve
          ? 'Checked in this browser, against a key resolver this page supplied rather than '
            + 'the signing origins. That is a demonstration, not a verification.'
          : 'Checked in this browser. Every key came from the origin named inside the '
            + 'statement that origin signed.'}</p>`);
    }

    this.dispatchEvent(new CustomEvent('concord-verified', {
      detail: { ok: out.ok, outcome: derived, claimed, disputed: Boolean(disputed),
                complaints: out.complaints },
      bubbles: true,
    }));
  }
}

if (!customElements.get('concord-receipt')) {
  customElements.define('concord-receipt', ConcordReceipt);
}

export { ConcordReceipt };
