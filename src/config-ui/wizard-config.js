/** Reuse config client controls/routes with in-memory auth and reviewed account actions. */
export function wizardConfig(win, token, startConfig, confirm, locale, onRefresh) {
  const doc = win.document;
  let listeners = [], currentLocale = locale, refreshing = null;
  const listen = (target) => (name, handler, options) => {
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  };
  const view = new Proxy(win, { get(target, key) {
    if (key === 'addEventListener') return listen(win);
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const document = new Proxy(doc, { get(target, key) {
    if (key === 'addEventListener') return listen(doc);
    if (key === 'defaultView') return view;
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const facade = new Proxy(win, { get(target, key) {
    if (key === 'document') return document;
    if (key === 'location') return { search: `?token=${encodeURIComponent(token)}`, hash: win.location.hash,
      reload: () => refresh(false) };
    if (key === 'fetch') return async (path, options) => {
      if (/^\/api\/account-(?:add|remove|label|logout|login)$/.test(path)
        && !await confirm({ route: path, ...JSON.parse(options.body) })) {
        return { status: 409, json: async () => ({ reason: '' }) };
      }
      return win.fetch(path, options);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  async function refresh(preserve = true, chosenLocale = currentLocale) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const controls = [...doc.querySelectorAll('#configuration input, #configuration select')];
      const identity = (control) => control.dataset.actorPath ?? control.dataset.path ?? control.dataset.actor
        ?? (control.dataset.renameAccount !== undefined ? `rename:${control.closest('tr').dataset.client}:${control.closest('tr').dataset.accountId}`
          : control.name ? `account:${control.closest('[data-account-add]')?.dataset.client}:${control.name}` : null);
      const drafts = preserve ? controls.map((control) => ({ path: identity(control),
        value: control.value, checked: control.checked })).filter((item) => item.path) : [];
      const response = await win.fetch(`/?locale=${encodeURIComponent(chosenLocale)}`, { headers: {
        'x-okit-token': token, 'x-okit-instance': JSON.parse(doc.getElementById('state').textContent).instance } });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = new win.DOMParser().parseFromString(await response.text(), 'text/html');
      const nextState = JSON.parse(parsed.getElementById('state').textContent);
      const previous = JSON.parse(doc.getElementById('state').textContent);
      // Keep the original page instance: refreshing controls does not claim another tab.
      nextState.instance = previous.instance;
      doc.getElementById('state').textContent = JSON.stringify(nextState);
      listeners.forEach((remove) => remove()); listeners = [];
      doc.getElementById('configuration').replaceWith(parsed.getElementById('configuration'));
      currentLocale = chosenLocale; startConfig(facade);
      for (const draft of drafts) for (const control of doc.querySelectorAll('#configuration input, #configuration select')) {
        if (identity(control) === draft.path) {
          control.value = draft.value; control.checked = draft.checked;
        }
      }
      onRefresh(nextState);
      return nextState;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  startConfig(facade);
  return { refresh };
}
