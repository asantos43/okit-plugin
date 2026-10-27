#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('../docs/images/banners/', import.meta.url));
const icons = {
  terminal: '<rect x="2" y="4" width="60" height="48" rx="4"/><path d="m12 18 10 10-10 10m20 0h16"/>',
  book: '<path d="M32 14Q16 4 4 10v44q14-6 28 4 14-10 28-4V10q-12-6-28 4v44M12 22l12 3m-12 9 12 3m16-12 12-3m-12 15 12-3"/>',
  blocks: '<rect x="3" y="3" width="22" height="22" rx="3"/><rect x="37" y="3" width="22" height="22" rx="3"/><rect x="20" y="37" width="22" height="22" rx="3"/><path d="M14 25v8h34v-8M31 33v4"/>',
  tools: '<path d="m8 8 46 46m0-46L8 54M4 4l14 4-10 10Zm42 42 12 12M46 8l10-4 4 10-10 10-14-14Z"/>',
};
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function renderBanner(config, area) {
  if (!icons[area.icon]) throw new Error(`Unknown icon: ${area.icon}`);
  const palette = mode => Object.entries(config.colours[mode])
    .map(([token, value]) => `--${token}:${value}`).join(';');
  const label = `${config.project}: ${area.title.en} / ${area.title['pt-BR']}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="180" viewBox="0 0 960 180" role="img" aria-labelledby="title">
<title id="title">${escape(label)}</title>
<style>:root{${palette('light')}}@media(prefers-color-scheme:dark){:root{${palette('dark')}}}.panel{fill:var(--background);stroke:var(--accent)}.icon{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}text{font-family:ui-monospace,monospace;fill:var(--foreground)}.area{fill:var(--secondary)}</style>
<rect class="panel" x="1" y="1" width="958" height="178" rx="12"/>
<g class="icon" transform="translate(34 72)">${icons[area.icon]}</g>
<path d="M26 36h908" stroke="var(--accent)" stroke-dasharray="4 6"/>
<g fill="var(--accent)"><circle cx="34" cy="21" r="3"/><circle cx="48" cy="21" r="3"/><circle cx="62" cy="21" r="3"/></g>
<text x="128" y="87" font-size="36">${escape(config.project)}</text>
<text class="area" x="128" y="122" font-size="24">${escape(area.title.en)} / ${escape(area.title['pt-BR'])}</text>
</svg>\n`;
}

export async function generateBanners(output = directory, check = false) {
  const config = JSON.parse(await readFile(resolve(output, 'banners.config.json'), 'utf8'));
  for (const area of config.areas) {
    if (!/^[a-z][a-z-]*$/.test(area.id)) throw new Error(`Invalid area id: ${area.id}`);
    const file = resolve(output, `${area.id}.svg`);
    const expected = renderBanner(config, area);
    if (check) {
      const actual = await readFile(file, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (actual !== expected) throw new Error(`Banner differs: ${file}; run node scripts/docs-banners.js`);
    } else await writeFile(file, expected);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/docs-banners.js [--check]');
    await generateBanners(directory, process.argv.includes('--check'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
