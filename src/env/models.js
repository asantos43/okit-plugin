import process from 'node:process';

import claudeCode from '../../adapters/claude-code/index.js';
import codex from '../../adapters/codex/index.js';
import opencode from '../../adapters/opencode/index.js';
import { DEFAULT_CONFIG, PROFILE_EFFORTS, configOf } from '../profiles.js';

const DEFAULT_ADAPTERS = [claudeCode, codex, opencode]
  .filter((adapter) => Object.hasOwn(DEFAULT_CONFIG.profiles, adapter.CLIENT));

export const DETECT_MESSAGES = Object.freeze({
  error: 'The model list for {client} could not be read, so the catalog is used. / A lista de modelos de {client} não pôde ser lida, então o catálogo é usado.',
  listed: 'The configured model "{model}" is active in the detected list. / O modelo configurado "{model}" está ativo na lista detectada.',
  replaced: 'The configured model "{model}" is unavailable; the active candidate "{replacement}" belongs to the same family. / O modelo configurado "{model}" não está disponível; o candidato ativo "{replacement}" pertence à mesma família.',
  omitted: 'The configured model "{model}" is unavailable and no active candidate belongs to its family; choose one by hand with `okit-plugin config set profiles.{client}.{class}.model <model>`. / O modelo configurado "{model}" não está disponível e nenhum candidato ativo pertence à sua família; escolha um manualmente com `okit-plugin config set profiles.{client}.{class}.model <model>`.',
  catalog: 'The model list is unavailable, so the configured catalog model is kept. / A lista de modelos não está disponível, então o modelo do catálogo configurado é mantido.',
});

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function adapterRecords(adapters) {
  const given = adapters === undefined ? DEFAULT_ADAPTERS : adapters;
  if (Array.isArray(given)) {
    return given.map((adapter) => ({ adapter, client: adapter?.CLIENT }));
  }
  if (given && typeof given === 'object') {
    return Object.entries(given).map(([client, adapter]) => ({ adapter, client: adapter?.CLIENT ?? client }));
  }
  return [];
}

// The reason a user reads never names a technical code: the code of the
// failure stays in the `error` field of the record, for diagnosis only.
function fallback(client, error) {
  return {
    client,
    installed: null,
    models: [],
    hidden: [],
    source: 'catalog',
    reason: fill(DETECT_MESSAGES.error, { client }),
    error: String(error?.code ?? error?.message ?? 'unknown'),
  };
}

export function normalizeClientObservation(result, client) {
  return {
    client: result?.client ?? client,
    installed: result?.installed ?? null,
    models: Array.isArray(result?.models)
      ? result.models.filter((model) => typeof model === 'string' && model.trim()
        && !result.hidden?.includes(model)) : [],
    hidden: Array.isArray(result?.hidden)
      ? result.hidden.filter((model) => typeof model === 'string') : [],
    source: result?.source === 'listing' ? 'listing' : 'catalog',
    reason: result?.reason ?? fill(DETECT_MESSAGES.catalog, { client }),
    error: result?.error === undefined || result?.error === null
      ? null : String(result.error),
  };
}

export async function detectClients({ config, env = process.env, run, adapters } = {}) {
  const records = adapterRecords(adapters);
  const clients = await Promise.all(records.map(async ({ adapter, client }) => {
    try {
      if (typeof adapter?.listModels !== 'function') throw new TypeError('listModels is not a function');
      return normalizeClientObservation(await adapter.listModels({ config, env, run }), client);
    } catch (error) {
      return fallback(client, error);
    }
  }));
  return { clients };
}

function commonPrefix(left, right) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

// D61: the family of a model name. The text before the separator is the
// provider and the rest is the name of the model itself. An empty separator
// separates nothing: the whole name is the model itself.
function splitFamily(model, separator) {
  const text = String(model);
  const index = separator === '' ? -1 : text.indexOf(separator);
  if (index < 0) return { provider: '', rest: text };
  return { provider: text.slice(0, index), rest: text.slice(index + separator.length) };
}

// D61: the family rule of a client, read from the configuration
// (`setup.detect.<client>.family`). `null` means the client has no rule:
// nothing replaces a configured model and every class is omitted. A
// separator that is not text, or that is empty, is no rule at all: it would
// join every name to the same empty provider and let a model of another
// provider replace the configured one.
function familyRule(settings) {
  const family = settings?.family;
  if (!family || typeof family !== 'object' || Array.isArray(family)) return null;
  if (!Number.isInteger(family.minimumPrefix) || family.minimumPrefix < 0) return null;
  if (typeof family.separator !== 'string' || family.separator === '') return null;
  return { separator: family.separator, minimumPrefix: family.minimumPrefix };
}

