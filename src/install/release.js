import { renderName } from './config.js';
import { manifestFileName } from './manifest.js';

export function repositoryName(value) {
  const name = String(value).replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '').split('/').slice(-2).join('/');
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new TypeError('Repository must be owner/repository');
  return name;
}

export async function request(url, config, fetch) {
  try {
    return await fetch(url, { headers: config.headers, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (error) {
    throw new Error(`Release/download request failed: ${url}: ${error.message}`, { cause: error });
  }
}

export async function latestRelease({ config, release, pkg, repo, client, system, arch, prerelease = false, fetch }) {
  const base = `${config.api}/repos/${repositoryName(repo)}/releases`;
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
  if (!chosen) throw new TypeError('No published releases found');
  const prefix = release.publish.tagPrefix;
  const version = chosen.tag_name.startsWith(prefix) ? chosen.tag_name.slice(prefix.length) : chosen.tag_name;
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version) || version.includes('..')) throw new TypeError('Unsafe release version');
  const name = renderName({ template: release.name, values: { package: pkg.name, version, client, system, arch, ext: release.formats[system] } });
  const manifestName = manifestFileName({ ...pkg, version });
  const asset = chosen.assets?.find((item) => item.name === name);
  const manifest = chosen.assets?.find((item) => item.name === manifestName);
  if (!asset || !manifest) throw new TypeError(`Release ${version}: missing asset ${!asset ? name : manifestName}`);
  return { version, asset, manifest, prerelease: chosen.prerelease, format: release.formats[system] };
}
