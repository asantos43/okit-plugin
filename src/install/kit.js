import { detect } from './menu.js';

/** Read-only probe. All filesystem, process and configuration inputs are injected. */
export async function detectKit(deps) {
  const { kit } = deps.config;
  let path = kit.path;
  if (path === null) {
    for (const name of kit.executables) {
      path = await detect(name, deps);
      if (path) break;
    }
  } else {
    try {
      const info = await deps.fs.stat(path);
      if (!info.isFile() || (deps.platform !== deps.config.windowsPlatform && !(info.mode & 0o111))) path = null;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      path = null;
    }
  }
  if (!path) return { state: 'absent', path: null, version: null, message: `kit: absent. ${kit.hint}` };
  return probe(path, deps);
}

async function probe(path, deps) {
  const { kit } = deps.config;
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`version command timed out after ${kit.timeoutMs} ms`));
      }, kit.timeoutMs);
    });
    const result = await Promise.race([deadline, deps.run({
      command: path, args: kit.versionArgs, env: deps.env,
      signal: controller.signal, timeoutMs: kit.timeoutMs,
    })]);
    if (result?.code || result?.exitCode || result?.signal) throw new Error('version command failed');
    const version = String(result?.stdout ?? '').trim().split(/\r?\n/)[0];
    if (!/^(?:[^\r\n]*?\s)?v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid version output');
    return { state: 'installed', path, version, message: `kit: installed (${path}; ${version}). ${kit.overlap}` };
  } catch (error) {
    const reason = controller.signal.aborted ? `version command timed out after ${kit.timeoutMs} ms` : String(error.message).replace(/[\r\n]+/g, ' ');
    return { state: 'broken', path, version: null, message: `kit: broken (${path}; ${reason})` };
  } finally { clearTimeout(timer); }
}
