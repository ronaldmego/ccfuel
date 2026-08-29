# Contributing to ccfuel

Thanks for your interest in improving ccfuel! This is a small, focused project — contributions that keep it simple and dependency-light are very welcome.

## Ground rules

- **Open an issue first** for anything beyond a small fix, so we can agree on the approach before you write code.
- **Keep it lightweight.** ccfuel is intentionally a zero-build app with three runtime dependencies: Express; `node-pty`, for the PTY fallback that scrapes `/usage` on hosts where the usage endpoint and Claude Code's cached copy of it cannot be read; and `chart.js`, served from `node_modules` rather than a CDN. Please don't introduce a framework, a build step or a fourth dependency without discussing it first.
- **No remote resources in the dashboard.** `public/index.html` must not load anything off-origin — no CDN script, no webfont, no remote image. `SECURITY.md` promises the page makes no third-party calls, and `npm test` enforces it. Serve it from `node_modules` through a `/vendor/…` route instead, the way Chart.js is.
- **Don't commit real usage data or secrets.** `data/` and `.env` are gitignored for a reason — keep them out of commits. Test fixtures must use invented project labels, never real transcript directory names. For screenshots, `npm run demo` serves synthetic data so you never have to publish your own numbers.
- **English** for code, comments, and docs.

## Development setup

```bash
git clone https://github.com/ronaldmego/ccfuel.git
cd ccfuel
npm ci
npm test         # includes a PTY spawn check and a real server boot
node server.js   # http://localhost:3400
npm run demo     # http://localhost:3401 — synthetic data, for screenshots
```

Node 22+ (see `engines`). If the gauge stays empty on first run, `/api/global-usage` names the reason in
`failureKind` (and `triedSources` when every source failed). See the Troubleshooting
section of the README.

The gauge is read from the first source that answers — the usage endpoint, Claude Code's
cached copy of it, then the PTY scrape. Before touching any of them, run:

```bash
node claude-usage.js                              # prints the result and the `source` that produced it
DASHBOARD_USAGE_SOURCE=pty node claude-usage.js --debug   # pin the fallback; raw PTY output in /tmp/claude-usage-debug.log
```

The PTY path is the fragile one, and nothing typed into it may ever reach the model: the
input line is cleared before every keystroke and Enter is refused on anything but a bare
`/usage`. Keep both guards if you touch the typing — see
[#55](https://github.com/ronaldmego/ccfuel/issues/55) for what happens otherwise.

See `TECHNICAL-NOTES.md` for how measurement works and `LIMITATIONS.md` for known constraints.

## Pull requests

1. Branch from `main`: `git checkout -b fix/short-description`
2. Make the change, then verify it from a clean clone: `npm ci && npm test && node server.js`. CI runs the same on Linux and macOS, Node 22 and 24.
3. Open the PR with a clear description of the problem and the fix.

## Reporting bugs

Use the issue templates. For data-extraction bugs, include the output of `node claude-usage.js --debug` (redact anything sensitive).
