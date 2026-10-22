// Effort classification from measurable signals only: word counts, check
// counts, listed steps and a small hint list. Same input, same output.
export const EFFORT_CLASSES = ['simple', 'normal', 'hard'];

// Hint stems, matched case-insensitively on a word boundary so "migrating"
// and "migrations" hit the same hint. Keep short and generic: a demand is
// any delegable work, not only code.
const HINTS = {
  hard: [
    'design', 'migrat', 'investigat', 'architect', 'refactor', 'redesign',
    'rewrit', 'debug', 'audit', 'benchmark', 'optimiz', 'optimis', 'scal',
    'secur', 'trade-off', 'root cause', 'cross-team', 'multi-step',
  ],
  simple: [
    'rename', 'typo', 'listing', 'reword', 'spelling', 'reformat', 'capitalize',
    'capitalise', 'one-line', 'one liner',
  ],
};

// Signals are measured first, then each rule reads them. Thresholds live here
// so tuning is a data change: the first rule that matches decides the class.
export const CLASSIFIER_RULES = [
  {
    id: 'hard-hint',
    effort: 'hard',
    test: (s) => s.hardHints.length > 0,
    reason: (s) => `hard hint: ${s.hardHints.join(', ')}`,
  },
  {
    id: 'easy-hint',
    effort: 'simple',
    test: (s) => s.easyHints.length > 0,
    reason: (s) => `easy hint: ${s.easyHints.join(', ')}`,
  },
  {
    id: 'long-body',
    effort: 'hard',
    test: (s) => s.bodyWords >= 400,
    reason: (s) => `body has ${s.bodyWords} words (400 or more)`,
  },
  {
    id: 'many-steps',
    effort: 'hard',
    test: (s) => s.steps >= 6,
    reason: (s) => `body lists ${s.steps} steps (6 or more)`,
  },
  {
    id: 'many-checks',
    effort: 'hard',
    test: (s) => s.acceptChecks >= 6,
    reason: (s) => `accept lists ${s.acceptChecks} checks (6 or more)`,
  },
  {
    id: 'mid-body',
    effort: 'normal',
    test: (s) => s.bodyWords >= 120,
    reason: (s) => `body has ${s.bodyWords} words (120 or more)`,
  },
  {
    id: 'some-steps',
    effort: 'normal',
    test: (s) => s.steps >= 3,
    reason: (s) => `body lists ${s.steps} steps (3 or more)`,
  },
  {
    id: 'some-checks',
    effort: 'normal',
    test: (s) => s.acceptChecks >= 3,
    reason: (s) => `accept lists ${s.acceptChecks} checks (3 or more)`,
  },
  {
    id: 'short-body',
    effort: 'simple',
    test: (s) => s.bodyWords > 0 && s.bodyWords <= 40,
    reason: (s) => `body has ${s.bodyWords} words (40 or fewer)`,
  },
];

function hintPattern(hint) {
  const stem = hint.split(/[\s-]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]');
  return new RegExp(`(?<![\\p{L}\\p{N}])${stem}[\\p{L}\\p{N}]*(?![\\p{L}\\p{N}])`, 'giu');
}

function findHints(text, hints) {
  const found = [];
  for (const hint of hints) {
    const match = text.match(hintPattern(hint));
    if (match) found.push(match[0].toLowerCase());
  }
  return found;
}

function countWords(text) {
  const matched = String(text ?? '').match(/\p{L}[\p{L}\p{N}'-]*/gu);
  return matched ? matched.length : 0;
}

// A step is a list item: a bullet or a number with a dot. Headings and prose
// lines do not count, so a long paragraph is not read as a plan.
const STEP_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/gm;

function countSteps(body) {
  return (String(body ?? '').match(STEP_LINE) ?? []).length;
}
/**
 * Classifies a demand into `simple`, `normal` or `hard` and says why.
 * `kind` is free text and is only scanned for hints; `accept` is the list of
 * checks the demand itself must pass.
 *
 * @param {{title?: string, body?: string, kind?: string, accept?: string[]}} demand
 * @returns {{effort: string, reasons: string[]}}
 */
export function classify(demand = {}) {
  const title = String(demand.title ?? '');
  const body = String(demand.body ?? '');
  const hintsText = `${title} ${String(demand.kind ?? '')} ${body}`;
  const accept = Array.isArray(demand.accept) ? demand.accept : [];

  const signals = {
    bodyWords: countWords(body),
    steps: countSteps(body),
    acceptChecks: accept.length,
    hardHints: findHints(hintsText, HINTS.hard),
    easyHints: findHints(hintsText, HINTS.simple),
  };

  const reasons = [];
  for (const rule of CLASSIFIER_RULES) {
    if (!rule.test(signals)) continue;
    reasons.push(`${rule.id}: ${rule.reason(signals)}`);
    return { effort: rule.effort, reasons };
  }

  reasons.push('default: no rule matched, so normal');
  return { effort: 'normal', reasons };
}