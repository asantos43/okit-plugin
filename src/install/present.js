// The one place every installer message goes through (install, update,
// uninstall). One language per run, chosen by the CLI's own rule (--locale,
// then the saved `language`, then the default), and the same line structure on
// every system: only paths and the PATH hint differ.
import { LOCALES, CONFIG_MESSAGES } from '../profiles.js';
import { RULE_REASONS } from './rules.js';
// The exit-code policy travels with the presenter, so the standalone scripts (which embed this file) have it too.
export { exitCodeFor, kindOf } from './exit.js';

const SYSTEMS = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
const STATUS_WIDTH = 9;
const LABEL_WIDTH = 28;

// {name} placeholders; the 'pt-BR' side is Brazilian Portuguese.
export const TEXTS = Object.freeze({
  header: { en: '{package} {version} for {client} ({system} {arch})', 'pt-BR': '{package} {version} para {client} ({system} {arch})' },
  get: { en: 'Download and verify', 'pt-BR': 'Baixar e verificar' },
  local: { en: 'Local package', 'pt-BR': 'Pacote local' },
  backup: { en: 'Back up your files', 'pt-BR': 'Copiar seus arquivos' },
  files: { en: 'Install files', 'pt-BR': 'Instalar arquivos' },
  register: { en: 'Register in {client}', 'pt-BR': 'Registrar no {client}' },
  link: { en: 'Command and PATH', 'pt-BR': 'Comando e PATH' },
  quota: { en: 'Quota recording', 'pt-BR': 'Registro de cota' },
  smoke: { en: 'Check the install', 'pt-BR': 'Verificar a instalação' },
  rollback: { en: 'Restore previous version', 'pt-BR': 'Restaurar versão anterior' },
  unregister: { en: 'Unregister from {client}', 'pt-BR': 'Remover registro do {client}' },
  unlink: { en: 'Remove command and PATH', 'pt-BR': 'Remover comando e PATH' },
  remove: { en: 'Remove files', 'pt-BR': 'Remover arquivos' },
  models: { en: 'Models', 'pt-BR': 'Modelos' },
  kit: { en: 'Kit (optional)', 'pt-BR': 'Kit (opcional)' },
  upToDate: { en: 'Up to date', 'pt-BR': 'Em dia' },
  newVersion: { en: 'New version available', 'pt-BR': 'Nova versão disponível' },
  status: {
    ok: { en: 'ok', 'pt-BR': 'ok' }, skipped: { en: 'skipped', 'pt-BR': 'pulado' },
    plan: { en: 'would', 'pt-BR': 'faria' }, failed: { en: 'failed', 'pt-BR': 'falhou' },
    info: { en: '-', 'pt-BR': '-' },
  },
  checked: { en: '{asset} (SHA-256 checked)', 'pt-BR': '{asset} (SHA-256 conferido)' },
  shaNote: { en: 'SHA-256 detects altered bytes; it does not authenticate the source.', 'pt-BR': 'O SHA-256 detecta bytes alterados; não autentica a origem.' },
  fallback: { en: 'No stable release yet: using the pre-release {version}.', 'pt-BR': 'Ainda não há versão estável: usando a pré-versão {version}.' },
  localSource: { en: '{version} (local folder, not downloaded)', 'pt-BR': '{version} (pasta local, sem download)' },
  warning: { en: 'warning', 'pt-BR': 'aviso' },
  done: { en: 'Done.', 'pt-BR': 'Pronto.' },
  next: { en: 'Next:', 'pt-BR': 'Próximo:' },
  failedAt: { en: 'Failed at {step}: {reason}', 'pt-BR': 'Falhou em {step}: {reason}' },
  refused: { en: 'Refused: {reason}', 'pt-BR': 'Recusado: {reason}' },
  nextLabel: { en: 'Next', 'pt-BR': 'O que fazer' },
  nextOpen: { en: 'open a new terminal', 'pt-BR': 'abra um terminal novo' },
  nextRestart: { en: 'restart {client}', 'pt-BR': 'reinicie o {client}' },
  nextRun: { en: 'run: {command}', 'pt-BR': 'rode: {command}' },
  nextHere: { en: 'in this terminal instead: {command}', 'pt-BR': 'neste terminal, rode antes: {command}' },
  yesNo: { en: ['y', 'n'], 'pt-BR': ['s', 'n'] },
  plain: { en: '{asset}', 'pt-BR': '{asset}' },
  stop: { en: 'Stop the background process', 'pt-BR': 'Parar o processo em segundo plano' },
  quotaUndo: { en: 'Restore {client} settings', 'pt-BR': 'Restaurar ajustes do {client}' },
  removeKeep: { en: '{path} (your settings are kept)', 'pt-BR': '{path} (seus ajustes foram mantidos)' },
  removePurge: { en: '{path} (settings removed too)', 'pt-BR': '{path} (ajustes removidos também)' },
  unlinkDone: { en: '{command} removed', 'pt-BR': '{command} removido' },
  unlinkShared: { en: '{command} kept for the other client', 'pt-BR': '{command} mantido para o outro cliente' },
  clientChoose: { en: 'Which client do you want to install for?', 'pt-BR': 'Para qual cliente você quer instalar?' },
  clientDetected: { en: 'found', 'pt-BR': 'encontrado' },
  clientAsk: { en: 'Number (1,3) or all: ', 'pt-BR': 'Número (1,3) ou all: ' },
  clientNoTty: { en: 'Without a terminal to ask in, choose a client with --client.', 'pt-BR': 'Sem terminal para perguntar, escolha o cliente com --client.' },
  linkOff: { en: 'not created (--no-link)', 'pt-BR': 'não criado (--no-link)' },
  linkUser: { en: '{command}  (added to your user PATH)', 'pt-BR': '{command}  (adicionado ao PATH do seu usuário)' },
  linkProfile: { en: '{command}  (PATH set in {where})', 'pt-BR': '{command}  (PATH ajustado em {where})' },
  linkExisting: { en: '{command}  (already on your PATH)', 'pt-BR': '{command}  (já está no seu PATH)' },
  linkManual: { en: '{command}  (not on your PATH yet: add {where})', 'pt-BR': '{command}  (ainda fora do PATH: adicione {where})' },
  pathCheck: { en: 'PATH check', 'pt-BR': 'Verificação do PATH' },
  pathMissing: { en: 'not found on PATH yet', 'pt-BR': 'ainda não encontrado no PATH' },
  foreignLink: { en: 'Left alone, it is not ours: {path}', 'pt-BR': 'Deixado como está, não é nosso: {path}' },
  linkConflict: { en: 'The existing command at {path} is not the plugin command. Rename or remove it, or choose another link directory in install.linkDirectory.', 'pt-BR': 'O comando existente em {path} não é o comando do plugin. Renomeie ou remova esse comando, ou escolha outra pasta em install.linkDirectory.' },
  registerMarketplace: { en: 'marketplace and plugin', 'pt-BR': 'marketplace e plugin' },
  registerMarketplaceManual: { en: 'marketplace added; open /plugins to install the plugin', 'pt-BR': 'marketplace adicionado; abra /plugins para instalar o plugin' },
  registerRemoved: { en: 'marketplace and plugin removed', 'pt-BR': 'marketplace e plugin removidos' },
  registerModule: { en: 'module and skills', 'pt-BR': 'módulo e skills' },
  registerMissing: { en: '{executable} not found, so nothing was registered', 'pt-BR': '{executable} não encontrado, então nada foi registrado' },
  registerMissingNext: { en: 'Install it, then run:', 'pt-BR': 'Instale e depois rode:' },
  registerModuleNext: { en: 'Then install the module {path} and its skills.', 'pt-BR': 'Depois instale o módulo {path} e suas skills.' },
  roleUnsupported: { en: 'Role delivery unavailable', 'pt-BR': 'Entrega de papel indisponível' },
  keptModule: { en: 'Your edited module was kept: {path}', 'pt-BR': 'Seu módulo editado foi mantido: {path}' },
  keptSkill: { en: 'Your edited skill was kept: {path}', 'pt-BR': 'Sua skill editada foi mantida: {path}' },
  statuslineExplain: { en: 'Quota recording lets the Claude Code status bar record your plan usage. Your current bar keeps working.', 'pt-BR': 'O registro de cota faz a barra de status do Claude Code anotar o uso do seu plano. A barra atual continua funcionando.' },
  statuslineExplain2: { en: 'It changes one file, with a backup: {path}', 'pt-BR': 'Altera um arquivo, com cópia de segurança: {path}' },
  statuslineAsk: { en: 'Record quota?', 'pt-BR': 'Registrar a cota?' },
  statuslineDone: { en: 'already on', 'pt-BR': 'já ativo' },
  statuslineDeclined: { en: 'not changed', 'pt-BR': 'sem alteração' },
  statuslineHow: { en: 'off. To turn it on: {command}', 'pt-BR': 'desligado. Para ligar: {command}' },
  statuslineFile: { en: 'Settings file', 'pt-BR': 'Arquivo de ajustes' },
  statuslineAdd: { en: 'Add quota recording', 'pt-BR': 'Adicionar registro de cota' },
  statuslineKeep: { en: 'Keep current bar', 'pt-BR': 'Manter a barra atual' },
  statuslineNone: { en: '(none)', 'pt-BR': '(nenhuma)' },
  statuslineKept: { en: 'Your later edits were kept; only our bar was removed.', 'pt-BR': 'Suas edições posteriores foram mantidas; só a nossa barra foi removida.' },
  statuslineError: { en: 'Cannot read or change the Claude settings; check the file and its permissions.', 'pt-BR': 'Não foi possível ler ou alterar os ajustes do Claude; confira o arquivo e suas permissões.' },
  kitBroken: { en: 'broken ({path}; {reason})', 'pt-BR': 'com defeito ({path}; {reason})' },
  kitAbsent: { en: 'not found. {hint}', 'pt-BR': 'não encontrado. {hint}' },
  kitInstalled: { en: 'kit: installed ({path}; {version}). {overlap}', 'pt-BR': 'kit: instalado ({path}; {version}). {overlap}' },
  kitLineAbsent: { en: 'kit: absent. {hint}', 'pt-BR': 'kit: ausente. {hint}' },
  kitLineIgnored: { en: 'kit: absent (plugin executable ignored). {hint}', 'pt-BR': 'kit: ausente (executável do plugin ignorado). {hint}' },
  kitLineBroken: { en: 'kit: broken ({path}; {reason})', 'pt-BR': 'kit: com defeito ({path}; {reason})' },
  kitOverlap: { en: 'See docs/maintainers/ARCHITECTURE.md#kit-and-plugin-overlap-d1 for overlap rules.', 'pt-BR': 'Veja docs/maintainers/ARCHITECTURE.md#kit-and-plugin-overlap-d1 para as regras de sobreposição.' },
  kitHint: { en: 'Needed only for the orchestration workflow: INSTALL.md#orchestration-kit', 'pt-BR': 'Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração' },
  modelsExplain: { en: 'Setup chooses the models for simple, everyday and hard tasks. You can redo it later with {command} setup.', 'pt-BR': 'O setup escolhe os modelos para tarefas simples, do dia a dia e difíceis. Você pode refazer depois com {command} setup.' },
  modelsAsk: { en: 'Choose the models now?', 'pt-BR': 'Escolher os modelos agora?' },
  modelsPending: { en: 'not set yet. Run: {command} setup', 'pt-BR': 'ainda não definidos. Rode: {command} setup' },
  modelsDeclined: { en: 'not set. Run when you want: {command} setup', 'pt-BR': 'não definidos. Rode quando quiser: {command} setup' },
  modelsSaved: { en: '{models} saved', 'pt-BR': '{models} salvos' },
  modelsSave: { en: 'Save these model settings?', 'pt-BR': 'Salvar estas configurações de modelo?' },
  modelsPlan: { en: 'These models will be saved:', 'pt-BR': 'Estes modelos serão salvos:' },
  dryRunDone: { en: 'Dry run: nothing was changed.', 'pt-BR': 'Simulação: nada foi alterado.' },
  policy: { en: 'PowerShell scripts', 'pt-BR': 'Scripts do PowerShell' },
  policyExplain: { en: 'Windows blocks PowerShell scripts for your user. This sets RemoteSigned for your user only (local scripts run; downloaded ones must be signed).', 'pt-BR': 'O Windows bloqueia scripts do PowerShell para o seu usuário. Isto define RemoteSigned só para o seu usuário (scripts locais rodam; os baixados precisam de assinatura).' },
  policyUndo: { en: 'To undo: {command}', 'pt-BR': 'Para desfazer: {command}' },
  policyAsk: { en: 'Allow PowerShell scripts for your user?', 'pt-BR': 'Permitir scripts do PowerShell para o seu usuário?' },
  policySet: { en: 'allowed for your user (RemoteSigned)', 'pt-BR': 'permitidos para o seu usuário (RemoteSigned)' },
  policyHow: { en: 'blocked. To allow: {command}', 'pt-BR': 'bloqueados. Para permitir: {command}' },
  policyDeclined: { en: 'not changed. To allow later: {command}', 'pt-BR': 'sem alteração. Para permitir depois: {command}' },
  policyGroup: { en: 'blocked by a group policy, so it was left alone', 'pt-BR': 'bloqueados por uma política de grupo, então nada foi alterado' },
  policyFailed: { en: 'could not change it: {reason}', 'pt-BR': 'não foi possível alterar: {reason}' },
  nextCheck: { en: 'check the options and try again', 'pt-BR': 'confira as opções e tente de novo' },
  nextRetry: { en: 'fix the cause and run the same command again', 'pt-BR': 'corrija a causa e rode o mesmo comando de novo' },
  nextRollback: { en: 'to return to the retained version: {command} update --rollback', 'pt-BR': 'para voltar à versão guardada: {command} update --rollback' },
  selfcheck: { en: 'Self-check ({client})', 'pt-BR': 'Autoverificação ({client})' },
  selfcheckVersion: { en: 'Version', 'pt-BR': 'Versão' },
  selfcheckCommand: { en: 'Command', 'pt-BR': 'Comando' },
  selfcheckStatusline: { en: 'Status bar', 'pt-BR': 'Barra de status' },
  selfcheckHook: { en: 'Session hook', 'pt-BR': 'Hook de sessão' },
  selfcheckPath: { en: 'Command on PATH', 'pt-BR': 'Comando no PATH' },
  selfcheckOnPath: { en: 'on the PATH of this terminal', 'pt-BR': 'no PATH deste terminal' },
  selfcheckCollector: { en: 'Quota reading', 'pt-BR': 'Leitura de cota' },
  selfcheckPassed: { en: '{count} checks passed', 'pt-BR': '{count} verificações passaram' },
  selfcheckBroken: { en: 'installed but not working: {failed} of {total} checks failed', 'pt-BR': 'instalado, mas não funciona: {failed} de {total} verificações falharam' },
  selfcheckFix: { en: 'Fix: {fix}', 'pt-BR': 'Correção: {fix}' },
  selfcheckError: { en: 'the check itself could not run', 'pt-BR': 'a própria verificação não pôde rodar' },
  selfcheckFixError: { en: 'Run the installer again: {again}', 'pt-BR': 'Rode o instalador de novo: {again}' },
  selfcheckVersionRecord: { en: 'the install record says {found}, expected {expected}', 'pt-BR': 'o registro da instalação diz {found}, esperado {expected}' },
  selfcheckVersionPackage: { en: 'the installed package.json says {found}, expected {expected}', 'pt-BR': 'o package.json instalado diz {found}, esperado {expected}' },
  selfcheckUnreadable: { en: 'cannot read {path}', 'pt-BR': 'não é possível ler {path}' },
  selfcheckFixVersion: { en: 'Install again: {again}', 'pt-BR': 'Instale de novo: {again}' },
  selfcheckFound: { en: 'found', 'pt-BR': 'encontrado' },
  selfcheckNotFound: { en: '{shell} does not find {command} ({why})', 'pt-BR': 'o {shell} não encontra {command} ({why})' },
  selfcheckExit: { en: 'exit code {code}', 'pt-BR': 'código de saída {code}' },
  selfcheckTimeout: { en: 'no answer in {ms} ms', 'pt-BR': 'sem resposta em {ms} ms' },
  selfcheckFixCommand: { en: 'Add {bin} to the PATH of {shell}, then run: {again}', 'pt-BR': 'Coloque {bin} no PATH do {shell} e rode: {again}' },
  selfcheckElsewhere: { en: '{shell} finds {command} at {found}, not in {bin}', 'pt-BR': 'o {shell} encontra {command} em {found}, não em {bin}' },
  selfcheckNothing: { en: '(nothing)', 'pt-BR': '(nada)' },
  selfcheckFixElsewhere: { en: 'Remove or rename {found}, or put {bin} before it on the PATH of {shell}, then run: {again}', 'pt-BR': 'Remova ou renomeie {found}, ou ponha {bin} antes dele no PATH do {shell} e rode: {again}' },
  selfcheckFoundLogin: { en: 'found, also at login', 'pt-BR': 'encontrado, também no login' },
  selfcheckLoginFail: { en: 'a new {shell} terminal will not find {command} ({why})', 'pt-BR': 'um terminal novo do {shell} não achará {command} ({why})' },
  selfcheckLoginOther: { en: 'it finds {found}, not a file of {bin}', 'pt-BR': 'ele acha {found}, e não um arquivo de {bin}' },
  selfcheckFixLogin: { en: 'In {file}, put this line before anything that stops the file with `return`, fix the error of any command that fails (for example under `set -e`), and remove any `exit` from that file (a login file must not exit), then run: {again} (the line: {line})', 'pt-BR': 'Em {file}, ponha esta linha antes de qualquer coisa que pare esse arquivo com `return`, corrija o erro de qualquer comando que falhe (por exemplo sob `set -e`), e remova qualquer `exit` desse arquivo (um arquivo de login não pode sair), e rode: {again} (a linha: {line})' },
  selfcheckFixLoginMissing: { en: 'Put this line in {file}, the file {shell} reads at login, before anything that stops the file with `return`, fix the error of any command that fails (for example under `set -e`), and remove any `exit` from that file (a login file must not exit), then run: {again} (the line: {line})', 'pt-BR': 'Ponha esta linha em {file}, o arquivo que o {shell} lê no login, antes de qualquer coisa que pare esse arquivo com `return`, corrija o erro de qualquer comando que falhe (por exemplo sob `set -e`), e remova qualquer `exit` desse arquivo (um arquivo de login não pode sair), e rode: {again} (a linha: {line})' },
  selfcheckShellMissing: { en: '{shell} is not installed', 'pt-BR': '{shell} não está instalado' },
  selfcheckNoShell: { en: 'no shell could run the check ({shells})', 'pt-BR': 'nenhum shell pôde fazer a verificação ({shells})' },
  selfcheckFixNoShell: { en: 'Install a POSIX shell (sh or bash; on Windows, Git for Windows), then run: {again}', 'pt-BR': 'Instale um shell POSIX (sh ou bash; no Windows, o Git for Windows) e rode: {again}' },
  selfcheckOff: { en: 'not registered', 'pt-BR': 'não registrado' },
  selfcheckHookForeign: { en: 'the session hook is not exactly ours (it has more in it), so it was not run', 'pt-BR': 'o hook de sessão não é exatamente o nosso (tem mais coisa nele), então não foi executado' },
  selfcheckHookNode: { en: 'the session hook was registered with another node (install again to refresh it), so it was not run', 'pt-BR': 'o hook de sessão foi registrado com outro node (instale de novo para atualizá-lo), então não foi executado' },
  selfcheckUnlinked: { en: 'installed without a link, so the check cannot tell which command the status bar names; it was not run', 'pt-BR': 'instalado sem link, então a verificação não sabe qual comando a barra de status nomeia; ela não foi executada' },
  selfcheckForeign: { en: 'the status bar is not ours, so it was not run', 'pt-BR': 'a barra de status não é nossa, então não foi executada' },
  selfcheckNotUsed: { en: 'not used by this client', 'pt-BR': 'não usado por este cliente' },
  selfcheckRan: { en: 'ran, exit code 0', 'pt-BR': 'rodou, código de saída 0' },
  selfcheckStatuslineFailed: { en: 'the status bar command failed ({why})', 'pt-BR': 'o comando da barra de status falhou ({why})' },
  selfcheckHookFailed: { en: 'the session hook failed ({why})', 'pt-BR': 'o hook de sessão falhou ({why})' },
  selfcheckFixStatusline: { en: 'Write the status bar command again: {again} --statusline (settings file: {path})', 'pt-BR': 'Grave o comando da barra de status de novo: {again} --statusline (arquivo de ajustes: {path})' },
  selfcheckFixHook: { en: 'Write the hook again: {again} (settings file: {path})', 'pt-BR': 'Grave o hook de novo: {again} (arquivo de ajustes: {path})' },
  selfcheckCollectorOk: { en: 'reading written', 'pt-BR': 'leitura gravada' },
  selfcheckCollectorMissing: { en: 'the status bar ran but wrote no reading', 'pt-BR': 'a barra de status rodou, mas não gravou leitura' },
  selfcheckCollectorSkipped: { en: 'not checked: the status bar did not run', 'pt-BR': 'não verificado: a barra de status não rodou' },
  selfcheckPathFail: { en: '{bin} is not on your PATH and no profile adds it, so a new terminal will not find {command}', 'pt-BR': '{bin} não está no seu PATH e nenhum perfil o adiciona, então um terminal novo não achará {command}' },
  selfcheckFixPath: { en: 'Add this line to your shell profile, then open a new terminal: {line}', 'pt-BR': 'Adicione esta linha ao perfil do seu shell e abra um terminal novo: {line}' },
});