// D61: the nearest active candidate of the same family. Two names are of the
// same family when the provider is the same one and the common prefix of the
// rest reaches the minimum the client asks for. A different provider is
// never of the same family, and a name with no rule never replaces another.
function nearestCandidate(model, candidates, active, rule) {
  if (rule === null) return null;
  const left = splitFamily(model, rule.separator);
  let nearest = null;
  let prefix = 0;
  for (const candidate of candidates) {
    if (!active.has(candidate.model)) continue;
    const right = splitFamily(candidate.model, rule.separator);
    if (right.provider !== left.provider) continue;
    const length = commonPrefix(left.rest, right.rest);
    if (length < rule.minimumPrefix) continue;
    if (nearest === null || length > prefix
      || (length === prefix && candidate.user && !nearest.user)) {
      nearest = candidate;
      prefix = length;
    }
  }
  return nearest?.model ?? null;
}

function candidateEntries(profiles, settings) {
  const entries = [];
  const add = (model, user) => {
    if (typeof model !== 'string' || model.trim() === '') return;
    const name = model.trim();
    const held = entries.find((entry) => entry.model === name);
    if (held) {
      held.user ||= user;
      return;
    }
    entries.push({ model: name, user });
  };
  for (const profile of Object.values(profiles ?? {})) add(profile?.model, false);
  for (const model of Array.isArray(settings?.candidates) ? settings.candidates : []) {
    add(model, true);
  }
  return entries;
}

function catalogProposal(profile, className, detected) {
  return {
    model: profile.model,
    effort: profile.effort ?? PROFILE_EFFORTS[className],
    source: 'catalog',
    reason: detected.reason,
  };
}

function listingProposal(profile, className, detected, candidates, active, rule) {
  if (active.has(profile.model)) {
    return {
      model: profile.model,
      effort: profile.effort ?? PROFILE_EFFORTS[className],
      source: 'listing',
      reason: fill(DETECT_MESSAGES.listed, { model: profile.model }),
    };
  }
  const replacement = nearestCandidate(profile.model, candidates, active, rule);
  if (replacement === null) {
    return {
      model: null,
      effort: profile.effort ?? PROFILE_EFFORTS[className],
      source: 'omitted',
      reason: fill(DETECT_MESSAGES.omitted, {
        model: profile.model,
        client: detected.client,
        class: className,
      }),
    };
  }
  return {
    model: replacement,
    effort: profile.effort ?? PROFILE_EFFORTS[className],
    source: 'replaced',
    reason: fill(DETECT_MESSAGES.replaced, {
      model: profile.model,
      replacement,
    }),
  };
}

function recordsOf(detected) {
  if (Array.isArray(detected)) return detected;
  if (Array.isArray(detected?.clients)) return detected.clients;
  return [];
}

export function proposeProfiles(detected, config) {
  const resolved = configOf(config);
  const records = recordsOf(detected);
  const byClient = new Map(records.map((record) => [record?.client, record]));
  const clients = Object.keys(resolved.profiles).map((client) => {
    const classes = resolved.profiles[client] ?? {};
    const detectedClient = byClient.get(client) ?? {
      client, models: [], hidden: [], source: 'catalog',
      reason: fill(DETECT_MESSAGES.catalog, { client }),
    };
    const settings = resolved.setup.detect?.[client] ?? {};
    const candidates = candidateEntries(classes, settings);
    const rule = familyRule(settings);
    const active = new Set(detectedClient.models);
    const profiles = {};
    for (const [className, profile] of Object.entries(classes)) {
      if (!profile || typeof profile.model !== 'string' || profile.model === '') continue;
      profiles[className] = detectedClient.source === 'listing'
        ? listingProposal(profile, className, detectedClient, candidates, active, rule)
        : catalogProposal(profile, className, detectedClient);
    }
    const candidatesActive = candidates.filter((candidate) => active.has(candidate.model)).length;
    return {
      client,
      profiles,
      summary: {
        listed: detectedClient.models.length + detectedClient.hidden.length,
        active: detectedClient.models.length,
        candidatesActive,
      },
    };
  });
  return { clients };
}
