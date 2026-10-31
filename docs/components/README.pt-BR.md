# Referência dos componentes

![okit-plugin: Componentes](../images/banners/components.svg)

Consulte cada componente para entender como o plugin organiza e executa trabalho.

<a id="map"></a>
## Mapa

- [Skills](skills.pt-BR.md): instruções para cada papel e tarefa.
- [Ferramentas MCP](mcp-tools.pt-BR.md): entradas, respostas e efeitos.
- [API de controle](control-api.pt-BR.md): chamadas locais a um servidor em execução.
- [Hooks](hooks.pt-BR.md): contexto de sessão e coleta de cota.
- [Adaptadores](adapters.pt-BR.md): recursos e instalação por cliente.
- [CLI](cli.pt-BR.md): comandos e exemplos.
- [Daemon](daemon.pt-BR.md): execução recorrente e interrupção.
- [Configuração](configuration.pt-BR.md): chaves, padrões e efeitos.
- [Estado](state.pt-BR.md): arquivos persistidos e proteção das escritas.

<a id="flow"></a>
## Como se encaixam

```text
Pessoa → cliente → skills → ferramentas MCP → núcleo → estado
CLI ────────────────────────────────────────→ núcleo
Hooks → contexto/cota → cliente       daemon → agendas → adaptadores
```

As skills orientam o modelo; as ferramentas validam argumentos e chamam o núcleo. Adaptadores conectam os clientes. O daemon executa trabalho agendado; a CLI permite consultar e controlar esses mesmos recursos.

Algumas funções do núcleo vivem no registro de operações (`src/core/operations.js`): um nome, uma descrição nos dois idiomas, o esquema dos argumentos e um único executor. O registro tem hoje vinte e quatro operações (`config_get`, `config_set`, `quota_show`, `quota_set`, `daemon`, `kit_detect`, `todo_check`, `inbox_add`, `inbox_list`, `inbox_claim`, `inbox_release`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`, `acquire_slot`, `release_slot`, `limits_status`, `status`, `quota_notice`, `actors_list`, `env_report`, `classify`, `profile_pick`); a linha de comando as chama, e o servidor MCP monta as ferramentas das mesmas entradas a partir do registro. Uma operação devolve dados e nunca imprime.

[Guia](../guide/README.pt-BR.md) · [English](README.md)
