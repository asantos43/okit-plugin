// The rules a setting of the installer (install.* of config.json) is refused by, once. This file imports nothing: the
// presenter (src/install/present.js) embeds it in the standalone install scripts, so the same texts are translated
// there too. INSTALL_SCHEMA (src/config-schema.js) names a rule by its key.
//
// The rules a value is refused by: the English text as raised and the pt-BR text, with %1, %2 for a part that is
// itself a rule. `RULE_REASONS` turns them into the entries of REASONS (src/install/present.js), so the refusal of a
// setting is translated by the same function as every other and its pieces are translated one by one. No rule has a
// colon, because the refusal reads `Invalid install.<key>: <rule>`.
export const RULES = Object.freeze({
  orNull: { en: '%1 or null', pt: '%1 ou nulo', example: 'non-empty text or null' },
  text: { en: 'non-empty text', pt: 'texto não vazio', example: 'non-empty text' },
  line: { en: 'text, which may be empty', pt: 'texto, que pode ser vazio', example: 'text, which may be empty' },
  plain: { en: 'a name without slashes', pt: 'um nome sem barras', example: 'a name without slashes' },
  integer: { en: 'an integer from %1 to %2', pt: 'um inteiro de %1 a %2', example: 'an integer from 1 to 2147483647' },
  boolean: { en: 'true or false', pt: 'verdadeiro ou falso', example: 'true or false' },
  choice: { en: 'one of %1', pt: 'um destes: %1', example: 'one of marketplace, module' },
  address: { en: 'an address that starts with http:// or https:// and has no user name or password', pt: 'um endereço que começa com http:// ou https:// e não tem usuário nem senha', example: 'an address that starts with http:// or https:// and has no user name or password' },
  headerValue: { en: 'text of single-byte characters on one line', pt: 'texto de caracteres de um byte, em uma só linha', example: 'text of single-byte characters on one line' },
  header: { en: 'an HTTP header name', pt: 'um nome de cabeçalho HTTP', example: 'an HTTP header name' },
  variable: { en: 'an environment variable name', pt: 'um nome de variável de ambiente', example: 'an environment variable name' },
  list: { en: 'a list of %1', pt: 'uma lista de %1', example: 'a list of non-empty text' },
  filledList: { en: 'a non-empty list of %1', pt: 'uma lista não vazia de %1', example: 'a non-empty list of non-empty text' },
  object: { en: 'an object', pt: 'um objeto', example: 'an object' },
  objectOf: { en: 'an object whose values are %1', pt: 'um objeto cujos valores são %1', example: 'an object whose values are non-empty text' },
  dataRoot: { en: 'a non-empty list, an environment variable name or null and then folder names', pt: 'uma lista não vazia, um nome de variável de ambiente ou nulo e depois nomes de pastas', example: 'a non-empty list, an environment variable name or null and then folder names' },
  recordName: { en: 'a file name containing {client}', pt: 'um nome de arquivo que contém {client}', example: 'a file name containing {client}' },
  xdgPair: { en: 'xdgEnv and xdgParts together, or neither', pt: 'xdgEnv e xdgParts juntos, ou nenhum dos dois', example: 'xdgEnv and xdgParts together, or neither' },
  differs: { en: 'a text different from install.path.begin', pt: 'um texto diferente de install.path.begin', example: 'a text different from install.path.begin' },
  knownShell: { en: 'the name of a shell listed in install.path.shells', pt: 'o nome de um shell listado em install.path.shells', example: 'the name of a shell listed in install.path.shells' },
  mcpName: { en: 'a name that starts with a letter or a digit and holds only letters, digits, dots, dashes and underscores', pt: 'um nome que começa com uma letra ou um dígito e só tem letras, dígitos, pontos, traços e sublinhados', example: 'a name that starts with a letter or a digit and holds only letters, digits, dots, dashes and underscores' },
  mcpServer: { en: 'a relative path with forward slashes and no .. segment', pt: 'um caminho relativo com barras normais e sem segmento ..', example: 'a relative path with forward slashes and no .. segment' },
  mcpScope: { en: 'a scope only for a client whose own mcp commands take one', pt: 'um escopo só para um cliente cujos comandos mcp aceitam um', example: 'a scope only for a client whose own mcp commands take one' },
});

export const fillRule = (template, parts) => template.replace(/%(\d)/g, (_, index) => parts[Number(index) - 1]);

/** The entries `[pattern, pt-BR text, example]` of REASONS for the rules above (the nullable one first: it wraps the others). */
export const RULE_REASONS = Object.freeze(Object.values(RULES).map(({ en, pt, example }) => {
  const source = en.split(/(%\d)/).map((part, index) => (index % 2 ? '(.+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return [new RegExp(`^${source}$`), pt.replace(/%(\d)/g, '$$$1'), example];
}));
