# API de controle

![okit-plugin: Componentes](../images/banners/components.svg)

Um servidor MCP em execução também responde a chamadas de ferramenta de outros programas do mesmo computador, e de mais ninguém.

<a id="what"></a>
## O que é

Quando o servidor MCP inicia, ele abre um ponto local ao lado do canal stdio. Um programa do mesmo usuário pode pedir a esse servidor que execute uma ferramenta e recebe o mesmo texto que o cliente receberia por MCP. O servidor nunca abre uma porta de rede.

<a id="where"></a>
## Onde ele escuta

| Sistema | Ponto de acesso |
| :- | :- |
| Linux e macOS | Um arquivo de socket `control/<pid>.sock` na [raiz de estado](state.pt-BR.md), com no máximo 100 bytes |
| Windows | Um pipe nomeado `okit-<hash da raiz>-<pid>`, para que duas raízes nunca dividam um |

Ao lado dele o servidor grava `control/<pid>.json` com pid, ponto de acesso, hora de início, versão e um token aleatório. No Linux e no macOS a pasta é privada do usuário (modo 0700), assim como o socket e o registro (modo 0600); uma pasta de outro usuário, ou que seja um link, é recusada, e um registro que não seja um arquivo simples e pequeno do usuário é removido sem ser lido. No POSIX, a descoberta ignora pasta, registro ou socket com escrita para grupo ou outros; o registro só vale se o ponto de acesso for um socket do usuário. No Windows a pasta e o registro ficam no perfil do usuário e o pipe não tem modo de arquivo: o token aleatório do registro é o que protege a API.

<a id="protocol"></a>
## Protocolo

Um objeto JSON por linha. O pedido é `{"id", "token", "tool", "arguments"}`; a resposta é `{"id", "ok": true, "text"}` ou `{"id", "ok": false, "error"}`. Todo pedido leva o token do registro, comparado sem revelar quanto dele estava certo; token errado ou ausente é recusado e a conexão é fechada. Uma ferramenta que recusa responde `ok: false` com a própria mensagem, e um nome desconhecido responde `unknown tool <nome>`.

Limites: um quadro acima de 1 MiB é recusado, a nona conexão simultânea é dispensada e uma conexão que fica 30 segundos calada é fechada. As chamadas de uma conexão são respondidas na ordem em que chegaram.

<a id="life"></a>
## Vida do ponto de acesso

O servidor o abre depois que o canal stdio inicia e remove o socket e o registro quando sua entrada termina. O registro de um processo que morreu é podado quando o próximo servidor inicia ou quando um cliente procura. Se o ponto não puder ser criado (caminho de estado longo demais, pasta de outro usuário), o servidor MCP continua funcionando e escreve uma linha no fluxo de erro.

<a id="client"></a>
## Chamando

`src/mcp/control-client.js` oferece `callControl({ root, tool, arguments })`. Ele tenta primeiro o servidor vivo mais novo, pula um que não aceita a conexão, espera 5 segundos por padrão e sempre devolve `{ ok, text }` ou `{ ok: false, error }` em palavras simples; nunca lança exceção. O cliente só conecta no ponto de acesso que o processo de um registro deve ter, nunca em um que o registro invente, e uma chamada nunca é repetida em outro servidor depois de enviada.

[Visão geral](README.pt-BR.md) · [Ferramentas MCP](mcp-tools.pt-BR.md) · [English](control-api.md)
