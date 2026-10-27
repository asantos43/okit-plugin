import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { clientRequest, invokeClient } from '../client.js';
import { DEFAULT_CONFIG } from '../../profiles.js';
import { safeFile } from './scenario.js';

const MAX_ARTIFACT_BYTES = 128 * 1024;
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validCost = (value) => Number.isFinite(value) && value >= 0;

async function snapshotFiles(briefing, after = false) {
  const root = resolve(briefing.root);
  const allowed = new Set(briefing.allowedOutputPaths.map((path) => resolve(root, path)));
  const folders = [join(root, 'home'), briefing.cwd, ...['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'XDG_CONFIG_HOME'].map((key) => briefing.env?.[key])].filter(Boolean).map((path) => resolve(path))
    .filter((path) => path !== root);
  const snapshot = new Map();
  const inspect = async (operation, path) => {
    try { return await operation(path); }
    catch (cause) {
      if (after && cause.code === 'ENOENT') {
        snapshot.set(path, 'missing');
        return null;
      }
      throw new Error('Could not check the files. / Não foi possível conferir os arquivos.', { cause });
    }
  };
  const visit = async (path) => {
    if (allowed.has(path) || folders.some((folder) => path === folder || path.startsWith(`${folder}${sep}`))) return;
    const stat = await inspect(lstat, path);
    if (stat === null) return;
    if (stat.isDirectory()) {
      if (path !== root && ![...allowed].some((file) => file.startsWith(`${path}${sep}`))) {
        snapshot.set(path, 'directory');
      }
      const names = await inspect(readdir, path);
      if (names === null) return;
      for (const name of names) await visit(join(path, name));
    } else snapshot.set(path, JSON.stringify([stat.size, stat.mtimeMs, stat.mode]));
  };
  await visit(root);
  return snapshot;
}

function usageOf(client, reportsCost, { events = [], state = {}, stdout = '' }) {
  const native = stdout.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const steps = native.filter((event) => client === 'codex'
    ? ['turn.completed', 'turn.failed'].includes(event?.type) : event?.type === 'step_finish');
  const missingTokens = steps.some((event) => {
    const usage = client === 'codex' ? event.usage : event.part?.tokens;
    return ![usage?.input_tokens ?? usage?.input, usage?.output_tokens ?? usage?.output].every(validCount);
  });
  const result = events.findLast((event) => event.type === 'result');
  const counts = [result?.usage?.input_tokens, result?.usage?.output_tokens];
  const tokens = state.unknownTokens || missingTokens ? null : validCount(state.tokens) ? state.tokens
    : counts.every(validCount) ? counts[0] + counts[1] : null;
  const cost = result?.total_cost_usd ?? state.cost;
  const costUsd = tokens === null || state.unknownCost ? null
    : reportsCost ? validCost(cost) ? cost : null : 0;
  const turns = client === 'claude-code' ? result?.num_turns
    : steps.length;
  return { costUsd, tokens, turns: validCount(turns) ? turns : null };
}

function finalText(events) {
  const result = events.findLast((event) => event.type === 'result');
  if (typeof result?.result === 'string') return result.result;
  const last = events.findLast((event) => event.type === 'assistant'
    && event.message?.content?.some((block) => block.type === 'text'));
  return (last?.message.content ?? []).filter((block) => block.type === 'text')
    .map((block) => block.text ?? '').join('\n');
}

function promptFor(briefing) {
  return `${briefing.text}\n\nOnly write these files, relative to the practice root / Escreva apenas estes arquivos, relativos à raiz de exemplo:\n${JSON.stringify(briefing.allowedOutputPaths)}\nPractice root / Raiz de exemplo: ${briefing.root}\nChecks to meet / Verificações a cumprir: ${JSON.stringify(briefing.acceptance)}\nChecks to fix / Verificações a corrigir: ${JSON.stringify(briefing.failedCriteria ?? [])}\nWork limits / Limites do trabalho: ${JSON.stringify(briefing.limits)}`;
}

export function realDrivers({ client, config = {}, spawn }) {
  if (typeof spawn !== 'function') throw new Error('Provide a helper launcher. / Informe como iniciar o ajudante.');
  const settings = { ...DEFAULT_CONFIG.smoke, ...config.smoke };
  const { reportsCost } = clientRequest(client, config);
  if (reportsCost === false && (!validCount(settings.maxTokens) || settings.maxTokens < 1)) {
    throw new Error('Set smoke.maxTokens to a positive whole number before starting. / Defina smoke.maxTokens como um número inteiro positivo antes de começar.');
  }
  const maxCostUsd = reportsCost
    ? settings.demoDemandMaxUsd ?? settings.maxUsd : 0;

  async function call(briefing, prompt) {
    const request = clientRequest(client, config, { briefing: prompt, cwd: briefing.cwd,
      maxUsd: Math.min(briefing.limits.maxUsd, maxCostUsd), maxTurns: briefing.limits.maxTurns,
      model: briefing.actor?.model ?? briefing.profile?.model,
      effort: briefing.actor?.effort ?? briefing.profile?.effort });
    const controller = new AbortController();
    let progress = { events: [], state: {}, stdout: '', stderr: '' }, timer, cancel;
    const launch = (...args) => {
      const child = spawn(...args);
      child.stdout.on('data', (chunk) => { progress.stdout += chunk; });
      child.stderr.on('data', (chunk) => { progress.stderr += chunk; });
      return child;
    };
    const abort = () => controller.abort(briefing.signal.reason);
    const stopped = () => new Error(briefing.signal?.aborted
      ? 'Work interrupted. / Trabalho interrompido.' : 'Work took too long. / O trabalho demorou demais.');
    try {
      if (briefing.signal?.aborted) throw stopped();
      briefing.signal?.addEventListener('abort', abort, { once: true });
      const before = await snapshotFiles(briefing);
      if (controller.signal.aborted) throw stopped();
      const cancellation = new Promise((resolve, reject) => {
        cancel = () => reject(stopped());
        controller.signal.addEventListener('abort', cancel, { once: true });
      });
      timer = setTimeout(() => controller.abort(), Math.min(briefing.limits.timeoutMs, settings.checkTimeoutMs));
      const response = await Promise.race([cancellation, invokeClient({ client, config, ...request,
        cwd: briefing.cwd, env: briefing.env, signal: controller.signal, spawn: launch,
        onProgress: (value) => { progress = { ...progress, ...value }; } })]);
      progress = response;
      const usage = usageOf(client, request.reportsCost, response);
      if (settings.maxTokens != null && usage.tokens > settings.maxTokens) {
        throw new Error('The helper exceeded the text allowance. / O ajudante ultrapassou o limite de texto.');
      }
      const after = await snapshotFiles(briefing, true);
      if ([...new Set([...before.keys(), ...after.keys()])].some((path) => before.get(path) !== after.get(path))) {
        throw new Error('The helper wrote outside the allowed files. / O ajudante escreveu fora dos arquivos permitidos.');
      }
      if (controller.signal.aborted) throw stopped();
      return { ...response, usage,
        text: finalText(response.events) };
    } catch (error) {
      const partial = { ...progress, ...Object.fromEntries(['events', 'state', 'stdout', 'stderr']
        .filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) };
      throw Object.assign(error, partial, { usage: usageOf(client, request.reportsCost, partial) });
    } finally {
      clearTimeout(timer);
      briefing.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  return {
    actor: { maxCostUsd, async run(briefing) {
      const response = await call(briefing, promptFor(briefing));
      try {
        const artifacts = [];
        for (const path of new Set(briefing.allowedOutputPaths)) {
          const file = await safeFile(briefing.root, path);
          const stat = await lstat(file).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (stat === null) continue;
          if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
            throw new Error('The output must be a regular file of at most 128 KiB. / A saída deve ser um arquivo comum de até 128 KiB.');
          }
          const content = await readFile(file, 'utf8').catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (content !== null) artifacts.push({ path, content });
        }
        return { status: response.events.some((event) => event.type === 'result' && event.is_error)
          ? 'failed' : 'completed', summary: response.text, artifacts,
          usage: response.usage, transcript: response.stdout };
      } catch (error) { throw Object.assign(error, { usage: response.usage, events: response.events, state: response.state }); }
    } },
    critic: { maxCostUsd, async review({ briefing, result, artifacts, checks }) {
      const prompt = `${promptFor(briefing)}\nReview this work / Confira este trabalho:\n${JSON.stringify({ result, artifacts, checks })}\nReply with one JSON object only / Responda apenas com um objeto JSON: {"verdict":"approved"|"rejected","criteria":[],"feedback":"..."}`;
      const response = await call(briefing, prompt);
      let answer;
      try { answer = JSON.parse(response.text); } catch { /* An unreadable answer always refuses approval. */ }
      const valid = answer && !Array.isArray(answer) && ['approved', 'rejected'].includes(answer.verdict)
        && Array.isArray(answer.criteria) && typeof answer.feedback === 'string'
        && !response.events.some((event) => event.type === 'result' && event.is_error);
      return { verdict: valid ? answer.verdict : 'rejected', criteria: valid ? answer.criteria : [],
        feedback: valid ? answer.feedback : 'The review answer could not be read. / Não foi possível ler a resposta da revisão.',
        usage: response.usage, transcript: response.stdout };
    } },
  };
}
