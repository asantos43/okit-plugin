import { renderPage } from './page.js';
import { labels } from './labels.js';
import { wizardSource } from './wizard-client.js';
import { TEXTS } from '../install/present.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Reuse the normal document's controls/CSP. Only server-owned markup is composed. */
export function renderWizardPage(state, options) {
  const text = labels[options.locale] ?? labels.en;
  const e = escape;
  const wizard = `<section id="wizard" aria-labelledby="wizard-heading">
    <h2 id="wizard-heading" tabindex="-1"></h2><p id="wizard-status" aria-live="polite"></p>
    <p id="wizard-error" role="alert" tabindex="-1"></p>
    <div id="wizard-existing"></div><div id="wizard-choices"></div><div id="wizard-body"></div>
    <div id="wizard-boundaries"></div><div id="wizard-preview"></div>
    <details id="wizard-technical" hidden><summary>${e(text.wizard.technical)}</summary><pre id="wizard-events"></pre></details>
    <div id="wizard-question"></div>
    <label id="wizard-consent-label" hidden><input id="wizard-consent" type="checkbox">${e(text.wizard.consent)}</label>
    <label id="wizard-unknown-label" hidden><input id="wizard-unknown" type="checkbox">${e(text.wizard.unknown)}</label>
    <div id="wizard-actions"></div></section>`;
  const dialog = `<dialog id="wizard-write"><h2>${e(text.wizard.accountPreview)}</h2><pre></pre>
    <button type="button" data-write="yes">${e(text.wizard.confirm)}</button>
    <button type="button" data-write="no">${e(text.wizard.cancelPreview)}</button></dialog>`;
  const locale = `<label>${e(text.tablanguage)} <select id="wizard-locale">${['en', 'pt-BR'].map((lang) =>
    `<option${lang === options.locale ? ' selected' : ''}>${lang}</option>`).join('')}</select></label>`;
  return renderPage(state, { ...options, client: wizardSource(),
    extraState: { wizard: options.wizard, catalogs: labels,
      installLabels: Object.fromEntries(['en', 'pt-BR'].map((lang) => [lang,
        Object.fromEntries(Object.entries(TEXTS).map(([key, value]) => [key, value[lang] ?? value.en]))])) } })
    .replace('<html ', '<html data-first-run="true" ')
    .replace(/<nav>[\s\S]*?<\/nav>/, locale)
    .replace('<main>', `<main>${wizard}<div id="configuration" hidden>`)
    .replace('</main>', `</div></main>${dialog}`)
    .replace('<footer class="action-bar">', '<footer class="action-bar" id="config-footer" hidden>')
    .replace('</style>', `
      #wizard{background:var(--card);padding:1.25rem;border:1px solid var(--border);border-radius:1rem}
      #wizard-actions{display:flex;gap:.75rem;flex-wrap:wrap}#wizard label{display:block;margin:.6rem 0}
      #wizard-error{color:var(--error)}dialog{max-width:90vw}dialog::backdrop{background:#0008}
      [data-first-run] pre{max-height:28rem;overflow:auto}
      html:not([data-screen=config]) header h1,html:not([data-screen=config]) header .badge,html:not([data-screen=config]) header [data-action=close]{display:none}
      .wizard-state-ok{color:var(--green)}.wizard-state-bad{color:var(--error)}.wizard-note,.wizard-reason{color:var(--muted)}
      .wizard-client{border:1px solid var(--border);border-radius:.75rem;padding:.5rem 1rem;margin:.75rem 0}
      .wizard-checklist,.wizard-stages{list-style:none;padding:0}.wizard-checklist li{margin:.6rem 0;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
      .wizard-details,.wizard-options{margin:.75rem 0} @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
    </style>`);
}
