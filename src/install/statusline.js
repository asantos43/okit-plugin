import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { clientRoot } from './config.js';
import { quote } from './link.js';
import { saveRecord } from './place.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const missing = (error) => { if (error.code !== 'ENOENT') throw error; return null; };
const message = 'Cannot read or change the Claude settings; check the file and its permissions. / Não foi possível ler ou alterar os ajustes do Claude; confira o arquivo e suas permissões.';

// Tokenize only literal words. Anything requiring shell interpretation uses
// the configured wrapper, preserving the original command as one argument.
export function commandWords(command) {
  const words = []; let word = ''; let active = false; let quoted = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if ((!quoted && /[|&;<>$`\n\r()*?{}\[\]~#%!^]/.test(char))
      || (quoted === '"' && /[$`]/.test(char))) return null;
    if (char === '\\' && quoted !== "'") { if (++i === command.length) return null; word += command[i]; active = true; }
    else if (char === quoted) quoted = null;
    else if (!quoted && (char === '"' || char === "'")) { quoted = char; active = true; }
    else if (!quoted && /\s/.test(char)) { if (active) words.push(word); word = ''; active = false; }
    else { word += char; active = true; }
  }
  if (quoted) return null;
  if (active) words.push(word);
  return words;
}

export async function planStatusline(record, deps) {
  const settings = deps.statuslineConfig;
  const path = record.statusline?.path ?? join(clientRoot(record.client, deps), settings.settingsFile);
  const original = await deps.fs.readFile(path).catch(missing);
  const value = original === null ? {} : JSON.parse(original.toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(message);
  const previous = value.statusLine;
  if (previous !== undefined && (!previous || previous.type !== 'command' || typeof previous.command !== 'string')) throw new Error(message);
  const words = commandWords(previous?.command ?? '');
  const collectorIndex = words?.indexOf(settings.subcommand) ?? -1;
  const owned = collectorIndex > 0;
  // A collector at another path is already registered; only update a command
  // whose original settings this installation can restore.
  if (owned && (!record.statusline || (collectorIndex === 1 && words[0] === deps.config.command))) return null;
  let command;
  if (owned) command = [deps.config.command, ...words.slice(collectorIndex)].map(quote).join(' ');
  else {
    const prior = previous?.command ? (words ?? [...settings.shell[deps.platform], previous.command]) : [];
    command = [deps.config.command, settings.subcommand, ...(prior.length ? ['--previous', ...prior] : [])].map(quote).join(' ');
  }
  value.statusLine = { ...previous, type: 'command', command };
  return { path, original, previous, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) };
}

async function writeBytes(path, bytes, fs) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    const stat = await fs.stat(path).catch(missing);
    if (stat) await fs.access(path, constants.W_OK);
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    await fs.rename(temp, path);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function applyStatusline(record, plan, deps) {
  const backup = record.statusline?.backup ?? join(deps.root, deps.statuslineConfig.backupFile);
  const statusline = record.statusline ?? { path: plan.path, backup, existed: plan.original !== null,
    previous: plan.previous };
  if (!record.statusline) await writeBytes(backup, plan.original ?? Buffer.alloc(0), deps.fs);
  try {
    await writeBytes(plan.path, plan.bytes, deps.fs);
    await saveRecord(deps.destination, { ...record, statusline: { ...statusline, hash: hash(plan.bytes) } }, deps);
  } catch (error) {
    if (plan.original === null) await deps.fs.rm(plan.path, { force: true });
    else await writeBytes(plan.path, plan.original, deps.fs).catch(() => {});
    if (!record.statusline) await deps.fs.rm(backup, { force: true });
    throw error;
  }
}

export async function registerStatusline(record, flags, deps) {
  if (record.client !== deps.statuslineConfig.client || flags['no-statusline']) return;
  if (!flags.statusline && !record.statusline && !deps.tty) {
    deps.out(`To record quota in the Claude status bar, use ${deps.config.command} install --client ${record.client} --statusline. / Para registrar a cota na barra do Claude, use ${deps.config.command} install --client ${record.client} --statusline.`);
    return;
  }
  try {
    const plan = await planStatusline(record, deps);
    if (!plan) return;
    deps.out(`Claude settings / Ajustes do Claude: ${plan.path}`);
    deps.out(`Add quota recording / Adicionar registro de cota: ${deps.config.command} ${deps.statuslineConfig.subcommand}`);
    deps.out(`Keep current bar / Manter barra atual: ${plan.previous?.command ?? '(none / nenhuma)'}`);
    if (deps.dryRun || flags.check) return;
    if (!flags.statusline && !record.statusline) {
      const answer = await deps.read('The Claude Code status bar will also record your quota; the current bar stays the same. Register? [y/N] / A barra de status do Claude Code vai também registrar a sua cota; a barra atual continua igual. Registrar? [s/N] ');
      if (!/^(y|yes|s|sim)$/i.test(answer.trim())) return;
    }
    await applyStatusline(record, plan, deps);
  } catch (error) { throw new Error(message, { cause: error }); }
}

export async function undoStatusline(record, deps) {
  if (!record.statusline) return;
  const saved = record.statusline;
  deps.out(`Restore Claude settings / Restaurar ajustes do Claude: ${saved.path}`);
  if (deps.dryRun) return;
  try {
    const bytes = await deps.fs.readFile(saved.path).catch(missing);
    if (bytes && hash(bytes) === saved.hash) {
      if (saved.existed) await writeBytes(saved.path, await deps.fs.readFile(saved.backup), deps.fs);
      else await deps.fs.rm(saved.path);
    } else if (bytes) {
      const value = JSON.parse(bytes.toString('utf8'));
      const words = commandWords(value.statusLine?.command ?? '');
      if ((words?.indexOf(deps.statuslineConfig.subcommand) ?? -1) > 0) {
        if (saved.previous === undefined) delete value.statusLine;
        else value.statusLine = saved.previous;
        await writeBytes(saved.path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), deps.fs);
      }
      deps.out('Kept your later edits; removed only our status bar when present. / Suas edições posteriores foram mantidas; só a nossa barra foi removida, quando presente.');
    }
    await deps.fs.rm(saved.backup, { force: true });
  } catch (error) { throw new Error(message, { cause: error }); }
}
