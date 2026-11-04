import * as filesystem from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clientRoot, installConfig, homeOf } from './install/config.js';

/** The install options of the person; the defaults when the configuration has none (or cannot be read). */
function installOf(install) {
  try { return installConfig(install); } catch { return installConfig(); }
}

/**
 * Detect credential markers without opening credentials. Unreadable state is unknown.
 *
 * The folder of the default account is the one the install options of the person name, not the one the defaults of
 * the installer name: the account that is not an extra lives in the folder the client itself uses.
 *
 * @param {object} input the client, the account, the install options of the person and the world to read
 * @returns {Promise<string>} the login state
 */
export async function loginState({ client, account, install, env = process.env, platform = process.platform,
  fs = filesystem, home = homeOf(env, platform) ?? homedir() }) {
  if (!['claude-code', 'codex'].includes(client)) return 'unknown';
  if (client === 'claude-code' && platform === 'darwin') return 'unknown';
  const root = account?.configDir || clientRoot(client, { config: installOf(install), env, home });
  if (client === 'codex') {
    try {
      const config = await fs.readFile(join(root, 'config.toml'), 'utf8');
      const store = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m.exec(config);
      if (store && store[1] !== 'file') return 'unknown';
    } catch (error) { if (error?.code !== 'ENOENT') return 'unknown'; }
  }
  try {
    const marker = await fs.stat(join(root, client === 'codex' ? 'auth.json' : '.credentials.json'));
    return marker.isFile() ? 'logged-in' : 'logged-out';
  } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'logged-out' : 'unknown'; }
}

/** Environment credentials take precedence over every stored Claude login. */
export function accountWarnings(client, env = process.env) {
  return client === 'claude-code' ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
    .filter((name) => Boolean(env[name])).map((variable) => ({ code: 'env-credential-overrides-login', variable })) : [];
}
