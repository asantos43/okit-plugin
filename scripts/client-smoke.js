// Developer entry for the in-client smoke scenario.
import { runClientSmoke } from '../src/smoke/client.js';

const result = await runClientSmoke(process.argv.slice(2));
process.exitCode = result.code;
