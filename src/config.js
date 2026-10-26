import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configuredClientsOf, configOf, DEFAULT_CONFIG, PROFILE_EFFORTS } from './profiles.js';
import { paths } from './store.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';

export const CONFIG_SCHEMA = Object.freeze({
  entries: [
    {
      path: 'limits.global', type: 'integer', minimum: 1, defaultPath: 'limits.global',
      legacyAliases: ['limits.perClient'],
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Default number of executors allowed at once for each client.',
        'pt-BR': 'Número padrão de executores permitidos ao mesmo tempo em cada cliente.',
      },
    },
    {
      path: 'limits.clients.<client>', type: 'integer', minimum: 1, defaultPath: 'limits.global',
      placeholders: { client: 'clients' },
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Executor limit for this client; it replaces the global limit.',
        'pt-BR': 'Limite de executores deste cliente; ele substitui o limite global.',
      },
    },
    {
      path: 'profiles.<client>.<class>', type: 'profile', defaultPath: 'profiles.<client>.<class>',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'the literal "null" to disable the class', 'pt-BR': 'o literal "null" para desligar a classe' },
      description: {
        en: 'The profile of this client and work class; null disables the class.',
        'pt-BR': 'O perfil deste cliente e desta classe de trabalho; null desliga a classe.',
      },
    },
    {
      path: 'profiles.<client>.<class>.model', type: 'string', defaultPath: 'profiles.<client>.<class>.model',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'non-empty text', 'pt-BR': 'texto não vazio' },
      description: {
        en: 'Model used for this client and work class.',
        'pt-BR': 'Modelo usado neste cliente e nesta classe de trabalho.',
      },
    },
    {
      path: 'profiles.<client>.<class>.effort', type: 'string', defaultPath: 'profiles.<client>.<class>.effort',
      placeholders: { client: 'clients', class: 'classes' },
      allowedValues: [...new Set(Object.values(PROFILE_EFFORTS))],
      constraint: { en: 'one of the listed efforts', 'pt-BR': 'um dos esforços listados' },
      description: {
        en: 'Reasoning effort used for this client and work class.',
        'pt-BR': 'Esforço de raciocínio usado neste cliente e nesta classe de trabalho.',
      },
    },
    {
      path: 'profiles.<client>.<class>.maxTurns', type: 'integer', minimum: 1,
      defaultPath: 'profiles.<client>.<class>.maxTurns',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Maximum number of turns for this client and work class.',
        'pt-BR': 'Número máximo de voltas para este cliente e esta classe de trabalho.',
      },
    },
    {
      path: 'lowQuotaPct', type: 'number', minimum: 0, maximum: 100, defaultPath: 'lowQuotaPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'Profiles are lowered when the remaining quota is below this percentage.',
        'pt-BR': 'Os perfis são rebaixados quando a cota restante fica abaixo deste percentual.',
      },
    },
    {
      path: 'daemon.minQuotaPct', type: 'number', minimum: 0, maximum: 100,
      defaultPath: 'daemon.minQuotaPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'The daemon does not open demands when the remaining quota is below this percentage.',
        'pt-BR': 'O daemon não abre demandas quando a cota restante fica abaixo deste percentual.',
      },
    },
    {
      path: 'smoke.quotaFloorPct', type: 'number', minimum: 0, maximum: 100,
      defaultPath: 'smoke.quotaFloorPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'Smoke refuses to start when the remaining quota is below this percentage.',
        'pt-BR': 'O smoke recusa iniciar quando a cota restante fica abaixo deste percentual.',
      },
    },
    ...Object.entries(DEFAULT_CONFIG.codexQuota).filter(([key]) => key !== 'fields')
      .concat(Object.entries(DEFAULT_CONFIG.codexQuota.fields).map(([key, value]) => [`fields.${key}`, value]))
      .map(([key, value]) => ({
        path: `codexQuota.${key}`, defaultPath: `codexQuota.${key}`,
        type: typeof value === 'number' ? 'integer' : 'string',
        ...(typeof value === 'number' ? { minimum: 1 } : {}),
        constraint: { en: typeof value === 'number' ? 'an integer >= 1' : 'non-empty text',
          'pt-BR': typeof value === 'number' ? 'um inteiro >= 1' : 'texto não vazio' },
        description: { en: 'Codex automatic quota reading setting.',
          'pt-BR': 'Ajuste da leitura automática de cota do Codex.' },
      })),
  ],
  scopeMessages: { clients: 'unknownClient', classes: 'unknownClass' },
  scopePatterns: {
    clients: /^[A-Za-z0-9_-]+$/,
    classes: /^[A-Za-z0-9_-]+$/,
  },
  reservedPathSegments: ['__proto__', 'constructor', 'prototype'],
  origins: { default: 'default', user: 'user' },
  labels: {
    value: '{path} = {value} [{origin}] — {effect}',
    change: '{path}: before / antes = {before} [{beforeOrigin}] -> after / depois = {after} [{afterOrigin}] — {effect}',
  },
  messages: {
    unknownKey: 'Unknown configuration key "{key}". Valid key patterns: {patterns}. / Chave de configuração desconhecida "{key}". Padrões de chaves válidos: {patterns}.',
    unknownClient: 'Unknown client "{value}" for "{key}". Valid clients: {values}. / Cliente desconhecido "{value}" para "{key}". Clientes válidos: {values}.',
    unknownClass: 'Unknown class "{value}" for "{key}". Valid classes: {values}. / Classe desconhecida "{value}" para "{key}". Classes válidas: {values}.',
    invalidValue: 'Invalid value for "{key}". Expected {constraintEn}. / Valor inválido para "{key}". Esperado {constraintPt}.',
    invalidChoice: 'Invalid value for "{key}". Valid values: {values}. / Valor inválido para "{key}". Valores válidos: {values}.',
    disabledProfile: 'The profile "{path}" is disabled; run `config unset {path}` to enable it before changing a field. / O perfil "{path}" está desligado; rode `config unset {path}` para ligá-lo antes de mudar um campo.',
    legacyAliasRemoved: 'Removed legacy alias "{alias}"; it is the old name for "{key}". / O apelido legado "{alias}" foi removido; é o nome antigo de "{key}".',
  },
});

