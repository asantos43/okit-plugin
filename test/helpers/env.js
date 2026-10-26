// The environment a test injects names the client it simulates, so the
// environment of the process that runs the suite never decides what a test
// sees. `detectClient` reads the markers of a running client
// (`CLAUDECODE`, `CODEX_CI`, `CODEX_THREAD_ID`, `OPENCODE`, `OPENCODE_PID`),
// and a machine with one of them set would otherwise change the answer of
// every command under test.

// | Client | Marker that names it |
// | claude-code | CLAUDECODE |
// | codex | CODEX_CI |
// | opencode | OPENCODE_PID |
import { join } from 'node:path';

const MARKER_OF = { 'claude-code': 'CLAUDECODE', codex: 'CODEX_CI', opencode: 'OPENCODE_PID' };

/** Keep quota discovery inside a test's scratch root, preserving client markers. */
export function quotaEnv(root, extra = {}) {
  return { ...extra, HOME: root, USERPROFILE: root,
    CODEX_SESSIONS_DIR: root === undefined ? undefined : join(root, 'sessions') };
}

/**
 * The environment of a command under test: it names the given client and
 * carries nothing else from the real environment.
 *
 * @param {string} client the client the test simulates
 * @param {object} [extra] the other variables the command needs
 * @returns {object} the environment
 */
export function clientEnv(client, extra = {}) {
  const marker = MARKER_OF[client];
  return marker === undefined ? { ...extra } : { ...extra, [marker]: '1' };
}

/**
 * Puts a marker in the environment of the running process, the way a machine
 * with a real client would, and returns the function that puts it back.
 *
 * @param {string} name the variable to set
 * @param {string} value the value it carries
 * @returns {Function} the undo
 */
export function ambientMarker(name, value) {
  const before = process.env[name];
  process.env[name] = value;
  return () => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  };
}
