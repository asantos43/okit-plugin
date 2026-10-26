# Referência dos componentes

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

[Guia](../guide/README.pt-BR.md) · [English](README.md)
