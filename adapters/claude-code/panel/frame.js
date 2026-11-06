// Adapted from orchestration-kit task-board/hooks/frame.ts, commit 3451493.
const wideSymbols = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4,
  0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705,
  0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795,
  0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
  ...Array.from({ length: 12 }, (_, i) => 0x2648 + i),
]);
/** @param {number} cp */
function cellOf(cp) {
  if (cp === 0 || /[\p{Mn}\p{Me}\p{Cf}]/u.test(String.fromCodePoint(cp))) return 0;
  return ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) || wideSymbols.has(cp)) ? 2 : 1;
}
/** @param {string} text */
export function textWidth(text) {
  return [...text].reduce((width, ch) => width + cellOf(ch.codePointAt(0) ?? 0), 0);
}
/** @param {string} text @param {number} width */
export function clipText(text, width) {
  const max = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const clean = cleanText(text);
  if (!max) return '';
  if (textWidth(clean) <= max) return clean;
  let out = '';
  for (const ch of clean) {
    if (textWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** @param {string} text */
const cleanText = text => text.replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\u061c\ufeff]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
/** @param {string} text @param {number} width */
export function wrapText(text, width) {
  const rows = [];
  let row = '';
  for (const ch of cleanText(text)) {
    if (textWidth(row + ch) > width) {
      if (rows.length === 2) return [...rows, clipText(row + ch + '…', width)];
      if (row) rows.push(row);
      row = '';
    }
    row += textWidth(ch) > width ? clipText(ch, width) : ch;
  }
  return [...rows, clipText(row, width)];
}

/** @param {string} title @param {readonly string[]} rows @param {number} width */
export function frameLines(title, rows, width) {
  const w = Number.isFinite(width) ? Math.max(1, Math.min(240, Math.floor(width))) : 80;
  const wrapped = rows.flatMap(row => wrapText(row, w < 40 ? w : w - 4));
  if (w < 40) return [clipText(title, w), ...wrapped];
  const inner = w - 2;
  const label = clipText(`═ ${title} `, inner);
  return [
    `╔${label}${'═'.repeat(inner - textWidth(label))}╗`,
    ...wrapped.map(row => {
      const body = clipText(row, w - 4);
      return `║ ${body}${' '.repeat(w - 4 - textWidth(body))} ║`;
    }),
    `╚${'═'.repeat(inner)}╝`,
  ];
}
