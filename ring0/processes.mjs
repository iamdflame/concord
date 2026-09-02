// Ring 0's supervised processes, distinct from Concord's vendor origins. Each is a separate origin, and each must both grant
// the kernel access (exposedTo) and be granted the tools permission by the
// embedder (allow="tools"). Consent on both sides, which is the property that
// makes composition here different from scraping.
export const MAIL   = 'http://localhost:5174';
export const LEDGER = 'http://localhost:5175';
export const PAY    = 'http://localhost:5176';
export const ALL = [MAIL, LEDGER, PAY];
