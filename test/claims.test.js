// Guards the claims the project makes about quota. `node test/claims.test.js`.
//
// WHY THIS IS A TEST AND NOT A STYLE NOTE: ccfuel's headline used to say cache reads
// "cost nothing" and "don't count against your quota". Neither is supportable. Anthropic's
// published caching pricing bills cache reads at 0.1x the base input token price — cheap,
// not free — and while the usage-limit guidance does say cached project content "doesn't
// count against your limits when reused", Anthropic publishes NO formula mapping Claude
// Code's four transcript counters onto the weekly percentage. So the repo can say:
//
//   - `/usage` is the official source of quota percentage;
//   - `fuel = output + input + cache_creation` is ccfuel's local PROXY for where the
//     non-cache work concentrated;
//   - proxy tokens and quota % are different units and are never converted;
//   - cache reads are excluded because reuse is treated favorably and dominates volume —
//     never because they are "free" or "don't count";
//   - the ~96% figure is an observation about the maintainer's corpus, not a constant.
//
// An absolute claim is cheap to reintroduce in a doc edit and expensive to publish, so the
// publication surface is checked mechanically.
//
// Sources:
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
//   https://support.claude.com/en/articles/9797557-usage-limit-best-practices

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The surface a reader or a package registry actually sees.
//
// Two other surfaces this cannot reach, and which have to be checked by hand:
//   - the GitHub repo description and topics (metadata, not files in the tree);
//   - screenshots/*.png (rendered pixels — re-shoot them if the UI copy changes).
const SURFACE = [
  'README.md',
  'LIMITATIONS.md',
  'TECHNICAL-NOTES.md',
  'package.json',
  'public/index.html',
  'session-metrics.js',
  'claude-usage.js',
  'usage-source.js',
  'server.js'
];

// Phrasing that asserts something Anthropic has not published. Deliberately narrow: it
// targets claims about *quota*, so quoting Anthropic's own wording about "limits" — which
// LIMITATIONS.md and TECHNICAL-NOTES.md both do, with citations — stays legal.
const BANNED = [
  { re: /cost(s)?\s+nothing/i, why: 'cache reads bill at 0.1x base input on the API — cheap, not costless' },
  { re: /near-free|,\s*free\b|(are|is|being)\s+free\b/i, why: 'do not call cache reads free' },
  { re: /gratis/i, why: 'do not call cache reads free (es)' },
  { re: /no consumen cuota/i, why: 'unsupported: no published Claude Code quota formula' },
  { re: /(don'?t|doesn'?t|does not|never)\s+(count against|consume|use)\s+(your\s+)?quota/i,
    why: 'Anthropic says "limits" about projects; there is no Claude Code quota formula' },
  { re: /(don'?t|doesn'?t|does not|never)\s+burn/i, why: 'unsupported as an absolute claim' },
  { re: /actually\s+burn/i, why: 'implies an official formula ccfuel does not have' },
  { re: /burns?\s+quota/i, why: 'the proxy attributes non-cache work; it does not measure quota' },
  { re: /quota-burning/i, why: 'same — call it the proxy' },
  { re: /real\s+tokens\b/i, why: '"real" implies officially charged; say proxy' }
];

// Files that cite the ~96% observation must anchor it to the corpus it came from, so it
// cannot drift back into reading like a universal constant.
const CORPUS_ANCHOR = /corpus/i;

const failures = [];
const checked = [];

for (const rel of SURFACE) {
  const file = path.join(ROOT, rel);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    failures.push(`${rel}: unreadable (${e.code}) — the surface list is out of date`);
    continue;
  }
  checked.push(rel);
  const lines = text.split('\n');

  for (const { re, why } of BANNED) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        failures.push(`${rel}:${i + 1}  ${re} — ${why}\n      ${line.trim().slice(0, 130)}`);
      }
    });
  }

  if (/\b96\s*%/.test(text) && !CORPUS_ANCHOR.test(text)) {
    failures.push(`${rel}: cites ~96% without anchoring it to the measured corpus`);
  }
}

