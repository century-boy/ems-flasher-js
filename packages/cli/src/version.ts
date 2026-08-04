/**
 * The version reported by `--version`.
 *
 * Kept as a constant rather than read from package.json: the published bundle
 * and the source tree resolve that file differently, and this never breaks.
 * Keep it in sync with packages/cli/package.json.
 */
export const VERSION = "1.0.0";
