import { DEFAULT_CONFIG } from '../profiles.js';
const privateKeyPattern = DEFAULT_CONFIG.trajectory.redactionPatterns.at(-1);
// One marker scan: an unmatched BEGIN must never rescan the remaining text.
function privateKeys(text, replacement) {
  const markers = /-----BEGIN [^-]*PRIVATE KEY-----|-----END [^-]*PRIVATE KEY-----/gi;
  const chunks = []; let begin = -1, copied = 0;
  for (const marker of text.matchAll(markers)) {
    if (marker[0].slice(5, 10).toUpperCase() === 'BEGIN') {
      if (begin < 0) begin = marker.index;
    } else if (begin >= 0) {
      chunks.push(text.slice(copied, begin), replacement());
      copied = marker.index + marker[0].length; begin = -1;
    }
  }
  chunks.push(text.slice(copied));
  return chunks.join('');
}
function replace(text, pattern, config, replacement) {
  // Leave oversized payloads to the file cap, which also records visible truncation.
  if (Buffer.byteLength(text) > config.maxFileBytes) return text;
  return pattern.source === privateKeyPattern
    ? privateKeys(text, replacement) : text.replace(pattern, replacement);
}
// Walk values and keys: secrets can occur in prompts, tool arguments or results.
export function redact(value, config) {
  if (typeof value === 'string') {
    return config.patterns.reduce((text, pattern) => replace(text, pattern, config, () => config.redactionMarker), value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, config));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, config),
      config.patterns.some(pattern => {
        let matched = false;
        replace(`${key}=value`, pattern, config, () => { matched = true; return config.redactionMarker; });
        return matched;
      }) ? config.redactionMarker : redact(item, config)]));
  }
  return value;
}
