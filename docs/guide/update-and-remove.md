# Update or remove

![okit-plugin: User guide](../images/banners/guide.svg)

Review an update or removal before changing your installed plugin.

<a id="update"></a>
## Update

1. Run `okit-plugin update --check`. Expect availability for registered clients; this writes nothing. Add `--client codex` to select just that client.
2. Run `okit-plugin update`. Expect each client's result and smoke check; the previous version is retained. Restart your client after success. If verification fails, expect a rollback instruction; run `okit-plugin update --rollback` to activate the retained version without downloading it again. The update replaces the client's `okit` MCP entry when it points at the replaced version. In Codex the entry is only added when it is missing: the client does not say where an entry is kept, so an entry that is already there is never replaced nor removed by the installer, and the warning prints the commands to run by hand. The Claude Code behaviour is the one above. When the installation folder holds whitespace in its path, the client's output cannot tell our entry from a foreign one whose arguments were split, so the entry that is there is left as it is and the warning prints the commands to run by hand.
3. Run `okit-plugin env report --locale en`. Expect current clients, models, allowance and folders. Your configuration and user-edited skills remain preserved. Install/update replace only old command links owned by this plugin; the separate orchestration kit keeps `okit`/`kit`.

<a id="remove"></a>
## Remove

1. Run `okit-plugin uninstall --dry-run`. Expect the removal plan without writes. Use the same installation destination and `OKWORK_HOME` as before.
2. Run `okit-plugin uninstall`. Expect client unregistration and removal of managed versions, startup registration and links; the daemon is stopped. Configuration and state remain. Add `--client codex` to remove only that client; other registered clients keep their shared command. It also removes the `okit` MCP entry from the client when it is ours; an entry that is not ours is kept, and so is an entry the client shows at another scope than the configured one, and so is an entry of an installation whose path holds whitespace (the client's output cannot tell our entry from a foreign one whose arguments were split), for which the warning prints the command to run by hand. In Codex the entry is never removed by the installer, because the client does not say where an entry is kept; the warning prints the command to run by hand. The Claude Code behaviour is the one above.
3. Only if you also want to delete configuration and state, use `okit-plugin uninstall --purge --yes` instead of the previous command. Expect deletion of the state folder too. This refuses when another client would remain; `--yes` skips confirmation. Removal undoes only the installer's recorded PATH addition and preserves your other settings.

Use the installed CLI for update/removal: older downloaded bootstrap scripts locate only the legacy single-client record. See [release lifecycle details](../maintainers/RELEASING.md#installer-and-updater).

[Guide](README.md) · [Português](update-and-remove.pt-BR.md)
