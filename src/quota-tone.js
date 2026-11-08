// The tone of a quota by its remaining percentage. The Claude Code panel is a self-contained mod and keeps its own
// copy (adapters/claude-code/panel/formatters.js); test/quota-tone.test.js keeps the two equal.
/** @param {number | null} percent @returns {'ok' | 'warn' | 'low' | 'dim'} */
export function quotaTone(percent) {
  return percent === null || !Number.isFinite(percent) ? 'dim' : percent >= 50 ? 'ok' : percent >= 20 ? 'warn' : 'low';
}
