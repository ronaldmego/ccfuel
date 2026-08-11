#!/usr/bin/env node
// Restore the executable bit on node-pty's `spawn-helper` after install.
//
// WHY THIS EXISTS — measured, not guessed. On macOS, node-pty does not spawn the target
// process directly: the native layer `posix_spawn`s a small `spawn-helper` binary that sets
// up the controlling terminal and then execs the real command. node-pty 1.1.0 ships that
// helper inside its npm tarball under `prebuilds/darwin-<arch>/spawn-helper` with mode 0644.
// A non-executable helper makes the spawn fail with EACCES, which surfaces as this:
//
//     Error: posix_spawnp failed.
//
// It looks like a Node or PATH problem and is neither. Reproduced on this machine with
// node-pty 1.1.0 on Node 22.22.3, 24.14.1 and 25.9.0 — identical failure on all three,
// including `pty.spawn('/bin/echo')`, so nothing about the target binary is involved.
// `chmod +x` on the helper fixes all three. Linux is unaffected: node-pty publishes no
// linux prebuilds, so it compiles into `build/Release` where the build sets the bit itself.
//
// This runs as a `postinstall` so a clean `npm ci` produces a working tree. It is
// idempotent, touches nothing that is already executable, and never fails the install —
// if the layout changes or the upstream bug is fixed, it simply finds nothing to do.

const fs = require('fs');
const path = require('path');

const EXEC_MODE = 0o755;

function candidates() {
  const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
  const dirs = [path.join(root, 'build', 'Release'), path.join(root, 'build', 'Debug')];

  // node-pty resolves its native dir as build/Release -> build/Debug -> prebuilds/<platform>-<arch>
  const prebuilds = path.join(root, 'prebuilds');
  try {
    for (const entry of fs.readdirSync(prebuilds)) dirs.push(path.join(prebuilds, entry));
  } catch (_) { /* no prebuilds shipped for this install */ }

  return dirs.map(d => path.join(d, 'spawn-helper'));
}

function main() {
  if (process.platform === 'win32') return; // ConPTY/winpty, no spawn-helper

  let fixed = 0;
  for (const helper of candidates()) {
    let stat;
    try { stat = fs.statSync(helper); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    if (stat.mode & 0o111) continue; // already executable

    try {
      fs.chmodSync(helper, EXEC_MODE);
      fixed++;
      console.log(`[ccfuel] made node-pty spawn-helper executable: ${path.relative(process.cwd(), helper)}`);
    } catch (e) {
      console.warn(`[ccfuel] could not chmod ${helper}: ${e.message}`);
      console.warn('[ccfuel] the PTY fetch will fail with "posix_spawnp failed." until it is executable');
    }
  }

  if (fixed === 0 && process.env.CCFUEL_PTY_FIX_VERBOSE) {
    console.log('[ccfuel] node-pty spawn-helper already executable (nothing to do)');
  }
}

try {
  main();
} catch (e) {
  // Never break an install over this.
  console.warn(`[ccfuel] spawn-helper permission check skipped: ${e.message}`);
}
