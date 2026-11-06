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
    const attrs = `data-path="${e(field.path)}" data-type="${e(field.type)}"`;
    if (field.value === '[Redacted]') return `<input ${attrs} value="[Redacted]" readonly>`;
    if (field.allowedValues) return select(field.allowedValues.map(value => ({ value, label: value })), field.value, attrs);
    const type = field.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(field.type) ? 'number' : 'text';
    const value = field.value == null ? '' : typeof field.value === 'object' ? JSON.stringify(field.value) : field.value;
    return `<input ${attrs} type="${type}" ${type === 'checkbox' ? (field.value ? 'checked' : '') : `value="${e(value)}"`}>`;
  };
  const groups = [...new Set(state.fields.map(field => field.path.split('.')[0]))];
  const settings = groups.map(group => `<details><summary>${e(group)}</summary>${state.fields.filter(field => field.path.split('.')[0] === group).map(field =>
    `<div class="field"><label>${e(field.path)} ${fieldControl(field)}</label><p>${e(field.description)} ${e(field.constraint)}</p><small>${e(text.defaultValue)}: ${e(JSON.stringify(field.default))}</small> ${field.value === '[Redacted]' ? '' : button('reset', text.reset, `data-reset="${e(field.path)}"`)}</div>`).join('')}</details>`).join('');
  const clients = [...new Set(state.actors.map(actor => actor.client))];
  const actors = clients.map(client => `<section><h3>${e(client)}</h3>${button('refresh', text.refresh, `data-client="${e(client)}"`)}${state.actors.filter(actor => actor.client === client).map(actor => {
    const account = state.accounts.find(account => account.client === client && account.id === actor.account);
    const heading = account ? `<h4><input data-account="${e(account.id)}" data-client="${e(client)}" value="${e(account.label)}" aria-label="${e(text.saveLabel)}">${button('label', text.saveLabel, `data-client="${e(client)}" data-account="${e(account.id)}"`)}</h4>` : '';
    const rows = actor.classes.map(row => `<tr data-row="${e(row.path)}"><th>${e(row.class)}</th><td><input type="checkbox" data-actor="${e(row.path)}"${row.enabled ? ' checked' : ''} aria-label="${e(text.enabled)}"></td>${['model', 'effort', 'maxTurns'].map(key => {
      const attrs = `data-actor-path="${e(row.path)}.${key}" data-type="${key === 'maxTurns' ? 'integer' : 'string'}" aria-label="${e(text[key])}"`;
      if (key === 'maxTurns') return `<td><input type="number" min="1" ${attrs} value="${e(row[key])}"></td>`;
      const choices = key === 'model' ? row.modelChoices.map(choice => ({ value: choice.model, label: choice.confirmed ? choice.model : `${choice.model} (${text.unconfirmed})` })) : row.efforts.map(value => ({ value, label: value }));
      if (!choices.some(choice => choice.value === row[key])) choices.unshift({ value: row[key] ?? '', label: row[key] ?? '' });
      return `<td>${select(choices, row[key] ?? '', attrs)}</td>`;
    }).join('')}<td title="${e(row.reasons.join(', '))}">${e(row.launchableNow ? text.yes : text.no)}</td></tr>`).join('');
    return `${heading}<p>${e(actor.reason)}</p><table><thead><tr><th></th>${['enabled', 'model', 'effort', 'maxTurns', 'launchable'].map(key => `<th>${e(text[key])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('')}</section>`).join('');
  function renderDocument() {
    return `<!doctype html><html lang="${e(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(text.title)}</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px;color:#182333;background:#f4f6fa}header,section,details{margin-bottom:1.5rem}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{padding:.5rem;border:1px solid #bbc5d3;text-align:left}input,select,button{font:inherit;max-width:100%;padding:.3rem}button{cursor:pointer;margin:.3rem}input[type=number]{width:6rem}.field{padding:1rem;border-bottom:1px solid #bbc5d3}p{margin:.5rem 0}#error{color:#a01818}pre{white-space:pre-wrap}</style></head><body><header><h1>${e(text.title)}</h1><nav>${['en', 'pt-BR'].map(lang => `<a href="?token=${e(encodeURIComponent(token))}&amp;locale=${lang}">${lang}</a>`).join(' · ')}</nav><p>${e(state.readiness)}</p>${button('close', text.close)}</header><main><h2>${e(text.actors)}</h2>${actors}<h2>${e(text.settings)}</h2>${settings}<p id="error" role="alert"></p>${button('review', text.save)}<section id="review" hidden><pre id="changes"></pre>${button('apply', text.apply)}${button('cancel', text.cancel)}</section>${button('reload', text.reload, 'id="reload" hidden')}</main><script type="application/json" id="state" nonce="${e(nonce)}">${json({ ...state, labels: text, locale })}</script><script nonce="${e(nonce)}">${clientSource()}</script></body></html>`;
  }
  return renderDocument();
}