// Reasons raised by the installer in English: [pattern, pt-BR text, an example].
// A pattern matches the whole reason and its captures fill $1..; a reason that
// matches none is shown as raised. The tests walk this table and the raise sites.
export const REASONS = [
  [/^No installation record found$/, 'Nenhuma instalação encontrada', 'No installation record found'],
  [/^No previous version retained$/, 'Nenhuma versão anterior foi guardada', 'No previous version retained'],
  [/^Previous version belongs to another client$/, 'A versão anterior é de outro cliente', 'Previous version belongs to another client'],
  [/^Unsupported system or architecture$/, 'Sistema ou arquitetura sem suporte', 'Unsupported system or architecture'],
  [/^Smoke proof failed$/, 'A verificação da instalação falhou', 'Smoke proof failed'],
  [/^Download timeout exceeded$/, 'O download demorou demais', 'Download timeout exceeded'],
  [/^--purge requires --yes and no remaining clients$/, '--purge exige --yes e nenhum cliente restante', '--purge requires --yes and no remaining clients'],
  [/^--purge requires no remaining clients$/, '--purge exige que não reste nenhum cliente', '--purge requires no remaining clients'],
  [/^--purge requires --yes$/, '--purge exige --yes', '--purge requires --yes'],
  // Every pair of flags that exclude each other (EXCLUSIVE_FLAGS in index.js).
  [/^(--[\w-]+) and (--[\w-]+) cannot be combined$/, '$1 e $2 não podem ser combinadas', '--check and --rollback cannot be combined'],
  [/^Choose a language: (.+)\.$/, 'Escolha um idioma: $1.', 'Choose a language: en, pt-BR.'],
  [/^Daemon did not stop before timeout; installation retained$/, 'O daemon não parou a tempo; a instalação foi mantida', 'Daemon did not stop before timeout; installation retained'],
  [/^Unknown flag: (.+)$/, 'Opção desconhecida: $1', 'Unknown flag: --x'],
  [/^Missing value for (.+)$/, 'Falta o valor de $1', 'Missing value for --client'],
  [/^Invalid (--[\w-]+|smoke\.\w+)$/, 'Valor inválido em $1', 'Invalid --max-turns'],
  [/^Unknown client (.+)$/, 'Cliente desconhecido $1', 'Unknown client x'],
  [/^Unknown --only check$/, 'Verificação desconhecida em --only', 'Unknown --only check'],
  [/^Client not registered: (.+)$/, 'Cliente não registrado: $1', 'Client not registered: x'],
  [/^Invalid client number$/, 'Número de cliente inválido', 'Invalid client number'],
  [/^Invalid client (.+); choose: (.+)$/, 'Cliente inválido ($1); escolha: $2', 'Invalid client x; choose: a, b'],
  [/^No detected clients$/, 'Nenhum cliente detectado', 'No detected clients'],
  [/^Without TTY select --client$/, 'Sem terminal interativo, escolha com --client', 'Without TTY select --client'],
  [/^Package has no configured command: (.+)$/, 'O pacote não tem o comando configurado: $1', 'Package has no configured command: x'],
  [/^Repository must be owner\/repository$/, 'O repositório deve ser dono/repositório', 'Repository must be owner/repository'],
  [/^Release\/download request failed: (.+)$/, 'A requisição à versão falhou: $1', 'Release/download request failed: x: y'],
  [/^Release API returned (.+)$/, 'A API de releases respondeu $1', 'Release API returned 500'],
  [/^Release list API returned (.+)$/, 'A API da lista de releases respondeu $1', 'Release list API returned 500'],
  [/^No published releases found$/, 'Nenhuma versão publicada encontrada', 'No published releases found'],
  [/^Unsafe release version$/, 'Versão com nome inseguro', 'Unsafe release version'],
  [/^Release (.+): missing asset (.+)$/, 'Versão $1: arquivo ausente $2', 'Release 1.0.0: missing asset x'],
  [/^Download returned ([^:]+): (.+)$/, 'O download respondeu $1: $2', 'Download returned 500: x'],
  [/^Download size limit exceeded$/, 'O download passou do tamanho máximo', 'Download size limit exceeded'],
  [/^Unsafe asset filename$/, 'Nome de arquivo inseguro', 'Unsafe asset filename'],
  [/^Checksum manifest malformed or missing unique package entry$/, 'A lista de checksums está malformada ou não tem uma linha única para o pacote', 'Checksum manifest malformed or missing unique package entry'],
  [/^SHA-256 mismatch: package refused$/, 'SHA-256 diferente do esperado: pacote recusado', 'SHA-256 mismatch: package refused'],
  [/^Package metadata version differs from release$/, 'A versão do pacote difere da versão publicada', 'Package metadata version differs from release'],
  [/^Version destination already exists: (.+)$/, 'O destino da versão já existe: $1', 'Version destination already exists: x'],
  [/^--from source must not contain the installation destination$/, '--from não pode conter a pasta de instalação', '--from source must not contain the installation destination'],
  [/^Invalid --from package: (.+)$/, 'Pacote de --from inválido: $1', 'Invalid --from package: x'],
  [/^Cannot read installation record: (.+)$/, 'Não foi possível ler o registro de instalação: $1', 'Cannot read installation record: install.json'],
  [/^Invalid installation record: (.+) \((.+)\); remove it and run (.+) install$/, 'Registro de instalação inválido: $1 ($2); remova-o e rode $3 install', 'Invalid installation record: install.json (linkDirectory); remove it and run okit-plugin install'],
  [/^Cannot read PATH state: (.+)$/, 'Não foi possível ler o estado do PATH: $1', 'Cannot read PATH state: managed-path.json'],
  [/^Invalid PATH state: (.+) \((.+)\); remove it and run (.+) install$/, 'Estado do PATH inválido: $1 ($2); remova-o e rode $3 install', 'Invalid PATH state: managed-path.json (profiles); remove it and run okit-plugin install'],
  [/^Invalid --from package name$/, 'Nome do pacote de --from inválido', 'Invalid --from package name'],
  [/^Invalid --from package version$/, 'Versão do pacote de --from inválida', 'Invalid --from package version'],
  [/^Missing CLI$/, 'CLI ausente', 'Missing CLI'],
  [/^Unsupported shim path$/, 'Caminho sem suporte para o comando', 'Unsupported shim path'],
  // The archive refusals of extract.js: a fixed prefix, then the detail that varies.
  [/^Invalid tar header checksum$/, 'Cabeçalho tar com checksum inválido', 'Invalid tar header checksum'],
  [/^Truncated tar entry$/, 'Entrada tar truncada', 'Truncated tar entry'],
  [/^Truncated tar archive$/, 'Pacote tar truncado', 'Truncated tar archive'],
  [/^Archive links and special entries refused$/, 'O pacote tem links ou entradas especiais: recusado', 'Archive links and special entries refused'],
  [/^Archive links or unsupported zip entry refused$/, 'O pacote tem links ou uma entrada zip sem suporte: recusado', 'Archive links or unsupported zip entry refused'],
  [/^Invalid zip directory$/, 'Diretório zip inválido', 'Invalid zip directory'],
  [/^Invalid zip entry size$/, 'Tamanho de entrada zip inválido', 'Invalid zip entry size'],
  [/^Invalid zip entry$/, 'Entrada zip inválida', 'Invalid zip entry'],
  [/^Invalid zip local header$/, 'Cabeçalho local zip inválido', 'Invalid zip local header'],
  [/^Truncated zip entry$/, 'Entrada zip truncada', 'Truncated zip entry'],
  [/^Extraction size limit exceeded$/, 'A extração passou do tamanho máximo', 'Extraction size limit exceeded'],
  [/^Unsupported archive: (.+)$/, 'Formato de pacote sem suporte: $1', 'Unsupported archive: x'],
  [/^Unsafe archive path: (.+)$/, 'Caminho inseguro no pacote: $1', 'Unsafe archive path: x'],
  [/^Duplicate archive path: (.+)$/, 'Caminho repetido no pacote: $1', 'Duplicate archive path: x'],
  // The configuration (config.js) and the kit probe (kit.js).
  [/^Unsupported platform: (.+)$/, 'Sistema sem suporte: $1', 'Unsupported platform: x'],
  // The rules a setting of install.* is refused by (INSTALL_SCHEMA in config-schema.js), one entry per rule.
  ...RULE_REASONS,
  // The state files (src/state.js, src/limits.js): the path and what the system said stay as they are.
  [/^Cannot read (.+?): ([^]*)$/, 'Não foi possível ler $1: $2', 'Cannot read /state/config.json: unreadable'],
  [/^Invalid JSON in (.+?): ([^]*)$/, 'JSON inválido em $1: $2', 'Invalid JSON in /state/config.json: Unexpected token'],
  [/^Cannot write the owner of (.+?): ([^]*)$/, 'Não foi possível gravar o dono de $1: $2', 'Cannot write the owner of /state/lock: denied'],
  [/^Cannot write (.+?): ([^]*)$/, 'Não foi possível gravar $1: $2', 'Cannot write /state/config.json: denied'],
  [/^Lock (.+?) is held by (.+) after (.+?) ms([^]*)$/, 'O bloqueio $1 está com $2 depois de $3 ms$4', 'Lock /state/lock is held by pid 1 after 5000 ms'],
  [/^version command failed$/, 'o comando de versão falhou', 'version command failed'],
  [/^invalid version output$/, 'a saída da versão é inválida', 'invalid version output'],
  [/^version command timed out after (.+) ms$/, 'o comando de versão passou de $1 ms', 'version command timed out after 5000 ms'],
];

