import { localizeReason } from '../../install/present.js';

// Known demo reasons are translated for the run. Paths, system messages and names stay byte for byte.
const BILINGUAL = new Map([
  ['Could not check the files.', 'Não foi possível conferir os arquivos.'], // locale:pt-BR
  ['Provide a helper launcher.', 'Informe como iniciar o ajudante.'], // locale:pt-BR
  ['Set smoke.maxTokens to a positive whole number before starting.',
    'Defina smoke.maxTokens como um número inteiro positivo antes de começar.'], // locale:pt-BR
  ['Work interrupted.', 'Trabalho interrompido.'], // locale:pt-BR
  ['Work took too long.', 'O trabalho demorou demais.'], // locale:pt-BR
  ['The helper exceeded the text allowance.', 'O ajudante ultrapassou o limite de texto.'], // locale:pt-BR
  ['The helper wrote outside the allowed files.', 'O ajudante escreveu fora dos arquivos permitidos.'], // locale:pt-BR
  ['The output must be a regular file of at most 128 KiB.', 'A saída deve ser um arquivo comum de até 128 KiB.'], // locale:pt-BR
  ['The review answer could not be read.', 'Não foi possível ler a resposta da revisão.'], // locale:pt-BR
  ['PATH is missing from the environment, so the helper cannot be found.',
    'O PATH não está no ambiente, então o ajudante não pode ser encontrado.'], // locale:pt-BR
]);

/** The side of the language of the run of a phrase of ours; any other text is shown whole. */
const sideOf = (text, locale) => {
  const english = text.split(' / ')[0];
  const known = BILINGUAL.get(english);
  if (known === undefined) return text;
  // Saved runs may still contain an older paired reason; match the entire known pair.
  if (text !== english && text !== `${english} / ${known}`) return text;
  return locale === 'pt-BR' ? known : english;
};

/**
 * The reason as the language of the run shows it: the side of a bilingual phrase (the way the driver writes them)
 * and then the catalog of the reasons (REASONS). A reason the catalog does not know stays as it was raised.
 */
const reasonText = (reason, locale) => localizeReason(sideOf(reason, locale), locale);

export function reportText(result, locale = 'en') {
  const pt = locale === 'pt-BR', partial = pt ? 'PARCIAL' : 'PARTIAL';
  const lines = result.events.slice().reverse().map((event) => event.text);
  // The reasons of a failed demand are told in the language of the run (REASONS).
  if (result.mode === 'real') lines.push(...result.reasons.map((reason) => reasonText(reason, locale)));
  if (result.reportsCost === false) {
    lines.push(pt ? 'Este cliente não informa custo em dinheiro.' : 'Money is not reported by this client.'); // locale:pt-BR
  } else if (result.mode === 'real' && result.reportsCost !== undefined) {
    lines.push(`${pt ? 'Custo total medido' : 'Measured total cost'}: ${result.costUsd === null
      ? (pt ? 'desconhecido' : 'unknown') : `USD ${result.costUsd}`}`);
  }
  if (result.reportsCost === false || (result.mode === 'real' && result.reportsCost !== undefined)) {
    const maximum = result.limits?.maxTokens ?? (pt ? 'sem limite' : 'unlimited');
    lines.push(`tokens: ${result.tokens} / ${pt ? 'máximo' : 'max'} ${maximum}`); // locale:pt-BR
  }
  for (const demand of result.demands) {
    const cost = result.reportsCost === false ? (pt ? 'não informado' : 'not reported') // locale:pt-BR
      : demand.costKnown ? `USD ${demand.costUsd}` : pt ? 'desconhecido' : 'unknown';
    const verdict = pt ? ({ approved: 'aprovado', failed: 'reprovado', skipped: 'pulado', pending: 'pendente' }[demand.verdict] ?? demand.verdict) : demand.verdict;
    lines.push(`${demand.title}: ${verdict}; ${pt ? 'correções' : 'corrections'}: ${demand.reworkRounds}; ${pt ? 'custo' : 'cost'}: ${cost}.`); // locale:pt-BR
    if (demand.skipReason) lines.push(`${partial}: ${demand.title} — ${reasonText(demand.skipReason, locale)}`);
  }
  if (result.status === 'partial') lines.push(`${partial}: ${pt ? 'alguns trabalhos não puderam ser executados.' : 'some practice tasks could not run.'}`); // locale:pt-BR
  if (result.status === 'pass') lines.push(pt ? 'Comprovado: os arquivos passaram nas verificações e o total incorreto foi corrigido.' // locale:pt-BR
    : 'Proven: the files passed their checks and the wrong total was corrected.');
  return lines.join('\n');
}
