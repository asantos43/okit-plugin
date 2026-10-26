// Saved choices are configuration evidence, never proof of account access.
export function setupPending(config) {
  const done = config?.setup?.done;
  return done === undefined || done === null || done === false;
}
