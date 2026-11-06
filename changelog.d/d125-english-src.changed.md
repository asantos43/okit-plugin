Remove accidental Portuguese from source and tests while preserving runtime localization, and guard against new leaks.

Configuration refusals, profile diagnostics, model-list/detection messages and executable-not-found defaults remain English-only: these call sites have no locale selector. Remove their unused Portuguese defaults. Setup reuses these English reasons without a translation lookup. Model `reason` fields in status and environment reports also remain English, including Portuguese reports. Installer, actor and role text continue to select their existing runtime locale.
