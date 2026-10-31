# Referência dos componentes

![okit-plugin: Componentes](../images/banners/components.svg)

Consulte cada componente para entender como o plugin organiza e executa trabalho.

<a id="map"></a>
## Mapa

- [Skills](skills.pt-BR.md): instruções para cada papel e tarefa.
- [Ferramentas MCP](mcp-tools.pt-BR.md): entradas, respostas e efeitos.
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

Algumas funções do núcleo vivem no registro de operações (`src/core/operations.js`): um nome, uma descrição nos dois idiomas, o esquema dos argumentos e um único executor. O registro tem hoje sete operações (`config_get`, `config_set`, `quota_show`, `quota_set`, `daemon`, `kit_detect`, `todo_check`); a linha de comando as chama, e as ferramentas MCP serão geradas a partir do registro em uma etapa posterior. Uma operação devolve dados e nunca imprime.

[Guia](../guide/README.pt-BR.md) · [English](README.md)
