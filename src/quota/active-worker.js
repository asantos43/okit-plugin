import { createQuotaPoller } from './active-poller.js';

const [root, client, id, mode] = process.argv.slice(2);
const poller = createQuotaPoller({ root });
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { void poller.stop(); });
try { await poller.readNow(client, id, { force: mode === 'force' }); }
catch { /* The foreground command has already succeeded. */ }
finally { await poller.stop(); }
