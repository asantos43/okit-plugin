export function reportText(result, locale = 'en') {
  const pt = locale === 'pt-BR', partial = pt ? 'PARCIAL' : 'PARTIAL';
  const lines = result.events.slice().reverse().map((event) => event.text);
  if (result.mode === 'real') lines.push(...result.reasons);
  if (result.reportsCost === false) {
    lines.push(pt ? 'Este cliente não informa custo em dinheiro.' : 'Money is not reported by this client.');
  } else if (result.mode === 'real' && result.reportsCost !== undefined) {
    lines.push(`${pt ? 'Custo total medido' : 'Measured total cost'}: ${result.costUsd === null
      ? (pt ? 'desconhecido' : 'unknown') : `USD ${result.costUsd}`}`);
  }
  if (result.reportsCost === false || (result.mode === 'real' && result.reportsCost !== undefined)) {
    const maximum = result.limits?.maxTokens ?? (pt ? 'sem limite' : 'unlimited');
    lines.push(`tokens: ${result.tokens} / ${pt ? 'máximo' : 'max'} ${maximum}`);
  }
  for (const demand of result.demands) {
    const cost = result.reportsCost === false ? (pt ? 'não informado' : 'not reported')
      : demand.costKnown ? `USD ${demand.costUsd}` : pt ? 'desconhecido' : 'unknown';
    const verdict = pt ? ({ approved: 'aprovado', failed: 'reprovado', skipped: 'pulado', pending: 'pendente' }[demand.verdict] ?? demand.verdict) : demand.verdict;
    lines.push(`${demand.title}: ${verdict}; ${pt ? 'correções' : 'corrections'}: ${demand.reworkRounds}; ${pt ? 'custo' : 'cost'}: ${cost}.`);
    if (demand.skipReason) lines.push(`${partial}: ${demand.title} — ${demand.skipReason}`);
  }
  if (result.status === 'partial') lines.push(`${partial}: ${pt ? 'alguns trabalhos não puderam ser executados.' : 'some practice tasks could not run.'}`);
  if (result.status === 'pass') lines.push(pt ? 'Comprovado: os arquivos passaram nas verificações e o total incorreto foi corrigido.'
    : 'Proven: the files passed their checks and the wrong total was corrected.');
  return lines.join('\n');
}
