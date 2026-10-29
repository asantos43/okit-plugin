// The one policy of the exit code of the installer (install, update, uninstall, setup, kit, status, the help texts
// and the standalone scripts). Every place that ends a run asks this function; a number written beside a `return`
// or `process.exitCode` in those files fails the scan in test/install-invariants.test.js.
//
//   ok           success, and a dry run
//   operational  the work failed: no release, a missing asset, the network, the disk
//   usage        a flag, an argument or a setting that is not valid
//   language     a language that is not one (--locale or the saved one): a usage error with its own name
const CODES = Object.freeze({ ok: 0, operational: 1, usage: 2, language: 2 });

export function exitCodeFor(kind) {
  if (!Object.hasOwn(CODES, kind)) throw new RangeError(`Unknown exit kind: ${kind}`);
  return CODES[kind];
}

// The class of a failure is what the failure says it is (`error.kind`), never its type and never its text. An error
// that says nothing is a failure of the work (operational); only the ones raised with a usage or language kind are
// refusals. Every code that classifies an error calls `kindOf`, and the scan in test/install-invariants.test.js
// refuses a classification by `instanceof` or by message in the installer's files.
export class UsageError extends TypeError {
  constructor(message, options) { super(message, options); this.kind = 'usage'; }
}
export class LanguageError extends UsageError {
  constructor(message, options) { super(message, options); this.kind = 'language'; }
}
export class OperationalError extends Error {
  constructor(message, options) { super(message, options); this.kind = 'operational'; }
}

export function kindOf(error) {
  return error?.kind === 'usage' || error?.kind === 'language' ? error.kind : 'operational';
}
