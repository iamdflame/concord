// Resolves a model context and tells you honestly which one you got.
//
// The API is mid-rename from navigator.modelContext to document.modelContext,
// so both are probed. Reporting the provider is not a diagnostic nicety -- a
// green test run against the shim proves the kernel's logic and proves nothing
// about the browser, and those two claims must never be confused.

import { installShim } from './webmcp.mjs';

export async function resolveModelContext() {
  const native = document.modelContext ?? navigator.modelContext ?? null;
  const surface = document.modelContext ? 'document.modelContext'
                : navigator.modelContext ? 'navigator.modelContext (legacy)'
                : null;

  // Optional chaining swallowed the missing-API case: no permissionsPolicy gave
  // undefined, which is falsy, which was reported as "absent" -- a claim about
  // the policy rather than an admission that it could not be read. The catch
  // was unreachable. Chrome also exposes this as featurePolicy in most versions.
  const api = document.permissionsPolicy ?? document.featurePolicy ?? null;
  let policy;
  if (!api || typeof api.allowsFeature !== 'function') policy = 'unreadable';
  else {
    try {
      // A browser that has never heard of the feature answers false, which is
      // not the same as a policy that withholds it. Saying "absent" for both
      // reports a decision where none was made.
      const known = typeof api.features === 'function' ? api.features().includes('tools') : true;
      policy = !known ? 'unsupported' : api.allowsFeature('tools') ? 'granted' : 'withheld';
    } catch { policy = 'unreadable'; }
  }

  if (native) return { ctx: native, provider: 'native', surface, policy };
  return { ctx: installShim(), provider: 'shim', surface: 'document.modelContext (shim)', policy };
}
