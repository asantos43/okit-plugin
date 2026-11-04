/** Expand only multi-account clients, preserving the legacy single-account presentation. */
export function accountRows(rows = []) {
  return rows.flatMap((row) => row.accounts?.length > 1 ? row.accounts.map((account) => ({
    ...row, ...account, account: account.id,
    accountLabel: `${account.label}${account.label === account.id ? '' : ` (${account.id})`}`,
  })) : [row]);
}

export const accountName = (row) => row.accountLabel ? `${row.client}: ${row.accountLabel}` : row.client;

/** The warnings of a row: every one for an account of a list, only the folder warning for a lone account. */
export const shownWarnings = (row) => row.account ? row.warnings ?? [] : (row.warnings ?? []).filter(({ code }) => code === 'config-dir-unregistered');

export function warningText(warning, locale) {
  const pt = locale === 'pt-BR';
  if (warning.code === 'config-dir-unregistered') {
    return pt ? `${warning.variable} aponta para uma pasta que não é da conta default nem de uma conta salva de ${warning.client}: nada é coletado nela. `
      + `Cadastre essa pasta como uma conta ou remova ${warning.variable}.`
      : `${warning.variable} names a folder that is neither the default account's nor a saved account's of ${warning.client}: nothing is collected for it. `
      + `Register that folder as an account or unset ${warning.variable}.`;
  }
  return pt ? `${warning.variable} sobrepõe o login guardado.` : `${warning.variable} overrides the stored login.`;
}
