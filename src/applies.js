// There is one global inbox and one global set of standing orders, so a demand,
// an order and a template each say which projects they apply to. Anything local
// to a project lives in that project's own file; the record only references it.

function fail(message) {
  throw new TypeError(message);
}

/** Every project: the default, which is never stored on a record. */
export const GLOBAL = 'global';

/**
 * Normalises `appliesTo`: names are trimmed and deduplicated, the shape given is
 * kept (a one-name array stays an array) and the global default is never stored,
 * so a record without the field is the one that applies everywhere.
 */
export function validateAppliesTo(value) {
  if (value === undefined || value === null) return undefined;
  const many = Array.isArray(value);
  if (many && value.length === 0) fail('appliesTo must name at least one project');
  if (!many && typeof value !== 'string') {
    fail('appliesTo must be a non-empty string or an array of non-empty strings');
  }

  const names = [];
  for (const entry of many ? value : [value]) {
    if (typeof entry !== 'string') fail('appliesTo must hold only non-empty strings');
    const name = entry.trim();
    if (name === '') fail('appliesTo must hold only non-empty strings');
    if (!names.includes(name)) names.push(name);
  }
  if (names.includes(GLOBAL) && names.length > 1) {
    fail('appliesTo: global cannot be combined with other projects');
  }
  if (names.length === 1 && names[0] === GLOBAL) return undefined;
  return many ? names : names[0];
}

/**
 * The filter of a list: one project, or `global` for the shared records. A list
 * of projects is refused, since the union it would ask for is ambiguous.
 */
export function validateAppliesToFilter(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    fail('appliesTo must be a non-empty string when filtering');
  }
  return value.trim();
}

/**
 * A record without `appliesTo` is global, so it shows for every project and for
 * the `global` filter; one that names projects only shows for those.
 */
export function inScope(record, wanted) {
  if (record.appliesTo === undefined) return true;
  if (Array.isArray(record.appliesTo)) return record.appliesTo.includes(wanted);
  return record.appliesTo === wanted;
}