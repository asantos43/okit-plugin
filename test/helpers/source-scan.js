// A small reader of JavaScript source for the static tests of the installer's invariants. It does not run or
// parse the program: it tells code from comments, strings, templates and regular expressions, and finds calls with
// their arguments, so a test can ask "what text reaches this call" without a regex over raw lines.
//
// Tokens: { t: 'id' | 'p' | 's' | 'tpl' | 're' | 'n', v } — `s` a string (v its text), `tpl` a template literal
// ({ chunks: the static texts, exprs: the token lists of each ${...} }), `p` one punctuation character.

const AFTER_WHICH_A_SLASH_IS_A_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'in', 'of', 'new', 'else', 'do']);
const ID_START = /[A-Za-z_$ -￿]/;
const ID_PART = /[A-Za-z0-9_$ -￿]/;

export function tokenize(source) {
  let index = 0;
  // Every token carries `line`, the 1-based line it starts on, so a test can name `file:line`.
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  const lineAt = (position) => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= position) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
  const readTemplate = () => {
    // `index` is just after the opening backtick.
    const chunks = [''], exprs = [];
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') { chunks[chunks.length - 1] += source[index + 1] ?? ''; index += 2; continue; }
      if (source[index] === '$' && source[index + 1] === '{') {
        index += 2;
        exprs.push(readTokens(true));
        chunks.push('');
        continue;
      }
      chunks[chunks.length - 1] += source[index];
      index += 1;
    }
    index += 1;
    return { t: 'tpl', chunks, exprs };
  };
  function readTokens(untilBrace) {
    const tokens = [];
    let depth = 0;
    while (index < source.length) {
      const c = source[index];
      const from = index;
      if (/\s/.test(c)) { index += 1; continue; }
      if (c === '/' && source[index + 1] === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
      if (c === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue; }
      if (c === '"' || c === "'") {
        let text = '';
        index += 1;
        while (index < source.length && source[index] !== c) {
          if (source[index] === '\\') { text += source[index + 1] ?? ''; index += 2; } else { text += source[index]; index += 1; }
        }
        index += 1;
        tokens.push({ t: 's', v: text, line: lineAt(from) });
        continue;
      }
      if (c === '`') { index += 1; tokens.push({ ...readTemplate(), line: lineAt(from) }); continue; }
      const last = tokens.at(-1);
      if (c === '/' && (!last || (last.t === 'p' && AFTER_WHICH_A_SLASH_IS_A_REGEX.has(last.v)) || (last.t === 'id' && KEYWORDS_BEFORE_REGEX.has(last.v)))) {
        let inClass = false;
        let text = '/';
        index += 1;
        while (index < source.length && (source[index] !== '/' || inClass)) {
          if (source[index] === '\\') { text += source[index] + (source[index + 1] ?? ''); index += 2; continue; }
          if (source[index] === '[') inClass = true;
          if (source[index] === ']') inClass = false;
          text += source[index];
          index += 1;
        }
        index += 1;
        while (index < source.length && /[a-z]/.test(source[index])) index += 1;
        tokens.push({ t: 're', v: `${text}/`, line: lineAt(from) });
        continue;
      }
      if (ID_START.test(c)) {
        let text = '';
        while (index < source.length && ID_PART.test(source[index])) { text += source[index]; index += 1; }
        tokens.push({ t: 'id', v: text, line: lineAt(from) });
        continue;
      }
      if (/[0-9]/.test(c)) {
        let text = '';
        while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) { text += source[index]; index += 1; }
        tokens.push({ t: 'n', v: text, line: lineAt(from) });
        continue;
      }
      if (untilBrace) {
        if (c === '{') depth += 1;
        if (c === '}') {
          if (depth === 0) { index += 1; return tokens; }
          depth -= 1;
        }
      }
      tokens.push({ t: 'p', v: c, line: lineAt(from) });
      index += 1;
    }
    return tokens;
  }
  return readTokens(false);
}

