import { spawn as spawnProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CONFIG_ENV, loginCommand } from './accounts-login.js';

const TERMINALS = [
  ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'],
  ['xterm', '-e'], ['x-terminal-emulator', '-e'],
];
const SAFE_FOLDER = /^[\p{L}\p{N}_ ./@+:\\~-]+$/u;

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
