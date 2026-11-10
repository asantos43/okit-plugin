// Minimal native-control DOM for the wizard; HTML insertion is deliberately forbidden.
export function wizardDom(boot, responses = []) {
  const handlers = new Map(), calls = [], timers = [], nodes = new Map();
  const camel = (key) => key.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.attributes = {}; this.hidden = false; this.checked = false; this.disabled = false;
      this.classList = { toggle() {} }; this.handlers = new Map(); }
    set textContent(value) { this.text = String(value ?? ''); this.children = []; }
    get textContent() { return (this.text ?? '') + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('HTML insertion is forbidden'); }
    set value(value) { this.storedValue = String(value ?? ''); }
    get value() { return this.storedValue ?? (this.tagName === 'SELECT' ? this.children[0]?.value ?? '' : this.text ?? ''); }
    append(...children) { for (const node of children) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
    get lastChild() { return this.children.at(-1); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return key.startsWith('data-') ? this.dataset[camel(key.slice(5))]
      : key === 'class' ? this.className : this[key] ?? this.attributes[key]; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    removeEventListener(name) { this.handlers.delete(name); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    matches(selector) {
      const tag = selector.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName.toLowerCase() !== tag) return false;
      const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
      const klass = selector.match(/^\.([\w-]+)/)?.[1]; if (klass && !this.className?.split(' ').includes(klass)) return false;
      return [...selector.matchAll(/\[([^\]=^$]+)([\^$]?=)?"?([^\]"]*)"?\]/g)].every(([, key, operator, value]) => {
        const actual = this.getAttribute(key);
        return !operator ? actual !== undefined : operator === '^=' ? actual?.startsWith(value)
          : operator === '$=' ? actual?.endsWith(value) : actual === value;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      return descendants.filter((node) => selector.split(',').some((part) => {
        const pieces = part.trim().split(/\s+/), last = pieces.pop();
        return node.matches(last) && (!pieces.length || node.parentElement?.closest(pieces.join(' ')));
      }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    click() { return dispatch('click', this); }
  }
  const root = new Node('html');
  const document = { documentElement: root, activeElement: null, createElement: (tag) => new Node(tag),
    querySelectorAll: (selector) => root.querySelectorAll(selector), querySelector: (selector) => root.querySelector(selector),
    getElementById: (id) => root.querySelector(`#${id}`),
    addEventListener(name, fn, capture) { const list = handlers.get(name) ?? []; list.push({ fn, capture }); handlers.set(name, list); },
    removeEventListener(name, fn) { handlers.set(name, (handlers.get(name) ?? []).filter((item) => item.fn !== fn)); } };
  const add = (id, tag = 'div', parent = root) => { const node = new Node(tag); node.id = id; parent.append(node); nodes.set(id, node); return node; };
  add('state', 'script').textContent = JSON.stringify(boot);
  for (const id of ['heading', 'status', 'error', 'body', 'choices', 'actions', 'existing', 'events', 'technical', 'boundaries', 'preview', 'question']) add(`wizard-${id}`, id === 'heading' ? 'h2' : 'div');
  for (const id of ['consent', 'unknown']) { const label = add(`wizard-${id}-label`, 'label');
    const input = add(`wizard-${id}`, 'input', label); input.type = 'checkbox'; label.append(new Node('span')); }
  const dialog = add('wizard-write', 'dialog'); dialog.append(new Node('pre'));
  add('wizard-locale', 'select'); add('wizard'); add('config-footer');
  const configuration = add('configuration'), tabs = new Node(); tabs.className = 'tabs'; configuration.append(tabs);
  for (const id of ['actors', 'accounts']) { const panel = add(`panel-${id}`, 'section', configuration); panel.attributes.role = 'tabpanel';
    const tab = new Node('button'); tab.dataset.tab = id; tab.attributes.role = 'tab'; tab.attributes['aria-controls'] = panel.id; tabs.append(tab); }
  for (const id of ['error', 'status', 'review', 'changes', 'reload']) add(id);
  const win = { document, URLSearchParams, navigator: {},
    location: { search: '?token=private-token', pathname: '/', hash: '', reload() {} },
    history: { replaceState(_state, _title, path) { win.location.search = ''; win.location.hash = path.startsWith('#') ? path : ''; } },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    addEventListener() {}, removeEventListener() {},
    fetch: async (path, options) => { calls.push({ path, ...options });
      const result = responses.shift() ?? { status: 200, value: { state: 'idle', jobId: null, events: [] } };
      return { status: result.status, ok: result.status === 200, json: async () => result.value }; } };
  document.defaultView = win;
  async function dispatch(name, target) { let stopped = false;
    const event = { target, stopImmediatePropagation() { stopped = true; }, preventDefault() {} };
    for (const { fn } of [...(handlers.get(name) ?? [])].sort((a, b) => Boolean(b.capture) - Boolean(a.capture))) {
      if (!stopped) await fn(event);
    }
  }
  return { win, document, nodes, calls, timers, add, dispatch };
}