/** The index of the parenthesis that closes the one at `open`. */
function closing(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'p') continue;
    if (tokens[i].v === '(') depth += 1;
    if (tokens[i].v === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return tokens.length - 1;
}

/**
 * Every call in the token list, templates included: `{ callee: 'ui.detail', last: 'detail', args, tokens, at, end }`
 * where `args` are the tokens between the parentheses and `at`/`end` the positions of the name and of the closing
 * parenthesis in `tokens` (so a test can ask whether something sits inside another call).
 */
export function calls(tokens) {
  const found = [];
  tokens.forEach((token, at) => {
    if (token.t === 'tpl') for (const expr of token.exprs) found.push(...calls(expr));
    if (token.t !== 'id' || tokens[at + 1]?.v !== '(' || tokens[at + 1].t !== 'p') return;
    let from = at;
    const chain = [token.v];
    while (tokens[from - 1]?.v === '.' && tokens[from - 1].t === 'p') {
      let before = from - 2;
      if (tokens[before]?.v === '?' && tokens[before].t === 'p') before -= 1;
      if (tokens[before]?.t !== 'id') break;
      chain.unshift(tokens[before].v);
      from = before;
    }
    const end = closing(tokens, at + 1);
    const args = tokens.slice(at + 2, end);
    found.push({ callee: chain.join('.'), last: token.v, args, tokens, at, end });
    // Calls inside the arguments are found by their own turn of this loop; templates of the arguments too.
  });
  return found;
}

/** The strings and the static parts of templates at the top of an argument list (not inside a nested call). */
export function topLiterals(tokens) {
  const found = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.t === 'p' && token.v === '(') depth += 1;
    else if (token.t === 'p' && token.v === ')') depth -= 1;
    else if (depth === 0 && token.t === 's') found.push(token.v);
    else if (depth === 0 && token.t === 'tpl') {
      found.push(...token.chunks);
      for (const expr of token.exprs) found.push(...topLiterals(expr));
    }
  }
  return found;
}

/** The properties read at the top of an argument list: `error.message` gives 'error.message'. */
export function topMembers(tokens) {
  const found = [];
  let depth = 0;
  tokens.forEach((token, i) => {
    if (token.t === 'p' && token.v === '(') depth += 1;
    else if (token.t === 'p' && token.v === ')') depth -= 1;
    else if (depth === 0 && token.t === 'id' && tokens[i - 1]?.v === '.' && tokens[i - 1].t === 'p' && tokens[i - 2]?.t === 'id') found.push(`${tokens[i - 2].v}.${token.v}`);
    else if (depth === 0 && token.t === 'tpl') for (const expr of token.exprs) found.push(...topMembers(expr));
  });
  return found;
}

/** Every dotted name that appears in the token list, templates included: 'process.stdout.write', 'console.error'. */
export function dotted(tokens) {
  const found = [];
  tokens.forEach((token, at) => {
    if (token.t === 'tpl') for (const expr of token.exprs) found.push(...dotted(expr));
    if (token.t !== 'id' || (tokens[at - 1]?.v === '.' && tokens[at - 1].t === 'p')) return;
    const chain = [token.v];
    let to = at;
    while (tokens[to + 1]?.v === '.' && tokens[to + 1].t === 'p' && tokens[to + 2]?.t === 'id') { chain.push(tokens[to + 2].v); to += 2; }
    found.push({ name: chain.join('.'), tokens, at, to });
  });
  return found;
}

const callCache = new WeakMap();

/** True when the token at `at` sits inside the arguments of a call to one of `names` (same token list). */
export function insideCallTo(tokens, at, names) {
  if (!callCache.has(tokens)) callCache.set(tokens, calls(tokens));
  return callCache.get(tokens).some((call) => call.tokens === tokens && names.includes(call.last) && call.at + 1 < at && at < call.end);
}
