import { labels } from './labels.js';
import { clientSource } from './client.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function renderPage(state, { locale = 'en', nonce, token, instance }) {
  state = { ...state, instance };
  const text = labels[locale] ?? labels.en;
  const e = escape;
  const button = (action, label, attrs = '') => `<button type="button" data-action="${action}" ${attrs}>${e(label)}</button>`;
  const options = (values, current) => values.map(({ value, label }) =>
    `<option value="${e(value)}"${value === current ? ' selected' : ''}>${e(label)}</option>`).join('');
  const select = (values, current, attrs) => `<select ${attrs}>${options(values, current)}</select>`;
  const fieldControl = (field) => {
    const attrs = `id="field-${e(field.path)}" data-path="${e(field.path)}" data-type="${e(field.type)}"`;
    if (field.value === '[Redacted]') return `<input ${attrs} value="[Redacted]" readonly>`;
    if (field.allowedValues) return select(field.allowedValues.map(value => ({ value, label: value })), field.value, attrs);
    const type = field.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(field.type) ? 'number' : 'text';
    const value = field.value == null ? '' : typeof field.value === 'object' ? JSON.stringify(field.value) : field.value;
    return `<input ${attrs} type="${type}" ${type === 'checkbox' ? (field.value ? 'checked' : '') : `value="${e(value)}"`}>`;
  };
  const groups = [...new Set(state.fields.map(field => field.path.split('.')[0]))];
  const tabs = Object.entries({ actors: '', limits: 'limits lowQuotaPct daemon smoke accountPolicy codexQuota',
    language: 'language', profiles: 'profiles', telemetry: 'telemetry', todo: 'todo' })
    .map(([id, names]) => [id, names ? names.split(' ') : []]);
  const other = groups.filter(group => !tabs.some(([, names]) => names.includes(group)));
  if (other.length) tabs.push(['other', other]);
  const settings = names => names.filter(group => groups.includes(group)).map(group => `<section class="settings-group"><h3>${e(group)}</h3>${state.fields.filter(field => field.path.split('.')[0] === group).map(field =>
    `<div class="field"><div><label for="field-${e(field.path)}">${e(field.path)}</label><p>${e(field.description)} ${e(field.constraint)}</p><small>${e(text.defaultValue)}: ${e(JSON.stringify(field.default))}</small></div><div class="field-control">${fieldControl(field)} ${field.value === '[Redacted]' ? '' : button('reset', text.reset, `data-reset="${e(field.path)}"`)}</div></div>`).join('')}</section>`).join('');
  const clients = [...new Set(state.actors.map(actor => actor.client))];
  const actors = clients.map(client => `<section class="actor-card"><h3>${e(client)}</h3>${button('refresh', text.refresh, `data-client="${e(client)}"`)}${state.actors.filter(actor => actor.client === client).map(actor => {
    const account = state.accounts.find(account => account.client === client && account.id === actor.account);
    const heading = account ? `<h4><input data-account="${e(account.id)}" data-client="${e(client)}" value="${e(account.label)}" aria-label="${e(text.saveLabel)}">${button('label', text.saveLabel, `data-client="${e(client)}" data-account="${e(account.id)}"`)}</h4>` : '';
    const rows = actor.classes.map(row => `<tr data-row="${e(row.path)}"><th>${e(row.class)}</th><td><input type="checkbox" data-actor="${e(row.path)}"${row.enabled ? ' checked' : ''} aria-label="${e(text.enabled)}"></td>${['model', 'effort', 'maxTurns'].map(key => {
      const attrs = `data-actor-path="${e(row.path)}.${key}" data-type="${key === 'maxTurns' ? 'integer' : 'string'}" aria-label="${e(text[key])}"`;
      if (key === 'maxTurns') return `<td><input type="number" min="1" ${attrs} value="${e(row[key])}"></td>`;
      const choices = key === 'model' ? row.modelChoices.map(choice => ({ value: choice.model, label: choice.confirmed ? choice.model : `${choice.model} (${text.unconfirmed})` })) : row.efforts.map(value => ({ value, label: value }));
      if (!choices.some(choice => choice.value === row[key])) choices.unshift({ value: row[key] ?? '', label: row[key] ?? '' });
      return `<td>${select(choices, row[key] ?? '', attrs)}</td>`;
    }).join('')}<td title="${e(row.reasons.join(', '))}"><span class="badge ${row.launchableNow ? 'ready' : 'waiting'}">${e(row.launchableNow ? text.yes : text.no)}</span></td></tr>`).join('');
    return `${heading}<p>${e(actor.reason)}</p><div class="table-scroll"><table><thead><tr><th></th>${['enabled', 'model', 'effort', 'maxTurns', 'launchable'].map(key => `<th>${e(text[key])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('')}</section>`).join('');
  const tabBar = `<div class="tabs" role="tablist" aria-label="${e(text.settings)}">${tabs.map(([id], index) =>
    `<button type="button" role="tab" id="tab-${e(id)}" data-tab="${e(id)}" aria-controls="panel-${e(id)}" aria-selected="${index === 0}" tabindex="${index === 0 ? '0' : '-1'}">${e(text[`tab${id}`])}</button>`).join('')}</div>`;
  const panels = tabs.map(([id, names]) => `<section class="panel" role="tabpanel" id="panel-${e(id)}" aria-labelledby="tab-${e(id)}">${id === 'actors' ? actors : settings(names)}</section>`).join('');
  const launchable = ['simple', 'normal', 'hard'].every(name =>
    state.actors.some(actor => actor.classes.some(row => row.class === name && row.launchableNow)));
  const css = `
    :root{color-scheme:light;--bg:#f4f6fb;--card:#fff;--ink:#1c2940;--muted:#59677d;--border:#dce2ec;--accent:#315ad6;--soft:#edf1fa;--green:#176344;--green-bg:#e2f5eb;--amber:#825716;--amber-bg:#fff1d7;--error:#ad2835}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111827;--card:#1b2536;--ink:#e7edf8;--muted:#acbad0;--border:#36445a;--accent:#9bb5ff;--soft:#27344b;--green:#9ce2bb;--green-bg:#203f33;--amber:#f4ce88;--amber-bg:#463920;--error:#ffabb3}}
    *{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink)}
    header,main,.action-bar{max-width:1100px;margin:auto}header{position:sticky;top:0;z-index:2;background:var(--bg);padding:1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;border-bottom:1px solid var(--border)}
    h1{font-size:1.5rem;margin:0 auto 0 0}h3{font-size:1rem}h4{margin:.75rem 0}p{margin:.4rem 0;color:var(--muted)}nav{display:flex;gap:.75rem}a{color:var(--accent)}main{padding:1rem}
    button,input,select{font:inherit;border:1px solid var(--border);border-radius:.5rem;padding:.5rem .75rem;background:var(--card);color:var(--ink);max-width:100%}button{cursor:pointer}button:hover{background:var(--soft)}button[data-action=review],button[data-action=apply]{background:var(--accent);color:var(--card);border-color:var(--accent)}
    :focus-visible{outline:3px solid var(--accent);outline-offset:3px}input[type=number]{width:7rem}input[type=checkbox]{accent-color:var(--accent)}
    .tabs{display:flex;flex-wrap:nowrap;gap:.35rem;overflow-x:auto;max-width:100%;min-width:0;padding:.5rem 0 1rem;scroll-snap-type:x proximity;scrollbar-width:thin}.tabs button{flex:0 0 auto;white-space:nowrap;border-radius:2rem;scroll-snap-align:start}.tabs [aria-selected=true]{background:var(--soft);border-color:var(--accent);color:var(--accent)}
    .has-edits::after{content:"";display:inline-block;width:.45rem;height:.45rem;border-radius:50%;background:var(--accent);margin-left:.5rem;vertical-align:middle}
    .panel,#review{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.25rem;margin-bottom:1rem}.actor-card{overflow-x:auto;margin-bottom:1.5rem}.actor-card:last-child{margin-bottom:0}.settings-group+ .settings-group{border-top:1px solid var(--border);margin-top:1.5rem}
    .actor-card{padding:1rem;border:1px solid var(--border);border-radius:.75rem;max-width:100%;min-width:0}.table-scroll{max-width:100%;overflow-x:auto}.table-scroll select{max-width:100%;min-width:0}main>*,.panel>*{min-width:0;max-width:100%}
    .field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem;padding:1rem 0;border-bottom:1px solid var(--border)}label{font-weight:600;overflow-wrap:anywhere}small{color:var(--muted)}.field-control{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
    table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.65rem;border-bottom:1px solid var(--border)}tbody tr:nth-child(odd){background:var(--soft)}.badge{display:inline-block;border-radius:2rem;padding:.2rem .65rem;font-size:.85rem;white-space:nowrap}.ready{color:var(--green);background:var(--green-bg)}.waiting{color:var(--amber);background:var(--amber-bg)}
    .action-bar{position:sticky;bottom:0;z-index:2;background:var(--card);border:1px solid var(--border);border-radius:1rem 1rem 0 0;padding:1rem;display:flex;align-items:center;gap:1rem}#error{color:var(--error);flex:1}pre{white-space:pre-wrap;overflow-wrap:anywhere}#review button+button{margin-left:.5rem}
    header .badge{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;border-radius:1rem}#error{min-width:0;overflow-wrap:anywhere}
    [hidden]{display:none!important}@media(max-width:700px){.field{grid-template-columns:1fr;gap:.75rem}header{gap:.5rem}.panel{padding:.75rem}header .badge{order:4;width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere}.action-bar{flex-wrap:wrap}.field>*{min-width:0}.field-control input[type=text],.field-control select{flex:1 1 8rem;min-width:0}}
  `;
  function renderDocument() {
    return `<!doctype html><html lang="${e(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(text.title)}</title><style nonce="${e(nonce)}">${css}</style></head><body><header><h1>${e(text.title)}</h1><p class="badge ${launchable ? 'ready' : 'waiting'}">${e(state.readiness)}</p><nav>${['en', 'pt-BR'].map(lang => `<a href="?token=${e(encodeURIComponent(token))}&amp;locale=${lang}">${lang}</a>`).join(' · ')}</nav>${button('close', text.close)}</header><main>${tabBar}${panels}<section id="review" tabindex="-1" hidden><pre id="changes"></pre>${button('apply', text.apply)}${button('cancel', text.cancel)}</section></main><footer class="action-bar"><p id="error" role="alert"></p>${button('review', text.save)}${button('reload', text.reload, 'id="reload" hidden')}</footer><script type="application/json" id="state" nonce="${e(nonce)}">${json({ ...state, labels: text, locale })}</script><script nonce="${e(nonce)}">${clientSource()}</script></body></html>`;
  }
  return renderDocument();
}
