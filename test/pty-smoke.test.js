// The PTY layer actually spawns. Dependency-free: `node test/pty-smoke.test.js`.
//
// This is the test that was missing. CI ran `node --check` (which does not resolve a single
// `require`) and a suite of pure functions, so it stayed green through both failures that
// made the published Quick Start unusable:
//
//   1. `node-pty` was absent from package.json — `npm ci` exits 0 and installs Express only,
//      and the app dies with MODULE_NOT_FOUND on the first require.
//   2. node-pty 1.1.0 ships `prebuilds/darwin-*/spawn-helper` non-executable, so on macOS
//      every spawn fails with "posix_spawnp failed." — on Node 22, 24 and 25 alike.
//
// Neither is detectable without loading node-pty and spawning something. `/bin/echo` is
// enough: nothing here needs Claude Code installed, which is why it can run in CI.

const assert = require('assert');

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function run() {
  if (process.platform === 'win32') {
    console.log('  skip  PTY smoke (win32 uses ConPTY; unix spawn-helper path not applicable)');
    console.log('\n0/0 passed (skipped on win32)');
    return;
  }

  // 1. The module resolves at all — catches the missing dependency.
  let pty;
  try {
    pty = require('node-pty');
    record('node-pty resolves (catches the missing dependency)', true);
  } catch (e) {
    record('node-pty resolves (catches the missing dependency)', false,
      `${e.code || ''} ${e.message.split('\n')[0]}`);
    report();
    return;
  }

  // 2. `spawn-helper` is a macOS-only artifact: the native code only execs through it under
  //    `#if defined(__APPLE__)`. On Linux node-pty compiles from source (no prebuild is
  //    published) and produces no helper at all — verified on ubuntu-latest, where the spawn
  //    round-trip below passes with the file absent. So the mode is asserted on darwin only;
  //    that is where the upstream packaging bug lives, and asserting it by name keeps the
  //    failure legible instead of an opaque "posix_spawnp failed."
  const fs = require('fs');
  const path = require('path');
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const helperDirs = [
    path.join(root, 'build', 'Release'),
    path.join(root, 'build', 'Debug'),
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`)
  ];
  const helper = helperDirs
    .map(d => path.join(d, 'spawn-helper'))
    .find(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });

  if (process.platform === 'darwin') {
    if (helper) {
      const mode = fs.statSync(helper).mode;
      record('spawn-helper is executable (node-pty 1.1.0 ships it 0644)',
        (mode & 0o111) !== 0,
        `mode ${(mode & 0o777).toString(8)} on ${path.relative(root, helper)}`);
    } else {
      record('spawn-helper is present in the resolved native dir (required on macOS)', false,
        `looked in: ${helperDirs.join(', ')}`);
    }
  } else if (helper) {
    // Present on a non-darwin platform: still must be executable if it exists.
    const mode = fs.statSync(helper).mode;
    record('spawn-helper, where present, is executable', (mode & 0o111) !== 0,
      `mode ${(mode & 0o777).toString(8)}`);
  } else {
    console.log(`  skip   spawn-helper mode check (no helper on ${process.platform}; `
      + 'macOS-only code path)');
  }

  // 3. An actual spawn round-trip through the PTY.
  const spawned = await new Promise((resolve) => {
    let out = '';
    let term;
    try {
      term = pty.spawn('/bin/echo', ['ccfuel-pty-ok'], { name: 'xterm', cols: 80, rows: 24 });
    } catch (e) {
      return resolve({ ok: false, detail: e.message });
    }
    const timer = setTimeout(() => {
      try { term.kill(); } catch (_) {}
      resolve({ ok: false, detail: `no exit within 10s (captured ${out.length} bytes)` });
    }, 10000);
    term.onData(d => { out += d; });
    term.onExit(() => {
      clearTimeout(timer);
      resolve({ ok: out.includes('ccfuel-pty-ok'), detail: `captured ${JSON.stringify(out.trim())}` });
    });
  });

  record('pty.spawn round-trips a real process', spawned.ok, spawned.detail);
  report();
}

function report() {
  let passed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}   ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    if (r.ok) passed++;
  }
  console.log(`\n${passed}/${results.length} passed`);
  assert.strictEqual(passed, results.length, 'PTY smoke failed');
}

run().catch(e => { console.error(e); process.exit(1); });