// --- SECURITY.md's promise, checked against the page that has to keep it ------------------
//
// "no third-party calls beyond running your local `claude` binary" was false: the dashboard
// pulled IBM Plex from fonts.googleapis.com / fonts.gstatic.com and Chart.js from
// cdn.jsdelivr.net — the last one unpinned, so a third party chose what code ran in the page.
// A doc promise nobody enforces drifts back the first time someone wants a nicer font.
//
// Scanned for is the *runtime* surface: tags and CSS the browser resolves on load. Absolute URLs
// inside HTML comments and in prose are not requests, so the scan strips comments first.
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');

const REMOTE_TAGS = [
  { re: /<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i, what: '<link href="http(s)://…">' },
  { re: /<link\b[^>]*\brel\s*=\s*["']?(preconnect|dns-prefetch|preload|modulepreload)/i,
    what: 'preconnect/dns-prefetch/preload hint (only ever points off-origin here)' },
  { re: /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i, what: '<script src="http(s)://…">' },
  { re: /<(img|iframe|video|audio|source|track|embed|object)\b[^>]*\b(src|data)\s*=\s*["']https?:\/\//i,
    what: 'remote media/embed' },
  { re: /@import\s+(url\()?["']?https?:\/\//i, what: 'CSS @import of a remote sheet' },
  { re: /url\(\s*["']?https?:\/\//i, what: 'CSS url() pointing off-origin' },
  { re: /["'`]https?:\/\/[^"'`]+["'`]\s*\)/i, what: 'fetch()/XHR to an absolute URL' }
];

htmlNoComments.split('\n').forEach((line, i) => {
  for (const { re, what } of REMOTE_TAGS) {
    if (re.test(line)) {
      failures.push(`public/index.html:${i + 1}  remote runtime resource — ${what}\n`
        + `      ${line.trim().slice(0, 130)}`);
    }
  }
});

// Chart.js must come from the local route, and the dependency must be declared.
if (!/<script\b[^>]*\bsrc\s*=\s*["']\/vendor\/chart\.umd\.js["']/.test(htmlNoComments)) {
  failures.push('public/index.html: does not load Chart.js from the local /vendor/chart.umd.js');
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!pkg.dependencies || !pkg.dependencies['chart.js']) {
  failures.push('package.json: chart.js is served locally but not declared as a dependency');
}

// SECURITY.md may only keep the "no third-party calls" promise while the scan above holds. If
// someone reintroduces a CDN, this reminds them the promise is the thing that broke.
const security = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
if (!/no third-party calls|no outbound|does not make any network/i.test(security)) {
  failures.push('SECURITY.md: lost its statement about third-party calls — keep it, and keep it true');
}

// The positive half: the proxy framing has to be present, not merely un-contradicted.
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const REQUIRED = [
  { re: /proxy/i, what: 'README must name the fuel figure a proxy' },
  { re: /not (a |an )?(published )?(anthropic|official) formula/i, what: 'README must disclaim an official formula' },
  { re: /0\.1/, what: 'README must state the 0.1x cache-read price' },
  { re: /platform\.claude\.com\/docs\/en\/build-with-claude\/prompt-caching/, what: 'README must cite caching pricing' },
  { re: /support\.claude\.com\/en\/articles\/9797557/, what: 'README must cite the usage-limit article' }
];
for (const { re, what } of REQUIRED) {
  if (!re.test(readme)) failures.push(`README.md: missing — ${what} (${re})`);
}

console.log(`  checked ${checked.length} files on the publication surface:`);
console.log(`    ${checked.join(', ')}`);
for (const f of failures) console.log(`  FAIL   ${f}`);

if (failures.length === 0) {
  console.log(`  ok     no absolute quota claims survive`);
  console.log(`  ok     the proxy framing and both sources are present in the README`);
  console.log(`  ok     the page loads no remote runtime resources (SECURITY.md stays true)`);
  console.log(`  ok     Chart.js comes from /vendor/chart.umd.js and is a declared dependency`);
}
console.log(`\n${failures.length === 0 ? 4 : 0}/4 passed`);
assert.strictEqual(failures.length, 0, `${failures.length} unsupported claim(s) on the publication surface`);
