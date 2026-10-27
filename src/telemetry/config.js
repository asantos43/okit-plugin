import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readJson } from '../state.js';
import { paths } from '../store.js';
import { DEFAULT_CONFIG } from '../profiles.js';

export async function settings(root) {
  const local = (await readJson(paths(root).config, {}).catch(() => {
    throw new Error('Cannot read measurement settings / Não foi possível ler os ajustes de medição');
  })).telemetry ?? {};
  const config = { ...DEFAULT_CONFIG.telemetry, ...local,
    rede: { ...DEFAULT_CONFIG.telemetry.rede, ...local.rede } };
  if (config.destination !== 'file' || typeof config.dir !== 'string' || !config.dir.trim()) {
    throw new Error('Choose a local measurement folder / Escolha uma pasta local para medições');
  }
  let kit = null;
  if (config.enabled === true) {
    try {
      if (config.kitConfigFile) {
        const saved = await readJson(config.kitConfigFile, {});
        kit = saved.telemetry ?? saved;
      } else kit = JSON.parse((await promisify(execFile)(config.kitExecutable, ['telemetry', 'status'],
        { timeout: config.kitTimeoutMs, maxBuffer: config.maxFileBytes })).stdout);
    } catch { /* The plugin remains standalone when kit is absent. */ }
  }
  if (kit?.enabled && kit.destination === 'file' && typeof kit.dir === 'string' && kit.dir.trim()) {
    if (!Object.hasOwn(local, 'dir')) config.dir = kit.dir;
    if (!Object.hasOwn(local, 'retentionDays')) config.retentionDays = kit.retentionDays;
    if (config.kitConfigFile && !Object.hasOwn(local, 'dir')) {
      config.dir = resolve(config.kitConfigFile, '..', kit.dir);
    }
  }
  config.dir = resolve(root, config.dir);
  for (const key of ['retentionDays', 'maxBytes', 'maxFileBytes', 'batchSeconds', 'kitTimeoutMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error('Invalid measurement setting / Ajuste de medição inválido');
  }
  if (!Number.isSafeInteger(config.rede.timeoutMs) || config.rede.timeoutMs <= 0) throw new Error('Invalid sending timeout / Prazo de envio inválido');
  return config;
}
