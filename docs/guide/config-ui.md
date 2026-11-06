# Configuration page

![okit-plugin: User guide](../images/banners/guide.svg)

Edit settings and actor profiles in a local browser page.

<a id="start"></a>
## Start

1. Run `okit-plugin config ui` to open the page; use `--locale en` or `--locale pt-BR` to choose the language. Keep the printed URL for a reload during this session.

<a id="edit"></a>
## Edit

2. Review the readiness line and actor tables. Each client account has its own table; account labels can be saved inline. Profiles are shared by the client's accounts. Refresh models to ask the client for its current list.
3. Turn actors on or off, choose model, effort and maximum turns, or expand a settings group. Settings come from the configuration schema; reset restores a setting's default. Redacted fields are read-only.
Unset text and number settings appear empty; leaving them untouched does not add a change.

4. Review the before/after list and apply the changes. Unconfirmed models require an additional explicit confirmation. Validation failures show the same reason as the command line. If the file changed on disk, reload before retrying.

<a id="safety"></a>
## Safety and closing

The page writes only `config.json`, through the validated atomic configuration writer. It never reads or shows credentials; credential content is redacted and cannot be saved here. Model refresh asks the client for model names without reading its credential files.
The server listens only on `127.0.0.1` at a random port. Every request requires the session token and passes Host/Origin checks. Keep the token URL private; language links preserve it so reload works.
The token address is passed to the browser launcher and is visible in this computer's process list for the session's lifetime. Closing ends the session; `--no-open` avoids handing the address to another program.

5. Click Close to stop immediately. The server closes when the page is closed. It also stops after inactivity or Ctrl+C. Start the command again for a new session.

[Guide](README.md) · [Português](config-ui.pt-BR.md)
