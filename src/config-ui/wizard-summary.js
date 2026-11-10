// Plain-language summaries of a plan and of a follow-up preview, for the install wizard (D156).
// Both functions are self-contained on purpose: the browser bundle serializes them with `toString()`.
// They only read data and return data; the wizard draws the result with `textContent`.

/** What is worth showing to a person: not the staging, scratch, temporary or quota-slot bookkeeping of the installer. */
export function planSummary(plan) {
  const hidden = /^(directory|staging|download-staging|module-staging|payload|payload-tree|symlink|backup-file|selfcheck-.*|quota-.*|.*-temporary|.*-staging)$/;
  const fixture = /(^|[\\/])test[\\/]fixtures[\\/]/;
  const rows = new Map();
  const row = (client) => {
    if (!rows.has(client)) rows.set(client, { client, files: 0, items: [], seen: new Set() });
    return rows.get(client);
  };
  for (const entry of plan?.clients ?? []) row(entry.client);
  for (const item of plan?.mutations ?? []) {
    const target = row(item.client ?? '');
    if (typeof item.path === 'string' && fixture.test(item.path)) continue;
    if (item.kind === 'payload') { target.files++; continue; }
    if (item.kind === 'payload-tree') { target.files = Math.max(target.files, 1); target.packaged = true; continue; }
    if (hidden.test(String(item.kind)) || typeof item.path !== 'string') continue;
    const key = `${item.kind}\u0000${item.path}`;
    if (target.seen.has(key)) continue;
    target.seen.add(key); target.items.push({ kind: item.kind, path: item.path });
  }
  const clients = [...rows.values()].filter((value) => value.client || value.items.length)
    .map(({ seen: _seen, ...value }) => ({ ...value, shown: value.items.slice(0, 6), more: Math.max(0, value.items.length - 6) }));
  const total = clients.reduce((sum, value) => sum + value.items.length + (value.files ? 1 : 0), 0);
  return { clients, total, conflicts: (plan?.conflicts ?? []).length };
}

/** A follow-up preview (models, panel, execution policy) as short lines of data: `{ kind, a, b, c }`. */
export function previewSummary(preview) {
  if (!preview || typeof preview !== 'object') return [];
  if (preview.kind === 'setup') {
    const byClass = new Map();
    for (const change of preview.changes ?? []) {
      const [, , cls, key] = String(change.path).split('.');
      const entry = byClass.get(cls) ?? { kind: 'profile', a: cls, b: '', c: '' };
      if (key === 'model') entry.b = String(change.value); else entry.c = String(change.value);
      byClass.set(cls, entry);
    }
    return [...byClass.values()];
  }
  if (preview.kind === 'panel') {
    return preview.skipped ? [{ kind: 'panelSkipped' }]
      : (preview.writes ?? []).filter((item) => !/-temporary$/.test(String(item.kind)))
        .map((item) => ({ kind: item.kind, a: item.path ?? item.scope ?? '' }));
  }
  if (preview.kind === 'policy') {
    return preview.skipped ? [{ kind: 'policySkipped' }] : [{ kind: 'policy', a: String(preview.scope), b: String(preview.after) }];
  }
  return [];
}
