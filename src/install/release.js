import { OperationalError, UsageError } from './exit.js';
import { ConfigError } from '../profiles.js';
import { RULES } from './rules.js';
import { renderName } from './config.js';
import { manifestFileName } from './manifest.js';

export function repositoryName(value) {
  const name = String(value).replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '').split('/').slice(-2).join('/');
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some((part) => /^\.+$/.test(part))) throw new UsageError('Repository must be owner/repository');
  return name;
}

export async function request(url, config, fetch) {
  // What the request is made of is read before the network is touched: a setting that `fetch` would refuse is a
  // refusal of usage (the schema names it), never a failure of the network.
  try { new Headers(config.headers); } catch { throw new ConfigError('installSetting', { key: 'headers', rule: RULES.headerValue.en }); }
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    return await fetch(url, { headers: config.headers, signal });
  } catch (error) {
    throw new Error(`Release/download request failed: ${url}: ${error.message}`, { cause: error });
  }
}

export async function latestRelease({ config, release, pkg, repo, client, system, arch, prerelease = false, fetch }) {
  const base = `${config.api}/repos/${repositoryName(repo)}/releases`;
  // The address of the releases is the setting's: one that cannot be parsed is the setting's fault, not the network's.
  try { new URL(base); } catch { throw new ConfigError('installSetting', { key: 'api', rule: RULES.address.en }); }
  let response = prerelease ? null : await request(`${base}/latest`, config, fetch);
  let chosen;
  if (response?.ok) chosen = await response.json();
  else if (response && response.status !== 404) throw new Error(`Release API returned ${response.status}`);
  if (!chosen) {
    response = await request(base, config, fetch);
    if (!response.ok) throw new Error(`Release list API returned ${response.status}`);
    const list = (await response.json()).filter((item) => !item.draft);
    chosen = list.sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at))[0];
  }
  if (!chosen) throw new OperationalError('No published releases found');
  const prefix = release.publish.tagPrefix;
  const version = chosen.tag_name.startsWith(prefix) ? chosen.tag_name.slice(prefix.length) : chosen.tag_name;
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version) || version.includes('..')) throw new OperationalError('Unsafe release version');
  const name = renderName({ template: release.name, values: { package: pkg.name, version, client, system, arch, ext: release.formats[system] } });
  const manifestName = manifestFileName({ ...pkg, version });
  const asset = chosen.assets?.find((item) => item.name === name);
  const manifest = chosen.assets?.find((item) => item.name === manifestName);
  if (!asset || !manifest) throw new OperationalError(`Release ${version}: missing asset ${!asset ? name : manifestName}`);
  return { version, asset, manifest, prerelease: chosen.prerelease, format: release.formats[system] };
}
