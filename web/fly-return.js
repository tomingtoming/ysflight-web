// Pure utility for the "return after flight" feature.
//
// flyUrl() (studio-shared.js) appends &return=<page> to Quick Flight URLs so
// that index.html can navigate back to the originating studio page when the
// flight ends.  This module holds the whitelist validator so it can be unit-
// tested independently of the browser runtime.

/** Pages that may be used as a ?return= target (lower-cased for comparison). */
export const RETURN_WHITELIST = [
  'workbench.html',
  'studio-aircraft.html',
  'studio-scenery.html',
  'studio-pack.html',
];

/**
 * Validate a ?return= value.
 *
 * Returns the original value unchanged when valid, or null when rejected.
 * Rejects anything that:
 *   - is not in the whitelist
 *   - contains a path separator (/, \)
 *   - contains a scheme delimiter (:)
 *   - contains a dot-dot sequence (..)
 *
 * The whitelist is the primary guard; the character checks are defence-in-depth.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function validateReturnPage(raw) {
  if (!raw) return null;
  // Defence-in-depth: reject any value containing dangerous characters.
  if (/[/\\:]|\.\./.test(raw)) return null;
  // Whitelist is the real gate.
  if (RETURN_WHITELIST.indexOf(raw.toLowerCase()) === -1) return null;
  return raw;
}
