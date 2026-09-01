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

  let policy = 'unknown';
  try {
    policy = document.permissionsPolicy?.allowsFeature?.('tools') ? 'granted' : 'absent';
  } catch { policy = 'unsupported' }

  if (native) return { ctx: native, provider: 'native', surface, policy };
  return { ctx: installShim(), provider: 'shim', surface: 'document.modelContext (shim)', policy };
}
