# Configuration page

![okit-plugin: User guide](../images/banners/guide.svg)

Edit settings and actor profiles in a local browser page.

<a id="start"></a>
## Start

1. Run `okit-plugin config ui` to open the page; use `--locale en` or `--locale pt-BR` to choose the language. Keep the printed URL for a reload during this session.

<a id="edit"></a>
## Edit

2. Review the readiness line and actor tables. Each client account has its own table; account labels can be saved inline. Profiles are shared by the client's accounts. Refresh models to ask the client for its current list.
3. Use Actors, Accounts, Limits and quota, Language, Profiles, Telemetry and Task list tabs; future settings groups appear in Other. Turn actors on or off, choose model, effort and maximum turns, or edit a settings group. Settings come from the configuration schema; reset restores a setting's default. Redacted fields are read-only.
Accounts shows a card for Claude Code and Codex, including each default account, with labels, stable ids, configuration folders and login badges. Unknown means login may be stored somewhere the plugin does not read, such as the macOS Keychain. Add an account with a label and an absolute configuration folder, or save a label inline. Add, rename and remove ask you to save or reset other edits first because they reload the page. Validation errors keep your typed values. Remove opens Confirm remove and Cancel with a note about what remains; Escape or another click cancels confirmation. Removal changes only plugin settings; the folder, login and history remain. Login help opens for logged-out or unknown accounts; otherwise, Log in opens it and hides the button. Choose Log in in a terminal to open the client's own login in a terminal window for that account's folder. Sign in in that window, then press Check login to refresh badges, commands and help in place without losing other edits. For Claude Code, type `/login` in the session if asked. Nothing is typed for you and the plugin never sees your credentials. If no window opens, copy the command and run it yourself; if copying is unavailable, press Ctrl+C on the selected command. Copy and terminal guidance appear in a polite status line; failures appear in the error line. The Accounts tab stays selected after successful changes. The [account commands](accounts.md) remain available.
Unset text and number settings appear empty; leaving them untouched does not add a change.
Sections and subsections have clickable headings with field counts; expand or collapse them with the chevron, even without JavaScript. In each tab, only the first section starts expanded, and only with four fields or fewer; all other sections and all subsections start collapsed. A value that differs from its default opens its section or subsection and every ancestor section. Single-group tabs show fields or subsections directly, with subsections collapsed unless a value differs from its default.
Edited tabs and section headings show a dot, including after Reset, until edits return to their initial state. Switching tabs keeps edits for review, and the selected tab survives the reload after saving. Use Left/Right arrows, Home or End on the tab bar; without JavaScript the settings panels remain visible and Accounts stays hidden.

4. Review the before/after list and apply the changes. Unconfirmed models require an additional explicit confirmation. Validation failures show the same reason as the command line. If the file changed on disk, reload before retrying.

<a id="safety"></a>
## Safety and closing

The page writes only `config.json`, through the validated atomic configuration writer. It never reads or shows credentials; credential content is redacted and cannot be saved here. Model refresh asks the client for model names without reading its credential files.
The server listens only on `127.0.0.1` at a random port. Every request requires the session token and passes Host/Origin checks. Keep the token URL private; language links preserve it so reload works.
The token address is passed to the browser launcher and is visible in this computer's process list for the session's lifetime. Closing ends the session; `--no-open` avoids handing the address to another program.

5. Click Close to stop immediately. The server closes when the page is closed. It also stops after inactivity or Ctrl+C. Start the command again for a new session.

[Guide](README.md) · [Português](config-ui.pt-BR.md)
