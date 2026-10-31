// The arguments of an operation: they arrive as `unknown`, because a caller
// (a command line, a tool, a test) is free to send whatever it likes. The
// object, its keys and the type of each value are checked here, before any
// work starts, so a wrong argument is a refusal and never a crash.

import { Refusal } from './refusal.js';

/**
 * The arguments as an object, with no key the operation does not take.
 *
 * Only a plain object is taken: an operation reads the own keys of the
 * arguments, so an object that hides a value in its prototype (or a class
 * instance that carries one) is refused instead of read. Every own key is
 * read, the ones that hide as well: a symbol or a property that is not
 * enumerable is a key the operation does not take, so it is refused too.
 *
 * @param {string} name the operation, for the message of the refusal
 * @param {unknown} args the arguments as they arrived
 * @param {string[]} allowed the keys the operation takes
 * @returns {object} the arguments
 */
export function argsOf(name, args, allowed) {
  if (args === undefined) return {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Refusal(`${name}: arguments must be an object`);
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) throw new Refusal(`${name}: arguments must be a plain object`);
  const unknown = Reflect.ownKeys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Refusal(`${name}: unknown argument ${unknown.map((key) => String(key)).join(', ')}; expected ${allowed.join('|')}`);
  }
  return args;
}

/** The value of an argument the caller owns, or undefined when it owns none. */
function own(args, key) {
  return Object.hasOwn(args, key) ? args[key] : undefined;
}

/**
 * The value of an argument that must be a non-empty string.
 *
 * The value is taken as it came: a name with a space around it is a different
 * name, so it is refused here instead of being read as the name it looks like.
 */
export function requiredText(name, args, key) {
  const value = own(args, key);
  if (typeof value !== 'string' || value.trim() === '') throw new Refusal(`${name}: ${key} must be a non-empty string`);
  if (value !== value.trim()) throw new Refusal(`${name}: ${key} must not have leading or trailing spaces`);
  return value;
}

/** The value of an argument that may be a string, or nothing when it is absent. */
export function optionalText(name, args, key) {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined;
  const value = args[key];
  if (typeof value !== 'string') throw new Refusal(`${name}: ${key} must be a string when given`);
  return value;
}

/**
 * The value of an argument that names something, or nothing when it is absent.
 *
 * The name is exact: a name with a space around it is a different name, so it
 * is refused here, the same way the required names are.
 */
export function optionalName(name, args, key) {
  const value = optionalText(name, args, key);
  if (value === undefined) return undefined;
  if (value !== value.trim()) throw new Refusal(`${name}: ${key} must not have leading or trailing spaces`);
  return value;
}

/** The value of an argument that must be a number inside a range. */
export function requiredNumber(name, args, key, { min, max, above, integer = false } = {}) {
  const value = own(args, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refusal(`${name}: ${key} must be a number`);
  if (integer && !Number.isInteger(value)) throw new Refusal(`${name}: ${key} must be an integer`);
  if (min !== undefined && value < min) throw new Refusal(`${name}: ${key} must be ${range(min, max)}`);
  if (max !== undefined && value > max) throw new Refusal(`${name}: ${key} must be ${range(min, max)}`);
  if (above !== undefined && value <= above) throw new Refusal(`${name}: ${key} must be greater than ${above}`);
  return value;
}

/** The range of a number, in the words of a refusal. */
function range(min, max) {
  if (min === undefined) return `at most ${max}`;
  if (max === undefined) return `at least ${min}`;
  return `from ${min} to ${max}`;
}

/** The value of an argument that may be a number, or nothing when it is absent. */
export function optionalNumber(name, args, key, options = {}) {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined;
  return requiredNumber(name, args, key, options);
}

/** The value of an argument that must be one of the choices. */
export function requiredChoice(name, args, key, allowed) {
  const value = own(args, key);
  if (!allowed.includes(value)) throw new Refusal(`${name}: ${key} must be one of ${allowed.join('|')}`);
  return value;
}

/** The value of an argument that is a switch: true, false or nothing. */
export function optionalSwitch(name, args, key) {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined;
  const value = args[key];
  if (typeof value !== 'boolean') throw new Refusal(`${name}: ${key} must be a boolean when given`);
  return value;
}
