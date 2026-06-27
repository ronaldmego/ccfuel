# Contributing to ccfuel

Thanks for your interest in improving ccfuel! This is a small, focused project — contributions that keep it simple and dependency-light are very welcome.

## Ground rules

- **Open an issue first** for anything beyond a small fix, so we can agree on the approach before you write code.
- **Keep it lightweight.** ccfuel is intentionally a zero-build, single-dependency app (Express). Please don't introduce a framework or a build step without discussing it first.
- **Don't commit real usage data or secrets.** `data/` and `.env` are gitignored for a reason — keep them out of commits. Screenshots in `screenshots/` should not reveal anything you wouldn't want public.
- **English** for code, comments, and docs.

## Development setup

```bash
git clone https://github.com/ronaldmego/ccfuel.git
cd ccfuel
npm install
node server.js   # http://localhost:3400
```

The most fragile part is `claude-usage.js` (the PTY wrapper that drives Claude Code's `/usage`). Before touching it, run:

```bash
node claude-usage.js --debug   # raw PTY output in /tmp/claude-usage-debug.log
```

See `TECHNICAL-NOTES.md` for how measurement works and `LIMITATIONS.md` for known constraints.

## Pull requests

1. Branch from `main`: `git checkout -b fix/short-description`
2. Make the change; test it runs from a clean `npm install`.
3. Update `CHANGELOG.md` under `[Unreleased]`.
4. Open the PR with a clear description of the problem and the fix.

## Reporting bugs

Use the issue templates. For data-extraction bugs, include the output of `node claude-usage.js --debug` (redact anything sensitive).
