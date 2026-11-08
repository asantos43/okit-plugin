import { CLAUDE_ARGS, claudeWindows, codexWindows } from './active-sources.js';

/** Bounded stdio protocol. Raw client output and errors never leave this function. */
export function processWindows({ client, spawn, env, cwd, signal, timeoutMs = client === 'codex' ? 10_000 : 60_000 }) {
  return new Promise((resolve, reject) => {
    let child;
    let buffer = '';
    let done = false;
    let killTimer;
    let reaped;
    const closed = new Promise((resolveClose) => { reaped = resolveClose; });
    const terminate = () => {
      if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      terminate();
      const settle = () => { if (error) reject(new Error(error)); else resolve(value); };
      if (child && child.exitCode === null) void closed.then(settle);
      else settle();
    };
    const abort = () => finish('Usage read stopped.');
    const timer = setTimeout(() => finish('Usage read timed out.'), timeoutMs);
    try {
      child = spawn(client === 'codex' ? 'codex' : 'claude', client === 'codex' ? ['app-server'] : CLAUDE_ARGS,
        { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      child.once('error', () => finish('Usage client failed.'));
      child.once('close', () => {
        clearTimeout(killTimer); reaped(); finish('Usage client closed without a reading.');
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdin.on('error', () => finish('Usage client failed.'));
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) { finish('Usage response too large.'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (client === 'codex' && message.id === 1) {
            if (message.error) { finish('Usage initialization failed.'); return; }
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read', params: {} });
          } else if (client === 'codex' && message.id === 2 || message.type === 'rate_limit_event') {
            try { finish(null, client === 'codex' ? codexWindows(message.result)
              : claudeWindows(message.rate_limit_info?.unifiedWindows, true)); }
            catch { finish('Invalid usage response.'); }
          }
        }
      });
      if (client === 'codex') send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'okit-quota', version: '1.0.0' }, capabilities: {} } });
    } catch { finish('Usage client failed.'); }
  });
}
