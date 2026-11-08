// Only these fixed usage fields cross the credential boundary.
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_ARGS = ['-p', '.', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--tools', '', '--system-prompt', '.', '--disable-slash-commands',
  '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
const valid = (n) => typeof n === 'number' && Number.isFinite(n);
function window(used, reset, minutes) {
  if (!valid(used) || used < 0 || used > 100 || !valid(reset)
    || !Number.isFinite(new Date(reset).getTime())) throw new Error('Invalid usage response.');
  return { remainingPct: 100 - used, windowMinutes: minutes, resetsAt: new Date(reset).toISOString() };
}
export function claudeWindows(data, cli = false) {
  return [['five_hour', 300], ['seven_day', 10080]].map(([key, minutes]) => {
    const value = data?.[key];
    if (cli && (!valid(value?.utilization) || !valid(value?.resetsAt))) throw new Error('Invalid usage response.');
    if (!cli && (typeof value?.resets_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.resets_at))) {
      throw new Error('Invalid usage response.');
    }
    return window(cli ? value?.utilization * 100 : value?.utilization,
      cli ? value?.resetsAt * 1000 : Date.parse(value?.resets_at), minutes);
  });
}
export function codexWindows(data) {
  return ['primary', 'secondary'].map((key) => {
    const value = data?.rateLimits?.[key];
    if (!valid(value?.resetsAt)) throw new Error('Invalid usage response.');
    if (value?.windowDurationMins !== (key === 'primary' ? 300 : 10080)) throw new Error('Invalid usage response.');
    return window(value.usedPercent, value.resetsAt * 1000, value.windowDurationMins);
  });
}

export async function oauthWindows({ fs, folder, fetch, now, signal }) {
  let token;
  let expiresAt;
  try {
    const credentials = JSON.parse(await fs.readFile(`${folder}/.credentials.json`, 'utf8'));
    token = credentials?.claudeAiOauth?.accessToken;
    expiresAt = credentials?.claudeAiOauth?.expiresAt;
  } catch { return null; }
  if (typeof token !== 'string' || !token || !valid(expiresAt) || expiresAt <= now()) return null;
  let response;
  try {
    if (signal.aborted) throw new Error();
    response = await fetch(USAGE_URL, { method: 'GET', headers: { Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20' }, redirect: 'error', signal });
  } catch {
    throw new Error(signal.aborted ? 'Usage read timed out.' : 'Usage request failed.');
  } finally { token = undefined; }
  if (!response.ok) throw new Error(`Usage request failed (HTTP ${Number(response.status) || 0}).`);
  try { return claudeWindows(await response.json()); }
  catch { throw new Error('Invalid usage response.'); }
}
