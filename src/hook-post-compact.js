import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { inScope } from './applies.js';
import { orderStatus } from './orders.js';
import { DEFAULT_CONFIG } from './profiles.js';
import { paths } from './store.js';

export function postCompactConfig(config = {}) {
  const defaults = DEFAULT_CONFIG.postCompact;
  const given = config?.postCompact;
  const merged = { ...defaults, ...given };
  for (const key of ['timeoutSec', 'maxLines']) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0
      || (key === 'maxLines' && !Number.isInteger(merged[key]))) merged[key] = defaults[key];
  }
  return { ...merged, sections: { ...defaults.sections, ...given?.sections },
    text: { ...defaults.text, ...given?.text } };
}

const line = (value) => String(value ?? '').replace(/[\r\n\u2028\u2029\x00-\x1f\x7f]+/g, ' ').trim();

/** Pure, project-scoped summary; order text is restricted to its first line. */
export function buildPostCompactText({ items = [], orders = [], cwd, config, now = Date.now() } = {}) {
  const settings = postCompactConfig(config);
  if (settings.enabled === false) return '';
  const open = items.filter((item) => inScope(item, cwd) && settings.inboxStatuses.includes(item.status));
  const active = orders.filter((order) => inScope(order, cwd) && orderStatus(order, now) === 'active');
  if (open.length === 0 && active.length === 0) return '';
  const lines = [line(settings.text.heading)];
  if (settings.sections.status) lines.push(line(settings.text.status
    .replaceAll('{open}', String(open.length)).replaceAll('{orders}', String(active.length))));
  if (settings.sections.inbox) {
    for (const status of settings.inboxStatuses) {
      for (const item of open.filter((entry) => entry.status === status)) {
        lines.push(`${line(settings.text.inbox)} [${line(item.status)}] ${line(item.id)}: ${line(item.title)}`);
      }
    }
  }
  if (settings.sections.orders) {
    for (const order of active) lines.push(`${line(settings.text.orders)} ${line(order.id)}: ${line(order.title ?? order.text?.split(/\r?\n/)[0])}`);
  }
  return lines.length === 1 ? '' : lines.slice(0, settings.maxLines).join('\n');
}

async function readHookJson(file, signal, fallback) {
  try {
    return JSON.parse(await readFile(file, { encoding: 'utf8', signal }));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readInput(stream, signal) {
  return new Promise((accept, reject) => {
    let text = '';
    const data = (chunk) => { text += chunk; };
    const finish = () => { cleanup(); accept(text); };
    const fail = () => { cleanup(); reject(new Error('Hook input unavailable')); };
    function cleanup() {
      stream.off('data', data).off('end', finish).off('error', fail);
      signal.removeEventListener('abort', fail);
      stream.pause();
    }
    signal.addEventListener('abort', fail, { once: true });
    stream.setEncoding('utf8').on('data', data).once('end', finish).once('error', fail);
  });
}

/** Always silent on failure; the bootstrap budget also bounds config/stdin. */
export async function runPostCompact({ root, stdin = process.stdin, stdout = () => {},
  read = readHookJson, load } = {}) {
  const controller = new AbortController();
  const started = Date.now();
  let timer;
  let deadline;
  const expired = new Promise((accept) => {
    controller.signal.addEventListener('abort', () => accept(''), { once: true });
  });
  const arm = (seconds) => {
    clearTimeout(timer);
    deadline = started + seconds * 1000;
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(() => controller.abort(), remaining);
  };
  arm(DEFAULT_CONFIG.postCompact.timeoutSec);
  try {
    const work = (async () => {
      const files = paths(root);
      const config = await read(files.config, controller.signal, {});
      const settings = postCompactConfig(config);
      arm(settings.timeoutSec);
      if (controller.signal.aborted || settings.enabled === false) return '';
      const input = JSON.parse(typeof stdin === 'string' ? stdin : await readInput(stdin, controller.signal));
      if (typeof input?.cwd !== 'string' || input.cwd.trim() === '') return '';
      const state = load ? await load({ root, signal: controller.signal }) : await Promise.all([
        read(files.inbox, controller.signal, { items: [] }),
        read(files.orders, controller.signal, { orders: [] }),
      ]).then(([inbox, orders]) => ({ items: inbox.items, orders: orders.orders }));
      if (controller.signal.aborted) return '';
      if (!Array.isArray(state.items) || !Array.isArray(state.orders)) return '';
      return buildPostCompactText({ ...state, cwd: resolve(input.cwd), config });
    })();
    const text = await Promise.race([work, expired]);
    if (text && !controller.signal.aborted && Date.now() < deadline) stdout(text);
  } catch {
    // A restoration hint must never prevent the client from continuing.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return 0;
}
