import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

// Product files are checked together so D125 executors share one integration guard.
const LOCALE_FILES = new Set([
  'install.sh', // Generated installer embeds the shared runtime locale tables and pre-Node locale fallback.
  'install.ps1', // Generated installer embeds the same runtime localization for PowerShell.
  'src/install/present.js', // Installer locale dictionaries, also embedded verbatim in generated scripts.
  'src/install/bootstrap.js', // Standalone installer uses paired arguments to its locale selector.
  'src/install/rules.js', // Shared installer rule translations, embedded verbatim in generated scripts.
  'test/skills.test.js', // Holds the Portuguese vocabulary its own guard searches for, as data.
  'test/install-present.test.js', // Exercises installer translations and locale selection byte for byte.
  'test/fixtures/mcp-golden.json', // Records runtime answers in both supported locales.
  'test/fixtures/d115-mcp-golden.json', // Records account answers in both supported locales.
]);
const PORTUGUESE = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|\b(?:nao|voce|tambem|ajudante|arquivos?|configuracao|escolha|nenhum|nenhuma|antes|depois|falhou|pronto|salvar|indisponivel|padrao|pasta|tarefas|verificacao|comando|ordens|demandas|portugues|corrija|listado|modelos|perfis|rodar|exemplo|usuario|retorna|deve|entao|mensagens|trabalho|salvo|instale|inteiro|demorou|interrompido|ultrapassou|defina|producao|somente|computador|idioma|omitido|entregue|evento)\b/iu; // locale:pt-BR classifier vocabulary
const LOCALE_VALUE = /(['"])(?:pt-BR|pt)\1\s*:\s*(['"`])(?:\\.|(?!\2)[^\\])*?\2/g;
const STRING = /(['"`])(?:\\.|(?!\1)[^\\])*?\1/g;
const MIXED_PAIR = /[a-z.)] \/ [A-Z]/;

function mixedPair(line) {
  // Only quoted text: division and comments are not message pairs. Ignore expressions without string literals.
  return [...line.matchAll(STRING)].some(([text]) => MIXED_PAIR.test(text
    .replace(/\$\{[^'"`{}]*\}/g, '')
    // Reviewed English names: OS entry points and the three exception classes.
    .replaceAll('Dock / Finder', '')
    .replaceAll('UsageError / ConfigError / SetupRefusal', '')));
}
const DOCUMENTATION = /(?:^|\/)(?:docs|changelog\.d)\/|(?:^|\/)(?:README|CHANGELOG)[^/]*$|\.md$|\.pt-BR\./;

function localeTables(source) {
  const key = /(?:['"]pt-BR['"]|['"]pt['"]|\bpt)\s*:\s*(?=[{\[])/g;
  let match;
  while ((match = key.exec(source))) {
    const start = key.lastIndex;
    let depth = 0, quote = null, end = start;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === '\\') end++;
        else if (char === quote) quote = null;
      } else if (/['"`]/.test(char)) quote = char;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) break;
    }
    source = source.slice(0, start) + source.slice(start, end + 1).replace(/[^\n]/g, ' ') + source.slice(end + 1);
  }
  return source;
}

function violations(file, source) {
  if (DOCUMENTATION.test(file) || LOCALE_FILES.has(file)) return [];
  return localeTables(source).split('\n').flatMap((line, index) => {
    if (line.includes('// locale:pt-BR')) return [];
    const english = line.replace(LOCALE_VALUE, '');
    return PORTUGUESE.test(english) || mixedPair(english) ? [`${file}:${index + 1}: ${line.trim()}`] : [];
  });
}

// | Corpus | Must pass | Must refuse |
// | ordinary source | English text and identifiers | accented text and unaccented vocabulary |
// | localization | the translated value or a marked line | Portuguese in the English value |
// | path | documentation and locale goldens | ordinary source, tests and fixtures |
test('English guard exercises allowed and refused examples', () => {
  for (const [file, source, count] of [
    ['src/example.js', 'const ready = "Ready";', 0],
    ['src/example.js', 'const text = "idioma omitido entregue evento";', 1], // locale:pt-BR negative corpus
    ['src/example.js', 'const text = "Ready / Traduzido";', 1], // locale:pt-BR negative corpus
    ['src/example.js', 'const text = "Ready. / Traduzido";', 1], // locale:pt-BR negative corpus
    ['src/example.js', 'const text = "Ready) / Traduzido";', 1], // locale:pt-BR negative corpus
    ['src/example.js', 'const text = "Ready / Traduzido"; // locale:pt-BR', 0], // locale:pt-BR positive corpus
    ['src/example.js', "{ en: 'Ready', 'pt-BR': { text: 'Ready / Traduzido' } }", 0], // locale:pt-BR positive corpus
    ['src/example.js', "{ en: 'Ready', 'pt-BR': 'Ready / Traduzido' }", 0], // locale:pt-BR positive corpus
    ['src/example.js', "{ en: 'Ready / Traduzido', 'pt-BR': 'Ready' }", 1], // locale:pt-BR negative corpus
    ['src/example.js', 'const value = (reset - now) / WEEK;', 0], // locale:pt-BR structural false-positive corpus
    ['src/example.js', 'const text = `tokens: ${Math.ceil(bytes / BYTES_PER_TOKEN)}`;', 0],
    ['src/example.js', 'const text = `answer: ${translate("Ready / Traduzido")}`;', 1], // locale:pt-BR negative corpus
    ['src/example.js', '// Must pass / Must refuse', 0], // locale:pt-BR structural false-positive corpus
    ['src/example.js', 'const text = "macOS Dock / Finder";', 0],
    ['src/example.js', 'const text = "UsageError / ConfigError / SetupRefusal";', 0],
    ['src/example.js', 'const text = "Ready / Traduzido"; const next = "Ready / Outro";', 1], // locale:pt-BR negative corpus
    ['src/install/present.js', 'const text = "Ready / Traduzido";', 0], // locale:pt-BR allowed file corpus
    ['test/example.test.js', '// arquivo pronto', 1], // locale:pt-BR negative corpus
    ['scripts/example.js', '// arquivo pronto', 1], // locale:pt-BR negative corpus
    ['src/example.js', 'throw new Error("Não encontrado");', 1], // locale:pt-BR negative corpus
    ['src/example.js', "{ en: 'Ready', 'pt-BR': 'Pronto' }", 0], // locale:pt-BR positive corpus
    ['src/example.js', "{ en: 'Pronto', 'pt-BR': 'Pronto' }", 1], // locale:pt-BR negative corpus
    ['src/example.js', "{ en: { title: 'Pronto' }, 'pt-BR': { title: 'Pronto' } }", 1], // locale:pt-BR negative corpus
    ['src/example.js', "attempt: { title: 'Pronto' }", 1], // locale:pt-BR negative corpus
    ['src/example.js', "'Pronto'; // locale:pt-BR", 0],
    ['docs/example.md', 'Pronto', 0], // locale:pt-BR documentation corpus
    ['README.md', 'Pronto', 0], // locale:pt-BR documentation corpus
    ['test/example.pt-BR.json', 'Pronto', 0], // locale:pt-BR fixture corpus
  ]) assert.equal(violations(file, source).length, count, `${file}: ${source}`);
});

test('product files contain English outside runtime localization', async () => {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['src', 'test', 'skills', 'adapters', 'scripts', '.github']) await visit(directory);
  for (const entry of await readdir(new URL('../', import.meta.url), { withFileTypes: true })) {
    if (entry.isFile()) files.push(entry.name);
  }
  const found = [];
  for (const file of new Set(files)) {
    if (!/\.(?:[cm]?js|json|sh|ps1|md|txt|ya?ml|toml|[jt]sx?|css|html)$/.test(file)) continue;
    found.push(...violations(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  }
  assert.deepEqual(found, [], `Translate accidental Portuguese or mark the specific locale line:\n${found.join('\n')}`);
});
