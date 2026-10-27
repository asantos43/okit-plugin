// Walk values and keys: secrets can occur in prompts, tool arguments or results.
export function redact(value, config) {
  if (typeof value === 'string') {
    return config.patterns.reduce((text, pattern) => text.replace(pattern, () => config.redactionMarker), value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, config));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, config),
      config.patterns.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(`${key}=value`);
      }) ? config.redactionMarker : redact(item, config)]));
  }
  return value;
}
