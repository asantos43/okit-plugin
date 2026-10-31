// The rules of the tools that existed before the registry of the operations:
// they are kept exactly as they were (a null argument is an absent one, a
// name is trimmed, a value that is not there is nothing) until the validation
// of the operations is one for every tool. Unifying them is a decision of its
// own, not something a move does by itself.
//
// The helpers here fail with a plain TypeError, the way the old tools did, so
// the message a client reads stays the same.

import { DEFAULT_CONFIG, LOCALES, localeOf } from '../profiles.js';

/** The schema of the `locale` argument, the same for every tool that takes it. */
export const LOCALE_SCHEMA = { type: 'string', enum: LOCALES, default: DEFAULT_CONFIG.language,
  description: `Language / Idioma; language (${DEFAULT_CONFIG.language}) when omitted / quando omitido.` };

/** Fails with the message of the tool that refused. */
export function fail(message) {
  throw new TypeError(message);
}

/** Whether a value is a text with something in it. */
export function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Arguments arrive as `unknown`, so the object and its keys are checked here.
export function argsOf(tool, args, allowed) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${tool}: arguments must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${tool}: unknown argument ${unknown.join(', ')}; expected ${allowed.join('|')}`);
  }
  return value;
}

export function requiredText(tool, args, name) {
  if (!isText(args[name])) fail(`${tool}: ${name} must be a non-empty string`);
  return args[name].trim();
}

export function optionalText(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${tool}: ${name} must be a string when given`);
  return value;
}

export function optionalTextList(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    fail(`${tool}: ${name} must be an array of strings when given`);
  }
  return value;
}

export function optionalCount(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    fail(`${tool}: ${name} must be a non-negative integer when given`);
  }
  return value;
}

export function optionalChoice(tool, args, name, allowed, config) {
  const value = args[name];
  if (value === undefined || value === null) return name === 'locale' ? localeOf(value, config) : undefined;
  if (!allowed.includes(value)) fail(`${tool}: ${name} must be one of ${allowed.join('|')} when given`);
  return value;
}

export function optionalMs(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${tool}: ${name} must be a number of milliseconds when given`);
  }
  return value;
}

// A quota reading is the percent left as a number, or the whole reading the
// daemon stores: `{source, remainingPct}` and nothing else.
export function optionalQuota(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return { source: 'api', remainingPct: value };
  const allowed = ['source', 'remainingPct'];
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${tool}: ${name} must be a percentage or a quota reading {source, remainingPct}`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${tool}: ${name} has unknown field ${unknown.join(', ')}; expected ${allowed.join('|')}`);
  }
  if (value.source !== undefined && typeof value.source !== 'string') {
    fail(`${tool}: ${name}.source must be a string when given`);
  }
  if (value.remainingPct !== undefined && typeof value.remainingPct !== 'number') {
    fail(`${tool}: ${name}.remainingPct must be a number when given`);
  }
  return { source: value.source, remainingPct: value.remainingPct };
}

// The shape is checked here so the message names the tool; the core still
// decides what the value means and normalises it.
export function optionalAppliesTo(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) && typeof value !== 'string') {
    fail(`${tool}: ${name} must be a non-empty string or an array of them`);
  }
  if (Array.isArray(value) && !value.every((entry) => typeof entry === 'string')) {
    fail(`${tool}: ${name} must hold only strings`);
  }
  return value;
}
