# Security Policy

## Scope and data handling

ccfuel runs **locally** and reads your own Claude Code logs (`~/.claude`) plus your account's usage figures. It does not transmit your data anywhere — there is no backend service, no telemetry, and no third-party calls beyond the one Anthropic endpoint described below.

- **It stores no secret, and reads one.** ccfuel has no API key of its own. To read the gauge it uses the OAuth token your Claude Code CLI already keeps on this machine (`~/.claude/.credentials.json`, or the `Claude Code-credentials` Keychain item on macOS): read only, never written, never logged, never persisted by ccfuel, and sent nowhere but `api.anthropic.com` — the same call the CLI makes for its own `/usage` panel. If you would rather it never touch the token, set `DASHBOARD_USAGE_SOURCE=cache` (Claude Code's own cached copy) or `=pty` (drive the CLI instead).
- **Bind address.** By default the server binds to `127.0.0.1` (localhost only). Only change `DASHBOARD_HOST` if you intentionally want to expose it on a trusted private network (e.g. a VPN). Never bind it to a public interface.
- **Local data stays local.** Snapshots are written to `data/` (gitignored). Don't commit them.
- **The dashboard page loads nothing from the internet.** Every asset comes from this server: the
  inline CSS and JS, `/favicon.svg`, and Chart.js at `/vendor/chart.umd.js`, served out of
  `node_modules` at the version pinned in `package-lock.json`. Fonts are named system families
  with plain fallbacks — no webfont is fetched. Opening the dashboard makes **no request to any
  host other than the one you pointed your browser at**.

  This was not always true. Until [#47](https://github.com/ronaldmego/ccfuel/issues/47) the page
  pulled IBM Plex from `fonts.googleapis.com` / `fonts.gstatic.com` and Chart.js from
  `cdn.jsdelivr.net` — the latter unpinned, so a third party decided which code ran in the page,
  and every load announced itself to two CDNs. The promise above is now enforced by
  `test/claims.test.js` (no remote resource in any runtime tag) and `test/server-smoke.test.js`
  (the local route really serves the runtime), so it cannot quietly rot again.

### What does reach the network

Being precise, since "runs locally" is the whole claim:

| When | What | Why |
|---|---|---|
| `npm ci` / `npm install` | the npm registry | Installing dependencies. Build time, not runtime — and pinned by `package-lock.json` |
| Every usage fetch (default) | `GET https://api.anthropic.com/api/oauth/usage`, with your Claude Code OAuth token | Asking your own account for its own quota figures. Nothing about your transcripts, projects or prompts is sent — the request carries the token and nothing else |
| A usage fetch on the PTY fallback | your local `claude` binary, which talks to Anthropic as it normally does | ccfuel spawns the CLI; the CLI's own network behaviour is unchanged and is not ccfuel's traffic |
| Anything else | nothing | No telemetry, no analytics, no update check, no crash reporting |

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead, open a [GitHub Security Advisory](https://github.com/ronaldmego/ccfuel/security/advisories/new) or contact the maintainer privately. You'll get a response as soon as reasonably possible.
