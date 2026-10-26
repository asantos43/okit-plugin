#!/usr/bin/env node
// Adapted from the kit banner: neon terminal, window buttons and pixel chair.
// Run: node docs/art/make-banner.mjs (SVG only; no external assets).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mono = "ui-monospace,'DejaVu Sans Mono',Menlo,Consolas,monospace";
const green = '#5be03a', cyan = '#35d0ee', pink = '#ff4f9a';
const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="680" viewBox="0 0 1280 680" role="img" aria-label="okit plugin: neon terminal, director chair, orchestration, model actors, automatic quota, smoke demo and lifecycle commands">'];
const add = (s) => out.push(s);
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, s, size = 24, fill = green) =>
  add(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${esc(s)}</text>`);
add('<rect width="1280" height="680" fill="#000"/>');
add(`<rect x="14" y="14" width="1252" height="652" rx="16" fill="#050805" stroke="${green}" stroke-width="3"/>`);
add(`<g font-family="${mono}">`);
text(48, 62, 'director@okit:~$', 24);
text(302, 62, '// the Director conducts, the actors play', 20, cyan);
text(1124, 62, '_', 28);
add(`<path d="M1170 44h18v18h-18z M1220 44l18 18m0-18l-18 18" fill="none" stroke="${green}" stroke-width="3"/>`);
text(430, 180, 'okit plugin', 76);
text(434, 230, 'Your client. A cast of models.', 28, cyan);
add(`<path d="M434 258h770" stroke="${green}" stroke-dasharray="4 6"/>`);
// Reference chair, clapperboard and megaphone, with pixels grouped by colour.
const WOOD = '#e8a13a'
const WOOD_D = '#a8661c'
const CANVAS = '#f2e8cc'
const scene = (ox, oy, px) => {
  const cells = new Map()
  const cell = (x, y, color) => cells.set(`${x},${y}`, color)
  const fill = (x1, y1, x2, y2, color) => {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) cell(x, y, color)
  }
  const diag = (x1, y1, x2, y2, w, color) => {
    const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / n)
      const y = Math.round(y1 + ((y2 - y1) * i) / n)
      fill(x, y, x + w - 1, y, color)
    }
  }
  // chair: X legs, seat, arms, posts, canvas back (shifted right to leave room for the clapperboard)
  const chairFill = (x1, y1, x2, y2, color) => fill(x1 + 7, y1, x2 + 7, y2, color)
  diag(15, 19, 35, 41, 3, WOOD_D)
  diag(35, 19, 15, 41, 3, WOOD)
  chairFill(7, 16, 29, 18, WOOD) // seat frame
  chairFill(8, 16, 28, 17, CANVAS) // seat canvas
  chairFill(3, 11, 12, 12, WOOD) // left arm
  chairFill(24, 11, 33, 12, WOOD) // right arm
  chairFill(5, 13, 6, 18, WOOD)
  chairFill(30, 13, 31, 18, WOOD)
  chairFill(8, 0, 9, 15, WOOD) // back posts
  chairFill(27, 0, 28, 15, WOOD)
  chairFill(10, 1, 26, 8, CANVAS) // back canvas
  chairFill(10, 1, 26, 1, '#fff7de')
  chairFill(10, 9, 26, 9, WOOD_D)
  // clapperboard (front, left)
  fill(1, 31, 16, 42, '#101510')
  fill(1, 31, 16, 31, '#f2f2f2')
  fill(1, 42, 16, 42, '#f2f2f2')
  fill(1, 31, 1, 42, '#f2f2f2')
  fill(16, 31, 16, 42, '#f2f2f2')
  for (let i = 0; i < 4; i++) fill(3 + i * 3, 34, 4 + i * 3, 34, '#f2f2f2')
  fill(3, 37, 14, 37, cyan)
  fill(3, 39, 9, 39, '#f2f2f2')
  // the clapper stick on top: tilted, with diagonal stripes
  for (let x = 1; x <= 16; x++) {
    const y = 28 - Math.floor((x - 1) / 4)
    fill(x, y, x, y + 2, Math.floor((x - 1) / 2) % 2 ? '#101510' : '#f2f2f2')
  }
  // megaphone (front, right): a cone opening to the right, a handle and a light
  for (let x = 24; x <= 34; x++) {
    const h = 1 + Math.floor((x - 24) * 0.45)
    fill(x, 37 - h, x, 37 + h, x === 34 ? '#f2f2f2' : pink)
  }
  fill(26, 40, 27, 43, '#c43b7a')
  fill(26, 31, 29, 33, '#ffd24a')
  fill(27, 30, 28, 30, '#f2f2f2')
  // Resolve overlaps on the grid first, then emit one compact path per colour.
  const paths = new Map();
  cells.forEach((color, key) => {
    const [x, y] = key.split(',').map(Number);
    if (!paths.has(color)) paths.set(color, []);
    paths.get(color).push(`M${x} ${y}h1v1h-1z`);
  });
  add(`<g transform="translate(${ox} ${oy}) scale(${px})" shape-rendering="crispEdges">`);
  paths.forEach((parts, color) => add(`<path fill="${color}" d="${parts.join('')}"/>`));
  add('</g>');
};
scene(64, 124, 7);
text(96, 486, 'DIRECTOR', 28, pink);
const features = [
  ['Director orchestrates the work', green],
  ['Actors by model + reasoning effort', cyan],
  ['Automatic quota: Claude, Codex, opencode*', green],
  ['Smoke checks in your own client', pink],
  ['Update + uninstall: no extra tool', cyan],
];
features.forEach(([label, color], i) => text(434, 310 + i * 48, `> ${label}`, 26, color));
text(48, 590, '* Claude: status bar; Codex: sessions; opencode: configured sources.', 20, cyan);
text(48, 632, 'Claude Code  /  Codex  /  opencode', 22);
text(870, 632, 'Node.js · JSON · MCP', 22, pink);
add('</g></svg>');
writeFileSync(fileURLToPath(new URL('./banner.svg', import.meta.url)), out.join('\n') + '\n');
