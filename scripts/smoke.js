// Developer entry for the offline smoke checks; the installer imports its payload's runner.
import { runSmoke } from '../src/smoke.js';

const result = await runSmoke(process.argv.slice(2));
process.exitCode = result.code;
