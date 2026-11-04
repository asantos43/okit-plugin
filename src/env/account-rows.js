/** Expand only multi-account clients, preserving the legacy single-account presentation. */
export function accountRows(rows = []) {
  return rows.flatMap((row) => row.accounts?.length > 1 ? row.accounts.map((account) => ({
    ...row, ...account, account: account.id,
    accountLabel: `${account.label}${account.label === account.id ? '' : ` (${account.id})`}`,
  })) : [row]);
}

export const accountName = (row) => row.accountLabel ? `${row.client}: ${row.accountLabel}` : row.client;

export function warningText(warning, locale) {
  return locale === 'pt-BR' ? `${warning.variable} sobrepõe o login guardado.`
    : `${warning.variable} overrides the stored login.`;
}
