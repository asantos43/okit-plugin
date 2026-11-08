import { spawn as spawnProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CONFIG_ENV, loginCommand } from './accounts-login.js';

const TERMINALS = [
  ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'],
  ['xterm', '-e'], ['x-terminal-emulator', '-e'],
];
export const SAFE_FOLDER = /^[\p{L}\p{N}_ ./@+:\\~-]+$/u;

export const LOGIN_TIMEOUT_MS = 300_000;

/** Only a sanitized HTTPS URL may leave the client's output stream. */
export function loginUrl(output, redact) {
  for (const candidate of output.match(/https:\/\/[^\s<>"'\x00-\x1f]+/g) ?? []) {
    try {
      if (candidate.includes('[Redacted]')) continue;
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || url.username || url.password
        || redact(decodeURIComponent(candidate)) !== decodeURIComponent(candidate) || url.hash) continue;
      if ([...url.searchParams.keys()].some(key => /token|secret|password|credential|code$/i.test(key))) continue;
      return url.href;
    } catch { /* Ignore malformed URLs. */ }
  }
  return null;
}

/** Session-owned processes; raw output and process errors never become state. */
export function createAccountLogins({ env, platform, redact, timeoutMs = LOGIN_TIMEOUT_MS,
  spawn = spawnProcess, fallback = launchLogin, onSuccess = async () => {} }) {
  const jobs = new Map();
  let closed = false;
  const running = job => ['starting', 'waiting-for-browser'].includes(job?.state);
  const stopChild = child => {
    if (!child?.pid) return;
    try {
      if (platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
  };
  const finish = (job, state, reason = null) => {
    clearTimeout(job.timer);
    job.state = state; job.reason = reason;
    stopChild(job.child);
  };
  const view = job => redact({ state: job?.state ?? 'cancelled', reason: job?.reason ?? null,
    url: job?.url ?? null, command: job?.command ?? null });
  const terminal = async (job, options) => {
    if (closed || job.fallback) return;
    job.fallback = true;
    if (running(job)) finish(job, 'failed', 'Browser could not open. Use the command in a terminal.');
    await launchTerminal(options).catch(() => {});
  };
  const launchTerminal = async options => {
    if (closed) return { launched: false, reason: 'no-terminal' };
    return fallback({ ...options, spawn });
  };
  function start(options, logout = false) {
    const { client, account, saved } = options;
    const key = `${client}:${account.id}`;
    const previous = jobs.get(key);
    if (running(previous)) {
      if (!logout || previous.logout) return view(previous);
      finish(previous, 'cancelled');
    }
    if (closed) return { state: 'cancelled', reason: null };
    if (account.configDir != null && (typeof account.configDir !== 'string' || !SAFE_FOLDER.test(account.configDir))) {
      return { state: 'failed', reason: 'Unsafe account folder.' };
    }
    const job = { state: 'starting', reason: null, logout,
      command: loginCommand(client, account, platform, { saved }) };
    jobs.set(key, job);
    const childEnv = { ...env };
    if (account.configDir) childEnv[CONFIG_ENV[client]] = account.configDir;
    else if (saved) delete childEnv[CONFIG_ENV[client]];
    const args = client === 'codex' ? [logout ? 'logout' : 'login'] : ['auth', logout ? 'logout' : 'login'];
    const failed = () => {
      if (!running(job)) return;
      finish(job, 'failed', logout ? 'Sign out could not start.' : 'Login could not start. Use the command in a terminal.');
      if (!logout) void terminal(job, options);
    };
    try {
      const child = spawn(client === 'codex' ? 'codex' : 'claude', args,
        { env: childEnv, shell: false, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      child.once('error', failed);
      child.once('spawn', () => { if (running(job)) job.state = 'waiting-for-browser'; });
      const tails = new Map();
      const output = (chunk, stream) => {
        if (!running(job) || logout || job.url) return;
        const text = redact((tails.get(stream) ?? '') + chunk.toString());
        const tail = /(?:https:\/\/[^\s<>"']*|https?:?\/?|htt|ht|h)$/.exec(text)?.[0] ?? '';
        // Retain only a bounded, redacted URL candidate, never the output transcript.
        tails.set(stream, tail.length <= 8192 ? tail : '');
        const complete = tail ? text.slice(0, -tail.length) : text;
        const url = loginUrl(complete, redact);
        if (!url) return;
        job.url = url;
        if (platform === 'win32') { void terminal(job, options); return; }
        try {
          const browser = spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url],
            { env, shell: false, detached: true, stdio: 'ignore' });
          browser.once('error', () => { if (running(job)) void terminal(job, options); });
          browser.once('close', code => {
            if (code !== 0 && running(job)) void terminal(job, options);
          });
        } catch { void terminal(job, options); }
      };
      child.stdout.on('data', chunk => output(chunk, 'stdout'));
      child.stderr.on('data', chunk => output(chunk, 'stderr'));
      child.stdout.on('end', () => output('\n', 'stdout'));
      child.stderr.on('end', () => output('\n', 'stderr'));
      child.once('close', code => {
        if (!running(job)) return;
        finish(job, code === 0 ? (logout ? 'logged-out' : 'logged-in') : 'failed',
          code === 0 ? null : (logout ? 'Sign out failed.' : 'Login failed. Use the command in a terminal.'));
        if (code === 0 && !logout) void Promise.resolve().then(() => onSuccess(client, account.id)).catch(() => {});
      });
      job.timer = setTimeout(() => {
        if (running(job)) finish(job, 'timed-out', logout ? 'Sign out timed out.' : 'Login timed out.');
      }, timeoutMs);
    } catch { failed(); }
    return view(job);
  }
  return {
    start,
    launchTerminal,
    status: (client, id) => view(jobs.get(`${client}:${id}`)),
    cancel(client, id) {
      const job = jobs.get(`${client}:${id}`);
      if (running(job)) finish(job, 'cancelled');
      return view(job);
    },
    close() {
      closed = true;
      for (const job of jobs.values()) if (running(job)) finish(job, 'cancelled');
    },
  };
}

async function onPath(name, env) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = join(directory, name);
    try { await access(file, constants.X_OK); return file; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

/** Open the client's own login; no credential is read or supplied by the plugin. */
export async function launchLogin({ client, account, saved = false, platform = process.platform,
  env = process.env, spawn = spawnProcess, which = onPath }) {
  if (!['claude-code', 'codex'].includes(client)) return { launched: false, reason: 'unsupported-client' };
  if (account?.configDir != null && (typeof account.configDir !== 'string' || !SAFE_FOLDER.test(account.configDir))) {
    return { launched: false, reason: 'unsafe-folder' };
  }
  try {
    let terminal, command, args;
    if (platform === 'linux') {
      const login = client === 'codex' ? ['codex', 'login'] : ['claude'];
      const variable = CONFIG_ENV[client];
      const words = account?.configDir ? ['env', `${variable}=${account.configDir}`, ...login]
        : saved ? ['env', '-u', variable, ...login] : login;
      for (const [name, prefix] of TERMINALS) {
        const found = await which(name, env);
        if (!found) continue;
        terminal = name; command = found; args = [prefix, ...words]; break;
      }
      if (!terminal) return { launched: false, reason: 'no-terminal' };
    } else if (platform === 'darwin') {
      terminal = 'Terminal'; command = 'osascript';
      const line = loginCommand(client, account, platform, { saved });
      const escaped = line.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      args = ['-e', 'tell application "Terminal" to activate', '-e',
        `tell application "Terminal" to do script "${escaped}"`];
    } else if (platform === 'win32') {
      terminal = 'powershell'; command = 'cmd.exe';
      args = ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command',
        loginCommand(client, account, platform, { saved })];
    } else return { launched: false, reason: 'no-terminal' };
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
    if (child.once) await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    return { launched: true, terminal };
  } catch { return { launched: false, reason: 'no-terminal' }; }
}
