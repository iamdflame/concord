// Resolved origins, and who the participants are.
//
// Works in a browser (from location) and in Node (from the local table), so the
// same module serves the coordinator, the vendors, the dev server and the
// deploy scripts. Nothing downstream ever writes an origin again.

import { LOCAL, LIVE } from './origins.mjs';

const hostname = globalThis.location?.hostname ?? 'localhost';
const isLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(hostname);

/**
 * Deployed pages resolve against the live table.
 *
 * If a page is served from somewhere that is not localhost and no live table
 * was written, that is a broken deployment rather than a reason to fall back to
 * localhost addresses that cannot possibly work from there.
 */
export const ORIGINS = isLocal ? LOCAL : (LIVE ?? (() => {
  throw new Error(
    'This build was deployed without an origin table. Run deploy/build.mjs, which writes LIVE '
    + 'in origins.mjs from the deployed URLs, and redeploy.');
})());

/** The commitment participants, in no particular order. */
export const VENDORS = ['fly', 'stay', 'visa', 'permit', 'meridian', 'byo'];

export const COORDINATOR = ORIGINS.app;

/** Where a receipt can be checked by something that is not the coordinator. */
export const VERIFIER = ORIGINS.verify;
export const VENDOR_ORIGINS = VENDORS.map((id) => ORIGINS[id]);

export const TITLES = {
  app: 'Concord',
  fly: 'Northwind Air',
  stay: 'Rowan House',
  visa: 'Consular Fee',
  permit: 'Entry Permit',
  meridian: 'Meridian Holdings',
  byo: 'Sandbox',
  verify: 'Receipts',
};

/** Which local port serves an origin, for the dev server only. */
export const LOCAL_PORTS = Object.fromEntries(
  Object.entries(LOCAL).map(([id, url]) => [Number(new URL(url).port), id]));

export const isDeployed = !isLocal;
