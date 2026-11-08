// Who holds a piece of work: the same client and the same session. Kept apart from inbox.js so
// modules the installer imports can use it without pulling the whole inbox (and its refusals).
export const sameHolder = (a, b) => a?.client === b?.client && a?.session === b?.session;
