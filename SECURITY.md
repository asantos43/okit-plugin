# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub private
vulnerability reporting: on the repository page, open
**Security** > **Advisories** > **Report a vulnerability**. That opens a private
advisory visible only to the maintainers.

Please include the affected version, the steps to reproduce and the impact you
observed.

## Active quota credentials

The quota poller reads only Claude's `claudeAiOauth.accessToken` and `expiresAt`
in memory for one GET to the fixed HTTPS Anthropic usage endpoint. It never
follows redirects, refreshes or stores a token, changes proxy settings, or writes
account files. Expired tokens are never sent. Logs and persisted states contain
fixed failure text and HTTP status only, without response bodies or headers.
The optional lean Claude CLI fallback manages its own login; Codex rate limits
come from app-server without opening `auth.json`.

## Supported versions

Only the latest release is supported. Older versions receive no fixes.

## In scope

- The plugin's own code.
- The state files the plugin writes on your machine.
- The commands the plugin runs on your machine.

## Out of scope

- Findings that require an already compromised host.
- Vulnerabilities in the AI clients themselves; report those to their own
  maintainers.
