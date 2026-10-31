# Control API

![okit-plugin: Components](../images/banners/components.svg)

A running MCP server also answers tool calls from other programs on the same computer, and nobody else.

<a id="what"></a>
## What it is

When the MCP server starts, it opens a local endpoint next to its stdio channel. A program of the same user can ask that server to run one tool and receive the same text the client would receive over MCP. The server never opens a network port.

<a id="where"></a>
## Where it listens

| System | Endpoint |
| :- | :- |
| Linux and macOS | A socket file `control/<pid>.sock` in the [state root](state.md), at most 100 bytes long |
| Windows | A named pipe `okit-<hash of the root>-<pid>`, so two roots never share one |

Next to it the server writes `control/<pid>.json` with its pid, endpoint, start time, version and a random token. The folder is private to the user (mode 0700) and so are the socket and the record (mode 0600); a folder that belongs to another user is refused.

<a id="protocol"></a>
## Protocol

One JSON object per line. The request is `{"id", "token", "tool", "arguments"}`; the answer is `{"id", "ok": true, "text"}` or `{"id", "ok": false, "error"}`. Every request carries the token of the record, compared without leaking how much of it was right; a wrong or missing token is refused and the connection is closed. A tool that refuses answers `ok: false` with its own message, and an unknown name answers `unknown tool <name>`.

Limits: a frame over 1 MiB is refused, a ninth simultaneous connection is turned away and a connection that says nothing for 30 seconds is closed. Calls on one connection are answered in the order they came.

<a id="life"></a>
## Life of the endpoint

The server opens it after the stdio channel starts and removes the socket and the record when its input ends. The record of a process that died is pruned when the next server starts or when a client looks. If the endpoint cannot be created (a state path that is too long, a folder of another user), the MCP server keeps working and writes one line to the error stream.

<a id="client"></a>
## Calling it

`src/mcp/control-client.js` offers `callControl({ root, tool, arguments })`. It tries the newest live server first, skips one that does not accept the connection, waits 5 seconds by default and always returns `{ ok, text }` or `{ ok: false, error }` in plain words; it never throws.

[Overview](README.md) · [MCP tools](mcp-tools.md) · [Português](control-api.pt-BR.md)
