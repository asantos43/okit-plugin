// The configuration of a root: the entries of the schema, the value each one
// has (and where that value came from) and the change of one of them. Nothing
// here prints and nothing here decides an exit code: the caller asks for a
// value and prints what comes back.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_SCHEMA } from '../config-schema.js';
import { configuredClientsOf, configOf, DEFAULT_CONFIG, PROFILE_EFFORTS } from '../profiles.js';
import { installConfig } from '../install/config.js';
import { paths } from '../store.js';
import { readJson, withLock, writeJsonAtomic } from '../state.js';
import { argsOf, optionalText, requiredText } from './arguments.js';
import { Refusal } from './refusal.js';

export { CONFIG_SCHEMA };

/** Fills the `{name}` of a template with the values of a message. */
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function isReservedSegment(value) {
  return CONFIG_SCHEMA.reservedPathSegments.includes(value);
}

function isSafeScopeName(scope, value) {
  return typeof value === 'string'
    && !isReservedSegment(value)
    && CONFIG_SCHEMA.scopePatterns[scope].test(value);
}

function isSafePath(path) {
  return path.split('.').every((part) => !isReservedSegment(part));
}

function scopesOf(raw) {
  const configured = configuredClientsOf(raw)
    .filter((name) => isSafeScopeName('clients', name));
  const clients = [...new Set([
    ...Object.keys(DEFAULT_CONFIG.profiles),
    ...configured,
  ])].filter((name) => isSafeScopeName('clients', name)).sort();
  const classes = Object.keys(PROFILE_EFFORTS)
    .filter((name) => isSafeScopeName('classes', name));
  return { clients, classes };
}

function expandTemplate(template, values) {
  return template.replace(/<(\w+)>/g, (_, name) => values[name]);
}

function expandEntry(entry, scopes) {
  const names = Object.keys(entry.placeholders ?? {});
  let variants = [{}];
  for (const name of names) {
    variants = variants.flatMap((values) => scopes[entry.placeholders[name]].map((value) => (
      { ...values, [name]: value }
    )));
  }
  return variants.map((values) => ({
    ...entry,
    values,
    path: expandTemplate(entry.path, values),
    defaultPath: entry.defaultPath ? expandTemplate(entry.defaultPath, values) : undefined,
  }));
}

function schemaEntries(raw) {
  const scopes = scopesOf(raw);
  return CONFIG_SCHEMA.entries.flatMap((entry) => expandEntry(entry, scopes));
}

function lookup(root, path) {
  if (!isSafePath(path)) {
    return { exists: false, value: undefined, explicitNull: false };
  }
  let current = root;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined, explicitNull: false };
    }
    current = current[part];
  }
  return { exists: true, value: current, explicitNull: current === null };
}

function rawValue(raw, path) {
  const found = lookup(raw, path);
  if (found.exists) return found;
  if (!isSafePath(path)) return found;
  let current = raw;
  for (const part of path.split('.').slice(0, -1)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined, explicitNull: false };
    }
    current = current[part];
    if (current === null) return { exists: false, value: null, explicitNull: true };
  }
  return found;
}

function effectiveValue(entry, raw, config) {
  const direct = lookup(config, entry.path);
  const rawEntry = rawValue(raw, entry.path);
  const fromLegacyAlias = (entry.legacyAliases ?? []).some((alias) => lookup(raw, alias).exists);
  if (direct.exists) {
    return {
      value: direct.value,
      origin: rawEntry.exists || fromLegacyAlias
        ? CONFIG_SCHEMA.origins.user
        : CONFIG_SCHEMA.origins.default,
    };
  }
  if (rawEntry.explicitNull) return { value: null, origin: CONFIG_SCHEMA.origins.user };
  const fallback = entry.defaultPath ? lookup(config, entry.defaultPath) : { exists: false };
  return {
    value: fallback.exists ? fallback.value : undefined,
    origin: CONFIG_SCHEMA.origins.default,
  };
}

function templateMatch(template, key) {
  const expected = template.split('.');
  const actual = key.split('.');
  if (expected.length !== actual.length) return null;
  const values = {};
  for (let index = 0; index < expected.length; index += 1) {
    const match = expected[index].match(/^<(\w+)>$/);
    if (match) values[match[1]] = actual[index];
    else if (expected[index] !== actual[index]) return null;
  }
  return values;
}

export function resolveEntry(key, raw) {
  if (!isSafePath(key)) return { error: { type: 'unknown' } };
  const entries = schemaEntries(raw);
  const exact = entries.find((entry) => entry.path === key);
  if (exact) return { entry: exact };
  const scopes = scopesOf(raw);
  for (const template of CONFIG_SCHEMA.entries) {
    const values = templateMatch(template.path, key);
    if (!values) continue;
    for (const [name, scope] of Object.entries(template.placeholders ?? {})) {
      if (!isSafeScopeName(scope, values[name])) {
        return { error: { type: 'unknown' } };
      }
      if (!scopes[scope].includes(values[name])) {
        return {
          error: {
            type: 'scope', message: CONFIG_SCHEMA.scopeMessages[scope],
            value: values[name], values: scopes[scope],
          },
        };
      }
    }
  }
  return { error: { type: 'unknown' } };
}

