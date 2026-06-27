# Security Policy

## Scope and data handling

ccfuel runs **locally** and reads your own Claude Code logs (`~/.claude`) plus the CLI's built-in `/usage` output. It does not transmit your data anywhere — there is no backend service, no telemetry, and no third-party calls beyond running your local `claude` binary.

- **No secrets required.** ccfuel does not need or store any API key or token. It relies on your already-authenticated Claude Code CLI.
- **Bind address.** By default the server binds to `127.0.0.1` (localhost only). Only change `DASHBOARD_HOST` if you intentionally want to expose it on a trusted private network (e.g. a VPN). Never bind it to a public interface.
- **Local data stays local.** Snapshots are written to `data/` (gitignored). Don't commit them.

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead, open a [GitHub Security Advisory](https://github.com/ronaldmego/ccfuel/security/advisories/new) or contact the maintainer privately. You'll get a response as soon as reasonably possible.
