import * as filesystem from 'node:fs/promises';
import { spawn as spawnProcess } from 'node:child_process';
import { join } from 'node:path';
import { accountsOf, accountEnv, accountFiles } from '../accounts.js';
import { loginState } from '../accounts-login.js';
import { defaultFolderOf, homeOf } from '../install/config.js';
import { configOf } from '../profiles.js';
import { oauthWindows } from './active-sources.js';
import { processWindows } from './active-process.js';

export const pollStateFile = (client, id) => accountFiles(client, id).reading.replace(/\.json$/, '.state.json');
export function createQuotaPoller({ root, fs = filesystem, fetch = globalThis.fetch, spawn = spawnProcess,
  now = Date.now, env = process.env, platform = process.platform, login = loginState,
  random = Math.random, schedule = setTimeout, cancel = clearTimeout,
  endpointTimeoutMs = 10_000, cliTimeoutMs = 60_000, appTimeoutMs = 10_000 } = {}) {
  const pending = new Map();
  const controllers = new Set();
  let stopped = false;
  let timer;
  let active = 0;
  const queue = [];
  let cliTail = Promise.resolve();
  const directory = join(root, 'quota');
  const json = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  const settings = async () => configOf(await json(join(root, 'config.json')) ?? {});
  const atomic = async (file, value) => {
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
  };
  const lock = async (file) => {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(String(now())); await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      // A crashed worker cannot hold a lease beyond its longest hard timeout.
      try {
        const text = await fs.readFile(file, 'utf8');
        if (text.trim() && now() - Number(text) > 75_000) await fs.rm(file);
      } catch { /* busy */ }
      return false;
    }
  };
  async function readAccount(client, id, force) {
    const config = await settings();
    if (stopped || !config.quotaPoll.enabled) return;
    const account = accountsOf(config, client).find((entry) => entry.id === id);
    if (!account) return;
    await fs.mkdir(directory, { recursive: true });
    const statePath = join(directory, pollStateFile(client, id));
    const lease = `${statePath}.lock`;
    if (!await lock(lease)) return;
    const controller = new AbortController(); controllers.add(controller);
    let slot;
    const heartbeat = setInterval(() => {
      void fs.writeFile(lease, String(now())).catch(() => {});
      if (slot) void fs.writeFile(slot, String(now())).catch(() => {});
    }, 10_000);
    try {
      const previous = await json(statePath) ?? {};
      if (!force && now() < (previous.nextTryAt ?? 0)) return;
      while (!stopped && !slot) {
        for (let index = 0; index < 4; index += 1) {
          const candidate = join(directory, `read-slot-${index}.lock`);
          if (await lock(candidate)) { slot = candidate; break; }
        }
        if (!slot) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (stopped) return;
      await fs.writeFile(lease, String(now()));
      const at = now();
      const state = { state: 'no-reading', reason: 'No reading yet.', at,
        nextTryAt: at + config.quotaPoll.intervalSec * 1000, source: null,
        fallbackAt: previous.fallbackAt ?? null, failures: previous.failures ?? 0 };
      try {
        if (await login({ client, account, config, fs, env, platform }) === 'logged-out') {
          state.state = 'not-logged-in'; state.reason = 'Account is not logged in.';
        } else {
          const selectedEnv = accountEnv(client, account, env, undefined, config);
          let windows;
          if (client === 'claude-code') {
            const folder = account.configDir ?? defaultFolderOf(client, { config, env, platform, home: homeOf(env, platform) });
            state.source = 'active-oauth';
            let deadline;
            try {
              windows = await Promise.race([oauthWindows({ fs, folder, fetch, now, signal: controller.signal }),
                new Promise((_, reject) => { deadline = setTimeout(() => {
                  controller.abort(); reject(new Error('Usage read timed out.'));
                }, endpointTimeoutMs); })]);
            } finally { clearTimeout(deadline); }
            if (!windows && state.fallbackAt !== null
              && at - state.fallbackAt < config.quotaPoll.claudeFallbackMinutes * 60_000) {
              state.state = 'token-expired'; state.reason = 'Token unavailable; fallback is cooling down.';
            } else if (!windows) {
              state.source = 'active-cli';
              const cliLease = join(directory, 'claude-fallback.lock');
              const prior = cliTail;
              let releaseCli;
              cliTail = new Promise((resolve) => { releaseCli = resolve; });
              await prior;
              let cwd;
              let acquired = false;
              try {
                while (!stopped && !acquired) {
                  acquired = await lock(cliLease);
                  if (!acquired) await new Promise((resolve) => setTimeout(resolve, 50));
                }
                if (!acquired) throw new Error('Claude fallback is busy.');
                state.fallbackAt = now();
                await atomic(statePath, state);
                cwd = await fs.mkdtemp(join(directory, 'empty-'));
                windows = await processWindows({ client, spawn, env: selectedEnv, cwd,
                  signal: controller.signal, timeoutMs: cliTimeoutMs });
              } finally {
                if (cwd) await fs.rm(cwd, { recursive: true, force: true });
                if (acquired) await fs.rm(cliLease, { force: true });
                releaseCli();
              }
            }
          } else {
            state.source = 'active-app-server';
            windows = await processWindows({ client, spawn, env: selectedEnv,
              cwd: directory, signal: controller.signal, timeoutMs: appTimeoutMs });
          }
          if (windows) {
            const reading = { windows, remainingPct: Math.min(...windows.map((w) => w.remainingPct)),
              recordedAt: new Date(at).toISOString(), readAt: at, source: state.source };
            const file = join(directory, accountFiles(client, id).reading);
            const held = await json(file);
            const passive = await json(join(directory, accountFiles(client, id).statusline));
            if (!(Date.parse(held?.recordedAt) > at) && !(Date.parse(passive?.receivedAt) > at)) await atomic(file, reading);
            state.state = 'ok'; state.reason = null; state.failures = 0;
          }
        }
      } catch (error) {
        state.state = 'read-failed';
        const safe = ['Usage read timed out.', 'Usage read stopped.', 'Usage client failed.',
          'Usage client closed without a reading.', 'Invalid usage response.', 'Usage request failed.',
          'Usage initialization failed.', 'Usage response too large.', 'Claude fallback is busy.'];
        state.reason = safe.includes(error?.message) || /^Usage request failed \(HTTP \d+\)\.$/.test(error?.message)
          ? error.message : 'Usage read failed.';
        state.failures += 1;
        state.nextTryAt = at + Math.min(15, 2 ** Math.min(state.failures - 1, 4)) * 60_000;
      }
      if (!stopped) await atomic(statePath, state);
    } finally {
      clearInterval(heartbeat);
      controllers.delete(controller);
      if (slot) await fs.rm(slot, { force: true });
      await fs.rm(lease, { force: true });
    }
  }
  function readNow(client, id = 'default', { force = true } = {}) {
    const key = `${client}:${id}`;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      if (active >= 4) await new Promise((resolve) => queue.push(resolve));
      active += 1;
      try { return await readAccount(client, id, force); }
      finally { active -= 1; queue.shift()?.(); }
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function cycle() {
    const config = await settings();
    if (stopped || !config.quotaPoll.enabled) return;
    await Promise.all(['claude-code', 'codex'].flatMap((client) => accountsOf(config, client)
      .map((account) => readNow(client, account.id, { force: false }))));
  }
  async function start() {
    if (stopped) return;
    const began = now();
    try { await cycle(); } catch { /* An unreadable config is retried next minute. */ }
    if (stopped) return;
    const config = await settings().catch(() => null);
    if (config?.quotaPoll.enabled === false) return;
    timer = schedule(() => { void start(); }, Math.max(0,
      (config?.quotaPoll.intervalSec ?? 60) * 1000 + random() * 5000 - (now() - began)));
  }
  async function stop() {
    stopped = true;
    cancel(timer);
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending.values());
  }
  return { cycle, readNow, start, stop };
}