// The refusals of the settings (CONFIG_MESSAGES in profiles.js): each English text with its {name} placeholders is a
// pattern whose named captures fill the same placeholders of the pt-BR text. One catalog, one function (below).
const CONFIG_REASONS = Object.values(CONFIG_MESSAGES).map((entry) => {
  const source = entry.en
    .split(/(\{\w+\})/)
    .map((part, index) => (index % 2 ? '(?<' + part.slice(1, -1) + '>.+)' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
    .join('');
  return [new RegExp('^' + source + '$'), entry['pt-BR']];
});

/** A reason in the language of the run: the installer's own (REASONS), a refusal of the settings (CONFIG_MESSAGES), or as raised. */
export function localizeReason(reason, locale) {
  const value = String(reason ?? '');
  if (locale !== 'pt-BR') return value;
  // A name typed by a person may hold a line break: `.` in a reason has to reach across it.
  const dotAll = (pattern) => (pattern.dotAll ? pattern : new RegExp(pattern.source, `${pattern.flags}s`));
  for (const [raw, text] of CONFIG_REASONS) {
    const pattern = dotAll(raw);
    const found = pattern.exec(value);
    if (found) return text.replace(/\{(\w+)\}/g, (_, name) => localizeReason(found.groups[name], locale));
  }
  for (const [raw, text] of REASONS) {
    const pattern = dotAll(raw);
    // A capture may itself be one of our reasons ("Invalid --from package: Missing CLI"): it is translated too,
    // so that no line carries both languages. Text that is not a reason (a name, a system error) stays as it is.
    if (pattern.test(value)) return value.replace(pattern, (...match) => text.replace(/\$(\d)/g, (_, index) => localizeReason(match[Number(index)], locale)));
  }
  return value;
}

const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
// A query parameter that carries a secret, outside any address.
const SECRET_PARAMETER = /[?&][\w.-]*(?:token|secret|password|passwd|signature|credential|api[-_]?key|auth)[\w.-]*=[^\s&#'"<>]*/gi;
const PAIRS = { ')': '(', ']': '[', '}': '{' };

function count(text, character) { return text.split(character).length - 1; }

/** An address as it may be shown: no credentials, no query, no fragment. */
function plainUrl(address) {
  // An address ends at a space, a quote or an angle bracket: parentheses and brackets belong to it.
  // What closes a sentence around it (a dot, a comma, a bracket without its opener) stays outside.
  let body = address;
  let trailing = '';
  for (;;) {
    const last = body.at(-1);
    const unpaired = PAIRS[last] && count(body, last) > count(body, PAIRS[last]);
    if (!/[.,;:!]/.test(last) && !unpaired) break;
    trailing = last + trailing;
    body = body.slice(0, -1);
  }
  const scheme = body.match(/^[a-z][a-z0-9+.-]*:\/\//i)[0];
  let rest = body.slice(scheme.length);
  // The user information is everything before the last @ of the part before the first slash.
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  return scheme + rest.replace(/[?#].*$/s, '') + trailing;
}

/**
 * What any installer text may show: addresses without credentials, query or
 * fragment, query parameters that carry a secret, and the temporary folder as
 * `<temp>` (the folders in `hide`).
 */
export function redact(value, hide = []) {
  let shown = String(value ?? '').replace(ADDRESS, plainUrl).replace(SECRET_PARAMETER, '');
  for (const folder of hide) {
    if (!folder || folder.length < 2) continue;
    for (const form of new Set([folder, folder.replaceAll('\\', '/')])) shown = shown.replaceAll(form, '<temp>');
  }
  return shown;
}

/** A writer that redacts every line before it prints it: the one door of the installer's output. */
export function redactingWriter(write, hide = []) {
  if (typeof write !== 'function') return write;
  return (line, ...rest) => write(redact(line, hide), ...rest);
}

/**
 * A terminal stream whose writes pass through `redact`: what a prompt prints
 * (readline writes straight to its output) goes out the same door as every line.
 */
export function redactingStream(stream, hide = []) {
  return new Proxy(stream, {
    get(target, key) {
      if (key === 'write') return (chunk, ...rest) => target.write(typeof chunk === 'string' ? redact(chunk, hide) : chunk, ...rest);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The chosen side of a message; text from a config file may carry both sides as "EN / PT". */
export function pick(text, locale) {
  if (text && typeof text === 'object') return text[locale] ?? text.en;
  const parts = String(text).split(' / ');
  if (parts.length < 2) return String(text);
  return locale === 'pt-BR' ? parts.slice(1).join(' / ') : parts[0];
}

export function fill(text, values = {}) {
  return String(text).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

export function localeName(value) {
  return LOCALES.includes(value) ? value : 'en';
}

/**
 * The one place that chooses the language of a run: a valid `--locale` (the
 * last one in `args`), else a valid `OKIT_LANGUAGE`, else the saved `language`
 * when it is valid, else English. Every refusal and every text of the installer
 * takes its language from here. `source` says which of the four decided;
 * `invalid` is true when a `--locale` or the saved language is not a language
 * (the run is refused, in the language chosen without it).
 */
export function resolveLocale({ args = [], env = {}, saved } = {}) {
  const at = args.lastIndexOf('--locale');
  const requested = at < 0 ? undefined : args[at + 1];
  const candidates = [['flag', requested], ['environment', env.OKIT_LANGUAGE], ['saved', saved]];
  const chosen = candidates.find(([, value]) => LOCALES.includes(value));
  return { locale: chosen ? chosen[1] : 'en', source: chosen ? chosen[0] : 'default',
    invalid: (at >= 0 && !LOCALES.includes(requested)) || (saved !== undefined && !LOCALES.includes(saved)) };
}

/**
 * The keys of the numbered steps of an install or an update: the one list the plan (a dry run) and the run both
 * number, so they cannot differ. `upToDate` is the same version already installed, which has only the steps that
 * still apply to it (the quota and the command link).
 */
export function planSteps({ upToDate = false, get = 'get', backup = false, quota = false, link = false, smoke = false } = {}) {
  if (upToDate) return [...(quota ? ['quota'] : []), ...(link ? ['link'] : [])];
  return [get, ...(backup ? ['backup'] : []), 'files', 'register', 'link', ...(quota ? ['quota'] : []), ...(smoke ? ['smoke'] : [])];
}

/** A client key as people read it: every dash-separated word capitalised. */
export function clientLabel(name) {
  return String(name).split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function systemLabel(platform) {
  return SYSTEMS[platform] ?? platform;
}

/** Plain `ok` unless the output is a TTY that can show UTF-8. */
export function supportsUnicode({ tty, env = {}, platform }) {
  if (!tty) return false;
  const locale = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`;
  return /utf-?8/i.test(locale) || (platform === 'win32' && Boolean(env.WT_SESSION));
}

/**
 * @param {{locale?: string, verbose?: boolean, write: Function, unicode?: boolean, hide?: string[]}} input
 */
export function createPresenter({ locale = 'en', verbose = false, write, unicode = false, hide = [] } = {}) {
  const lang = localeName(locale);
  const text = (key, values) => fill(pick(TEXTS[key], lang), values);
  const emit = redactingWriter(write, hide);
  const line = (value) => emit(value);
  // What belongs to the whole run, not to a client (the SHA-256 note, the PATH check): said once, however many clients.
  const said = new Set();
  const first = (value) => {
    if (typeof value === 'string') return true;
    if (said.has(value.global)) return false;
    said.add(value.global);
    return true;
  };
  const textOf = (value) => (typeof value === 'string' ? value : value.global);
  let prefixWidth = 6;
  let labelWidth = LABEL_WIDTH;
  const mark = (status) => (status === 'ok' && unicode ? '✓' : pick(TEXTS.status[status], lang));
  const row = (prefix, label, status, detail = '') => {
    line(`${prefix.padEnd(prefixWidth)}${label.padEnd(Math.max(labelWidth, label.length + 2))}${mark(status).padEnd(STATUS_WIDTH)}${detail}`.trimEnd());
  };

  const ui = {
    locale: lang, verbose, text,
    header(values) { line(text('header', values)); },
    /** `[n/total] label`, printed once as one result line when the step ends. */
    step(n, total, label) {
      const prefix = `[${n}/${total}]`;
      prefixWidth = `[${total}/${total}]`.length + 1;
      let ended = false;
      const end = (status, detail = '', notes = []) => {
        if (ended) return;
        ended = true;
        row(prefix, label, status, detail);
        for (const note of notes) ui.note(note);
      };
      return {
        label: `${prefix} ${label}`,
        ok: (detail, notes) => end('ok', detail, notes),
        skip: (detail, notes) => end('skipped', detail, notes),
        plan: (detail, notes) => end('plan', detail, notes),
        fail: (detail, notes) => end('failed', detail, notes),
        get ended() { return ended; },
      };
    },
    /** The steps of one run, numbered `n/total` in order. */
    sequence(keys, values = {}) {
      labelWidth = Math.max(LABEL_WIDTH, ...keys.map((key) => text(key, values).length + 2));
      let n = 0;
      return (key) => ui.step(++n, keys.length, text(key, values));
    },
    row(label, status, detail) { row('', label, status, detail); },
    /** A message of the whole run: pass it to `note`, `detail` or a step's notes and it prints the first time only. */
    global(value) { return { global: value }; },
    note(value) { if (first(value)) line(`${' '.repeat(prefixWidth)}${textOf(value)}`); },
    warn(value) { line(`${text('warning')}: ${value}`); },
    /** Raw commands and other details: only with --verbose. */
    detail(value) { if (verbose && first(value)) line(`${' '.repeat(prefixWidth)}> ${textOf(value)}`); },
    explain(lines) { for (const item of lines) line(item); },
    /** The question comes last, options visible, default capitalised. */
    question(value, defaultYes = false) {
      const [yes, no] = TEXTS.yesNo[lang];
      return `${value} [${defaultYes ? yes.toUpperCase() : yes}/${defaultYes ? no : no.toUpperCase()}] `;
    },
    /** y, yes, s and sim are yes in either language; an empty answer is the default. */
    answer(raw, defaultYes = false) {
      const value = String(raw ?? '').trim();
      if (value === '') return defaultYes;
      return /^(y|yes|s|sim)$/i.test(value);
    },
    async confirm(read, { explain = [], question, defaultYes = false }) {
      ui.explain(explain);
      return ui.answer(await read(ui.question(question, defaultYes)), defaultYes);
    },
    summary({ client, command, hint }) {
      const items = [text('nextOpen'), text('nextRestart', { client }), text('nextRun', { command: `${command} status` })];
      if (hint) items.splice(1, 0, text('nextHere', { command: hint }));
      line(`${text('done')} ${text('next')} ${items.map((item, index) => `${index + 1}. ${item}`).join('  ')}`);
    },
    /** The lines of an error: the step that failed, the reason, and what to do next. */
    failure({ step, reason, next }) {
      const why = localizeReason(redact(reason, hide), lang);
      const head = step ? text('failedAt', { step, reason: why }) : text('refused', { reason: why });
      return (next ? [head, `${' '.repeat(prefixWidth)}${text('nextLabel')}: ${next}`] : [head]).map((item) => redact(item, hide));
    },
  };
  return ui;
}

/** The values of the header line: the package, its version, the client, and the system. */
export function headerValues(deps, version, client) {
  return { package: deps.config.entry, version, client: clientLabel(client), system: systemLabel(deps.platform),
    arch: deps.config.architectures[deps.arch ?? process.arch] ?? deps.arch ?? process.arch };
}

/** Ends a step with what the work returned: `{ status: 'ok'|'skipped'|'plan', detail, notes }`. */
export function finish(step, result) {
  const end = { skipped: step.skip, plan: step.plan }[result?.status] ?? step.ok;
  return end(result?.detail, result?.notes);
}

/** Ends the command-and-PATH step; `linked` is null when no link was made. */
export function finishLink(ui, step, linked, { dryRun = false, command = '', bin = '' } = {}) {
  if (dryRun) return step.plan(`${command} -> ${bin}`);
  if (!linked) return step.skip(ui.text('linkOff'));
  if (linked.how === 'conflict') {
    const reason = ui.text('linkConflict', { path: linked.where });
    step.fail(reason);
    throw new Error(reason);
  }
  const key = { changed: linked.user ? 'linkUser' : 'linkProfile', existing: 'linkExisting', manual: 'linkManual' }[linked.how];
  const notes = linked.how !== 'manual' && linked.resolved == null && 'resolved' in linked ? [ui.text('pathMissing')] : [];
  return step.ok(ui.text(key, { command: linked.command, where: linked.where }), notes);
}

const cache = new WeakMap();
/** The presenter of a deps object; lower-level callers without one get an English presenter on `out`. */
export function presenterOf(deps) {
  if (deps.ui) return deps.ui;
  if (!cache.has(deps)) cache.set(deps, createPresenter({ write: deps.out }));
  return cache.get(deps);
}
