import { localizeReason } from '../../install/present.js';

// The bilingual phrases of the demo (src/smoke/demo/driver.js, src/smoke/demo/index.js): the side of the language of
// the run is shown. Any other text is not a phrase of ours: it is a path, a message of the system or a name, and it is
// shown whole, byte for byte. The delimiter " / " only separates the languages of a phrase of this table.
const BILINGUAL = new Map([
  ['Could not check the files. / Não foi possível conferir os arquivos.', 'Não foi possível conferir os arquivos.'],
  ['Provide a helper launcher. / Informe como iniciar o ajudante.', 'Informe como iniciar o ajudante.'],
  ['Set smoke.maxTokens to a positive whole number before starting. / Defina smoke.maxTokens como um número inteiro positivo antes de começar.',
    'Defina smoke.maxTokens como um número inteiro positivo antes de começar.'],
  ['Work interrupted. / Trabalho interrompido.', 'Trabalho interrompido.'],
  ['Work took too long. / O trabalho demorou demais.', 'O trabalho demorou demais.'],
  ['The helper exceeded the text allowance. / O ajudante ultrapassou o limite de texto.', 'O ajudante ultrapassou o limite de texto.'],
  ['The helper wrote outside the allowed files. / O ajudante escreveu fora dos arquivos permitidos.', 'O ajudante escreveu fora dos arquivos permitidos.'],
  ['The output must be a regular file of at most 128 KiB. / A saída deve ser um arquivo comum de até 128 KiB.', 'A saída deve ser um arquivo comum de até 128 KiB.'],
  ['The review answer could not be read. / Não foi possível ler a resposta da revisão.', 'Não foi possível ler a resposta da revisão.'],
  ['PATH is missing from the environment, so the helper cannot be found. / O PATH não está no ambiente, então o ajudante não pode ser encontrado.',
    'O PATH não está no ambiente, então o ajudante não pode ser encontrado.'],
]);

/** The side of the language of the run of a phrase of ours; any other text is shown whole. */
const sideOf = (text, locale) => {
  const known = BILINGUAL.get(text);
  if (known === undefined) return text;
  return locale === 'pt-BR' ? known : text.slice(0, text.indexOf(' / '));
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
    if (demand.skipReason) lines.push(`${partial}: ${demand.title} — ${reasonText(demand.skipReason, locale)}`);
  }
  if (result.status === 'partial') lines.push(`${partial}: ${pt ? 'alguns trabalhos não puderam ser executados.' : 'some practice tasks could not run.'}`);
  if (result.status === 'pass') lines.push(pt ? 'Comprovado: os arquivos passaram nas verificações e o total incorreto foi corrigido.'
    : 'Proven: the files passed their checks and the wrong total was corrected.');
  return lines.join('\n');
}