function fill(text, values) {
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
  if (entry.type === 'integer') {
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

function formatValue(value) {
  return value === undefined ? '-' : JSON.stringify(value);
}

function effectText(entry) {
  return `${entry.description.en} / ${entry.description['pt-BR']}`;
}

function valueLine(path, current, entry) {
  return fill(CONFIG_SCHEMA.labels.value, {
    path,
    value: formatValue(current.value),
    origin: current.origin,
    effect: effectText(entry),
  });
}

function changeLine(path, before, after, entry) {
  return fill(CONFIG_SCHEMA.labels.change, {
    path,
    before: formatValue(before.value),
    beforeOrigin: before.origin,
    after: formatValue(after.value),
    afterOrigin: after.origin,
    effect: effectText(entry),
  });
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

async function showConfig(ctx) {
  const { raw, config } = await readState(ctx.root);
  for (const entry of schemaEntries(raw)) {
    const current = effectiveValue(entry, raw, config);
    ctx.out(valueLine(entry.path, current, entry));
  }
  return 0;
}

async function getConfig(ctx, args) {
  if (args.length !== 1) return ctx.unknown();
  const key = args[0];
  const { raw, config } = await readState(ctx.root);
  const resolved = resolveEntry(key, raw);
  if (resolved.error) {
    ctx.err(refusalMessage(resolved, key));
    return 1;
  }
  const current = effectiveValue(resolved.entry, raw, config);
  ctx.out(valueLine(key, current, resolved.entry));
  return 0;
}

async function setConfig(ctx, args, write) {
  if (args.length !== 2) return ctx.unknown();
  const [key, text] = args;
  const result = await mutateState(ctx.root, async (raw, config) => {
    const resolved = resolveEntry(key, raw);
    if (resolved.error) return { error: resolved.error };
    const parsed = parseValue(resolved.entry, text);
    if (parsed.error) return { error: { type: parsed.error }, entry: resolved.entry };
    const previous = effectiveValue(resolved.entry, raw, config);
    const written = setPath(raw, key, parsed.value);
    if (written.error) return { error: written.error, entry: resolved.entry };
    if (key.startsWith('codexQuota.')) {
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
    const message = result.error.type === 'unknown' || result.error.type === 'scope'
      ? refusalMessage(result, key)
      : result.error.type === 'disabled'
        ? fill(CONFIG_SCHEMA.messages.disabledProfile, { path: result.error.path })
        : fill(CONFIG_SCHEMA.messages[result.error.type], {
          key,
          constraintEn: result.entry.constraint.en,
          constraintPt: result.entry.constraint['pt-BR'],
          values: (result.entry.allowedValues ?? []).join(', '),
        });
    ctx.err(message);
    return 1;
  }
  const after = { value: result.value, origin: CONFIG_SCHEMA.origins.user };
  ctx.out(changeLine(key, result.previous, after, result.entry));
  for (const alias of result.removedAliases) {
    ctx.out(fill(CONFIG_SCHEMA.messages.legacyAliasRemoved, { alias, key }));
  }
  return 0;
}

async function unsetConfig(ctx, args, write) {
  if (args.length !== 1) return ctx.unknown();
  const key = args[0];
  const result = await mutateState(ctx.root, async (raw, config) => {
    const resolved = resolveEntry(key, raw);
    if (resolved.error) return { error: resolved.error };
    const previous = effectiveValue(resolved.entry, raw, config);
    const removedAliases = removeLegacyAliases(raw, resolved.entry);
    unsetPath(raw, key);
    const after = effectiveValue(resolved.entry, raw, configOf(raw));
    return { entry: resolved.entry, previous, after, removedAliases, write: raw };
  }, write);
  if (result.error) {
    ctx.err(refusalMessage(result, key));
    return 1;
  }
  ctx.out(changeLine(key, result.previous, result.after, result.entry));
  for (const alias of result.removedAliases) {
    ctx.out(fill(CONFIG_SCHEMA.messages.legacyAliasRemoved, { alias, key }));
  }
  return 0;
}

export async function configCommand(ctx, action, args, { write = writeJsonAtomic } = {}) {
  if (action === 'show' && args.length === 0) return showConfig(ctx);
  if (action === 'get') return getConfig(ctx, args);
  if (action === 'set') return setConfig(ctx, args, write);
  if (action === 'unset') return unsetConfig(ctx, args, write);
  return ctx.unknown();
}