function parseValue(entry, text) {
  const trimmed = String(text ?? '').trim();
  let value;
  if (entry.type === 'boolean') {
    if (!['true', 'false'].includes(trimmed)) return { error: 'invalidValue' };
    value = trimmed === 'true';
  } else if (entry.type === 'object') {
    try { value = JSON.parse(trimmed); } catch { return { error: 'invalidValue' }; }
    if (!isObjectRecord(value)) return { error: 'invalidValue' };
  } else if (entry.type === 'text') {
    value = String(text ?? '');
  } else if (entry.type === 'integer') {
    if (!/^[+-]?\d+$/.test(trimmed)) return { error: 'invalidValue' };
    value = Number(trimmed);
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return { error: 'invalidValue' };
  } else if (entry.type === 'number') {
    if (trimmed === '') return { error: 'invalidValue' };
    value = Number(trimmed);
    if (!Number.isFinite(value)) return { error: 'invalidValue' };
  } else if (entry.type === 'string') {
    value = trimmed;
    if (value === '') return { error: 'invalidValue' };
  } else if (entry.type === 'profile') {
    // The class itself: `null` is the only value it takes, because it is the
    // state that says the class is disabled.
    if (trimmed !== 'null') return { error: 'invalidValue' };
    value = null;
  } else return { error: 'invalidValue' };

  if (entry.minimum !== undefined && value < entry.minimum) return { error: 'invalidValue' };
  if (entry.maximum !== undefined && value > entry.maximum) return { error: 'invalidValue' };
  if (entry.allowedValues && !entry.allowedValues.includes(value)) return { error: 'invalidChoice' };
  return { value };
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A record with no key of its own: what a removal leaves behind, and what
// must not stay in the file, because an empty group names no client and no
// class, and the reader counts only what names one.
function isEmptyRecord(value) {
  return isObjectRecord(value) && Object.keys(value).length === 0;
}

function setPath(root, path, value) {
  if (!isSafePath(path)) return { error: { type: 'unknown' } };
  const parts = path.split('.');
  let target = root;
  const walked = [];
  for (const part of parts.slice(0, -1)) {
    walked.push(part);
    const child = Object.hasOwn(target, part) ? target[part] : undefined;
    // An ancestor that is not an object is a state the user chose (a disabled
    // profile is `null`): the write never crosses it, and the command says
    // which path holds it.
    if (child !== undefined && !isObjectRecord(child)) {
      return { error: { type: 'disabled', path: walked.join('.') } };
    }
    if (!isObjectRecord(child)) {
      const created = Object.create(null);
      Object.defineProperty(target, part, {
        value: created, writable: true, enumerable: true, configurable: true,
      });
      target = created;
    } else {
      target = child;
    }
  }
  Object.defineProperty(target, parts.at(-1), {
    value, writable: true, enumerable: true, configurable: true,
  });
  return { ok: true };
}

// Fill absent leaves only; explicit nulls and non-object ancestors are choices.
export function fillMissingConfig(target, detected) {
  let changed = false;
  for (const [key, value] of Object.entries(detected)) {
    if (CONFIG_SCHEMA.reservedPathSegments.includes(key)) continue;
    if (!Object.hasOwn(target, key)) {
      target[key] = structuredClone(value);
      changed = true;
    } else if (isObjectRecord(target[key]) && isObjectRecord(value)) {
      changed = fillMissingConfig(target[key], value) || changed;
    }
  }
  return changed;
}

function unsetPath(root, path) {
  if (!isSafePath(path)) return;
  const parts = path.split('.');
  // The chain of ancestors, from the root down to the parent of the leaf.
  const ancestors = [];
  let target = root;
  for (const part of parts.slice(0, -1)) {
    if (!isObjectRecord(target) || !Object.hasOwn(target, part)) return;
    const child = target[part];
    if (!isObjectRecord(child)) return;
    ancestors.push([target, part]);
    target = child;
  }
  if (!isObjectRecord(target) || !Object.hasOwn(target, parts.at(-1))) return;
  delete target[parts.at(-1)];
  // An ancestor the removal left empty goes with it, up to the root: the file
  // must read the same as it read before the value was set. An ancestor that
  // still holds another key stays.
  for (const [parent, part] of ancestors.reverse()) {
    if (!isEmptyRecord(parent[part])) break;
    delete parent[part];
  }
}

function removeLegacyAliases(raw, entry) {
  const removed = [];
  for (const alias of entry.legacyAliases ?? []) {
    if (!lookup(raw, alias).exists) continue;
    unsetPath(raw, alias);
    removed.push(alias);
  }
  return removed;
}

function refusalMessage(resolved, key) {
  if (resolved.error.type === 'unknown') {
    const patterns = CONFIG_SCHEMA.entries.map((entry) => entry.path).join(', ');
    return fill(CONFIG_SCHEMA.messages.unknownKey, { key, patterns });
  }
  return fill(CONFIG_SCHEMA.messages[resolved.error.message], {
    key,
    value: resolved.error.value,
    values: resolved.error.values.join(', '),
  });
}

async function readState(root) {
  const raw = await readJson(paths(root).config, {});
  // The installer's settings are read here too, so that no command works on a file whose `install` is invalid.
  installConfig(raw?.install);
  return { raw, config: configOf(raw) };
}

async function mutateState(root, mutate, write) {
  const locks = paths(root).locks;
  await mkdir(locks, { recursive: true });
  return withLock(join(locks, 'config'), async () => {
    const { raw, config } = await readState(root);
    const result = await mutate(raw, config);
    if (result.write !== undefined) await write(paths(root).config, result.write);
    return result;
  });
}

/**
 * The configuration of a root: every entry of the schema, or one of them when
 * a key is given.
 *
 * @param {string} root state root
 * @param {{key?: string}} [args] the key of one entry, or nothing for the whole table
 * @returns {Promise<{entries: {path: string, value: unknown, origin: string, description: object}[]}>}
 */
export async function configGet(root, args = {}) {
  const given = argsOf('config_get', args, ['key']);
  const key = optionalText('config_get', given, 'key');
  const { raw, config } = await readState(root);
  if (key === undefined) {
    return {
      entries: schemaEntries(raw).map((entry) => ({
        path: entry.path, ...effectiveValue(entry, raw, config), description: entry.description,
      })),
    };
  }
  const resolved = resolveEntry(key, raw);
  if (resolved.error) throw new Refusal(refusalMessage(resolved, key));
  return {
    entries: [{
      path: key, ...effectiveValue(resolved.entry, raw, config), description: resolved.entry.description,
    }],
  };
}

/**
 * The change of one entry: the value it had, the value it has now, and the
 * legacy names that were removed with it. Without a value the entry is unset
 * and the root reads as it read before the value was set.
 *
 * @param {string} root state root
 * @param {{key: string, value?: string}} args the key and the new value
 * @param {{write?: Function}} [deps] the writer of the file of the configuration
 * @returns {Promise<{path: string, previous: object, after: object, removedAliases: string[], description: object}>}
 */
export async function configSet(root, args = {}, deps = {}) {
  const given = argsOf('config_set', args, ['key', 'value']);
  const key = requiredText('config_set', given, 'key');
  const text = optionalText('config_set', given, 'value');
  const write = deps.write ?? writeJsonAtomic;
  const result = text === undefined
    ? await unsetEntry(root, key, write)
    : await setEntry(root, key, text, write);
  if (result.error) throw new Refusal(result.message);
  return {
    path: key,
    previous: result.previous,
    after: result.after,
    removedAliases: result.removedAliases,
    description: result.entry.description,
  };
}

async function setEntry(root, key, text, write) {
  const result = await mutateState(root, async (raw, config) => {
    const resolved = resolveEntry(key, raw);
    if (resolved.error) return { error: resolved.error };
    const parsed = parseValue(resolved.entry, text);
    if (parsed.error) return { error: { type: parsed.error }, entry: resolved.entry };
    const previous = effectiveValue(resolved.entry, raw, config);
    const written = setPath(raw, key, parsed.value);
    if (written.error) return { error: written.error, entry: resolved.entry };
    if (key.startsWith('codexQuota.') || key.startsWith('todo.')) {
      try { configOf(raw); }
      catch { return { error: { type: 'invalidValue' }, entry: resolved.entry }; }
    }
    const removedAliases = removeLegacyAliases(raw, resolved.entry);
    return {
      entry: resolved.entry,
      previous,
      removedAliases,
      value: parsed.value,
      write: raw,
    };
  }, write);
  if (result.error) {
    return { error: result.error, message: messageOfSet(result, key) };
  }
  return {
    entry: result.entry,
    previous: result.previous,
    after: { value: result.value, origin: CONFIG_SCHEMA.origins.user },
    removedAliases: result.removedAliases,
  };
}

function messageOfSet(result, key) {
  if (result.error.type === 'unknown' || result.error.type === 'scope') {
    return refusalMessage(result, key);
  }
  if (result.error.type === 'disabled') {
    return fill(CONFIG_SCHEMA.messages.disabledProfile, { path: result.error.path });
  }
  return fill(CONFIG_SCHEMA.messages[result.error.type], {
    key,
    constraintEn: result.entry.constraint.en,
    constraintPt: result.entry.constraint['pt-BR'],
    values: (result.entry.allowedValues ?? []).join(', '),
  });
}

async function unsetEntry(root, key, write) {
  const result = await mutateState(root, async (raw, config) => {
    const resolved = resolveEntry(key, raw);
    if (resolved.error) return { error: resolved.error };
    const previous = effectiveValue(resolved.entry, raw, config);
    const removedAliases = removeLegacyAliases(raw, resolved.entry);
    unsetPath(raw, key);
    const after = effectiveValue(resolved.entry, raw, configOf(raw));
    return { entry: resolved.entry, previous, after, removedAliases, write: raw };
  }, write);
  if (result.error) return { error: result.error, message: refusalMessage(result, key) };
  return {
    entry: result.entry,
    previous: result.previous,
    after: result.after,
    removedAliases: result.removedAliases,
  };
}
