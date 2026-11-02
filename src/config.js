// The configuration of a root: the schema of its entries, the value each one has and the change of
// one of them. The logic of the settings lives in `src/core/config.js`, where the operations of the
// registry call it. There is no printer of the command line any more: the assistant reads the
// values through the tools of the server.

export { CONFIG_SCHEMA } from './config-schema.js';
export { fillMissingConfig, resolveEntry } from './core/config.js';
