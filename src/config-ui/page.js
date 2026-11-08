import { labels } from './labels.js';
import { clientSource } from './client.js';
import { ACCOUNT_CLIENTS } from '../accounts.js';

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
  const tabs = Object.entries({ actors: '', accounts: '', limits: 'limits lowQuotaPct daemon smoke accountPolicy codexQuota',
    language: 'language', profiles: 'profiles', telemetry: 'telemetry', todo: 'todo' })
    .map(([id, names]) => [id, names ? names.split(' ') : []]);
  const other = groups.filter(group => !tabs.some(([, names]) => names.includes(group)));
  if (other.length) tabs.push(['other', other]);
  const fieldsHtml = fields => fields.map(field =>
    `<div class="field"><div><label for="field-${e(field.path)}">${e(field.path)}</label><p>${e(field.description)} ${e(field.constraint)}</p><small>${e(text.defaultValue)}: ${e(JSON.stringify(field.default))}</small></div><div class="field-control">${fieldControl(field)} ${field.value === '[Redacted]' ? '' : button('reset', text.reset, `data-reset="${e(field.path)}"`)}</div></div>`).join('');
  const section = (path, fields, content, sub = false, first = false) => {
    const title = text.groupTitles?.[path] ?? path.split('.').at(-1);
    const open = (!sub && first && fields.length <= 4)
      || fields.some(field => JSON.stringify(field.value) !== JSON.stringify(field.default));
    return `<details class="section${sub ? ' sub' : ''}" data-section="${e(path)}"${open ? ' open' : ''}><summary>${e(title)} <span class="count">(${fields.length})</span></summary>${content}</details>`;
  };
  const settings = names => {
    const present = names.filter(group => groups.includes(group));
    return present.map((group, index) => {
      const fields = state.fields.filter(field => field.path.split('.')[0] === group);
      const candidates = [...new Set(fields.map(field => field.path.split('.')[1]).filter(Boolean))];
      const subsections = fields.length > 4 ? candidates.filter(segment => {
        const children = fields.filter(field => field.path.split('.')[1] === segment);
        return children.length >= 4 || children.some(field => field.type === 'object');
      }) : [];
      const content = fieldsHtml(fields.filter(field => !subsections.includes(field.path.split('.')[1])))
        + subsections.map(segment => {
          const children = fields.filter(field => field.path.split('.')[1] === segment);
          return section(`${group}.${segment}`, children, fieldsHtml(children), true);
        }).join('');
      return present.length === 1 ? content : section(group, fields, content, false, index === 0);
    }).join('');
  };
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
  const accountRows = client => state.accounts.filter(account => account.client === client).map(account => {
    const attrs = `data-client="${e(client)}" data-account-id="${e(account.id)}"`;
    const login = account.login === 'logged-in' ? ['ready', 'loggedIn']
      : account.login === 'logged-out' ? ['waiting', 'notLoggedIn'] : ['unknown', 'loginUnknown'];
    return `<tr ${attrs}><td data-label="${e(text.accountLabel)}"><input data-rename-account ${attrs} value="${e(account.label)}" aria-label="${e(text.accountLabel)}">${button('account-rename', text.saveLabel, attrs)}</td>
      <td class="account-id" data-label="${e(text.accountId)}">${e(account.id)}</td><td data-label="${e(text.accountFolder)}">${e(account.configDir === null ? text.clientDefault : account.configDir)}</td>
      <td data-label="${e(text.accountLogin)}"><span class="badge ${login[0]}" title="${e(text[`${login[1]}Title`])}">${e(text[login[1]])}</span></td>
      <td data-label="${e(text.accountActions)}"><p data-account-collector>${e([account.collector?.text, account.collector?.detail, account.collector?.reason].filter(Boolean).join(': '))}</p>${button('account-login', text.accountLoginCommand, `${attrs}${account.login === 'logged-in' ? '' : ' hidden'}`)}${account.id === 'default' ? '' : button('account-remove', text.accountRemove, `${attrs} data-account-remove-open`)}
      ${account.id === 'default' ? '' : `<div data-account-remove-confirm hidden>${button('account-remove', text.accountConfirmRemove, `${attrs} data-confirm="true"`)}${button('account-remove', text.cancel, `${attrs} data-cancel="true"`)}<small class="account-note">${e(text.accountRemoveNote)}</small></div>`}
      <div class="account-login-help" data-account-login-help${account.login === 'logged-in' ? ' hidden' : ''}><p>${e(text.accountLoginHelp)}</p><pre><code>${e(account.loginCommand)}</code></pre><p>${e(text.accountTerminalHint)}</p>${button('account-terminal', text.accountTerminal, attrs)}${button('account-copy', text.accountCopy, attrs)}${button('account-check', text.accountCheck, attrs)}</div></td></tr>`;
  }).join('');
  const accounts = ACCOUNT_CLIENTS.map(client => `<section class="actor-card account-card" data-account-client="${e(client)}"><h3>${e(client)}</h3>
    <div class="table-scroll"><table><thead><tr>${['accountLabel', 'accountId', 'accountFolder', 'accountLogin', 'accountActions'].map(key => `<th scope="col">${e(text[key])}</th>`).join('')}</tr></thead><tbody>${accountRows(client)}</tbody></table></div>
    <form class="account-add" data-account-add data-client="${e(client)}"><label>${e(text.accountLabel)}<input name="label" placeholder="${e(text.accountLabelPlaceholder)}" maxlength="40" required></label>
    <label>${e(text.accountFolder)}<input name="configDir" placeholder="${e(text[client === 'codex' ? 'accountFolderPlaceholderCodex' : 'accountFolderPlaceholderClaude'])}" aria-describedby="folder-note-${e(client)}" required><small class="account-note" id="folder-note-${e(client)}">${e(text.accountFolderSuggestion)}</small></label>${button('account-add', text.accountAdd, `data-client="${e(client)}"`)}</form>
    <p>${e(text.accountRemoveNote)}</p></section>`).join('');
  const tabBar = `<div class="tabs" role="tablist" aria-label="${e(text.settings)}">${tabs.map(([id], index) =>
    `<button type="button" role="tab" id="tab-${e(id)}" data-tab="${e(id)}" aria-controls="panel-${e(id)}" aria-selected="${index === 0}" tabindex="${index === 0 ? '0' : '-1'}">${e(text[`tab${id}`])}</button>`).join('')}</div>`;
  const panels = tabs.map(([id, names]) => `<section class="panel" role="tabpanel" id="panel-${e(id)}" aria-labelledby="tab-${e(id)}"${id === 'accounts' ? ' hidden' : ''}>${id === 'actors' ? actors : id === 'accounts' ? accounts : settings(names)}</section>`).join('');
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
    .panel,#review{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.25rem;margin-bottom:1rem}.actor-card{overflow-x:auto;margin-bottom:1.5rem}.actor-card:last-child{margin-bottom:0}
    .section{border:1px solid var(--border);border-radius:.75rem;padding:.5rem .75rem;margin:.75rem 0;min-width:0;max-width:100%}.section.sub{margin-left:.5rem}.section>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:.5rem;padding:.5rem;border-radius:.5rem;overflow-wrap:anywhere}.section>summary::-webkit-details-marker{display:none}.section>summary::before{content:"";width:.45rem;height:.45rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);flex-shrink:0}.section[open]>summary::before{transform:rotate(45deg)}.section>summary:hover{background:var(--soft)}.section>summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.count{color:var(--muted);background:var(--soft);border-radius:1rem;padding:0 .4rem;font-size:.85rem}.section>summary.has-edits::after{flex-shrink:0}
    .actor-card{padding:1rem;border:1px solid var(--border);border-radius:.75rem;max-width:100%;min-width:0}.table-scroll{max-width:100%;overflow-x:auto}.table-scroll select{max-width:100%;min-width:0}main>*,.panel>*{min-width:0;max-width:100%}
    .field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem;padding:1rem 0;border-bottom:1px solid var(--border)}label{font-weight:600;overflow-wrap:anywhere}small{color:var(--muted)}.field-control{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
    table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.65rem;border-bottom:1px solid var(--border)}tbody tr:nth-child(odd){background:var(--soft)}.badge{display:inline-block;border-radius:2rem;padding:.2rem .65rem;font-size:.85rem;white-space:nowrap}.ready{color:var(--green);background:var(--green-bg)}.waiting{color:var(--amber);background:var(--amber-bg)}
    .action-bar{position:sticky;bottom:0;z-index:2;background:var(--card);border:1px solid var(--border);border-radius:1rem 1rem 0 0;padding:1rem;display:flex;align-items:center;gap:1rem}#error{color:var(--error);flex:1}.status{color:var(--muted);flex:1;min-width:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}#review button+button{margin-left:.5rem}
    .unknown{color:var(--muted);background:var(--bg)}.account-card td{overflow-wrap:anywhere}.account-card td button{margin:.2rem}.account-login-help{min-width:12rem;max-width:24rem}.account-add{display:flex;flex-wrap:wrap;align-items:end;gap:.75rem}.account-add label{flex:1 1 14rem;min-width:0}.account-add input{display:block;width:100%}
    .account-card td.account-id{overflow-wrap:normal;word-break:normal;white-space:nowrap}.account-note{display:block}
    button[data-action=account-terminal]{background:var(--accent);color:var(--card);border-color:var(--accent)}
    @media(max-width:699px){
      .account-card,.account-card .table-scroll{overflow-x:visible}
      .account-card table,.account-card tbody,.account-card tr,.account-card td{display:block;width:100%;min-width:0}
      .account-card thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}
      .account-card tr{border:1px solid var(--border);border-radius:.5rem;margin-bottom:1rem}
      .account-card td::before{content:attr(data-label);display:block;font-weight:bold}
      .account-card input[data-rename-account]{width:100%;min-width:0}
      .account-card td button{white-space:normal;overflow-wrap:anywhere}
      .account-login-help{min-width:0;max-width:100%}
    }
    header .badge{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;border-radius:1rem}#error{min-width:0;overflow-wrap:anywhere}
    [hidden]{display:none!important}@media(max-width:700px){.field{grid-template-columns:1fr;gap:.75rem}header{gap:.5rem}.panel{padding:.75rem}header .badge{order:4;width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere}.action-bar{flex-wrap:wrap}.field>*{min-width:0}.field-control input[type=text],.field-control select{flex:1 1 8rem;min-width:0}}
  `;
  function renderDocument() {
    return `<!doctype html><html lang="${e(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(text.title)}</title><style nonce="${e(nonce)}">${css}</style></head><body><header><h1>${e(text.title)}</h1><p class="badge ${launchable ? 'ready' : 'waiting'}">${e(state.readiness)}</p><nav>${['en', 'pt-BR'].map(lang => `<a href="?token=${e(encodeURIComponent(token))}&amp;locale=${lang}">${lang}</a>`).join(' · ')}</nav>${button('close', text.close)}</header><main>${tabBar}${panels}<section id="review" tabindex="-1" hidden><pre id="changes"></pre>${button('apply', text.apply)}${button('cancel', text.cancel)}</section></main><footer class="action-bar"><p id="error" role="alert"></p><p id="status" role="status" aria-live="polite" class="status"></p>${button('review', text.save)}${button('reload', text.reload, 'id="reload" hidden')}</footer><script type="application/json" id="state" nonce="${e(nonce)}">${json({ ...state, labels: text, locale })}</script><script nonce="${e(nonce)}">${clientSource()}</script></body></html>`;
  }
  return renderDocument();
}
