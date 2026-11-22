// Extra edge-case tests for mend, written by hand against SPEC.md sentences the practice
// set may not cover. Run: node run-tests.mjs
// Each case: one run of node main.ts in a fresh directory; exit code, stdout and every file
// afterwards must match exactly.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, text] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv ?? [])], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    const gotFiles = readTree(dir);
    const wantFiles = { ...(c.files ?? {}) };
    for (const [p, v] of Object.entries(c.expect.changes ?? {})) {
      if (v === null) delete wantFiles[p];
      else wantFiles[p] = v;
    }
    const problems = [];
    if (r.status !== c.expect.exit) problems.push(`exit ${r.status}, expected ${c.expect.exit}`);
    if ((r.stdout ?? '') !== c.expect.stdout) problems.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
    for (const p of new Set([...Object.keys(wantFiles), ...Object.keys(gotFiles)])) {
      if (wantFiles[p] === undefined) problems.push(`${p} should not exist`);
      else if (gotFiles[p] === undefined) problems.push(`${p} is missing`);
      else if (gotFiles[p] !== wantFiles[p]) problems.push(`${p} differs: expected ${JSON.stringify(wantFiles[p])}, got ${JSON.stringify(gotFiles[p])}`);
    }
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [];
const t = (name, argv, stdin, files, expect) => CASES.push({ name, argv, stdin, files, expect });

// --- Usage errors (SPEC.md section 1) ---
t('usage-unknown-flag', ['--bogus', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-dup-check', ['--check', '--check', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-dup-format', ['--format=json', '--format=v4a', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-dup-strict', ['--strict', '--strict', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-bad-format', ['--format=git', 'p.diff'], null, {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-bad-format-empty', ['--format=', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-two-pos', ['a.patch', 'b.patch'], null, {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-format-no-equals', ['--format', 'json', '-'], 'x\n', {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-single-dash-flag', ['-x'], null, {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-dashdash-patch-name', ['--', '--check'], null, {}, { exit: 2, stdout: 'error: no-patch\n', changes: {} });
t(
  'usage-dashdash-stdin',
  ['--', '-'],
  'f.txt\n<<<<<<< SEARCH\nhello\n=======\nbye\n>>>>>>> REPLACE\n',
  { 'f.txt': 'hello\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'bye\n' } },
);
t('usage-beats-nopatch', ['--bogus', 'nonexistent.patch'], null, {}, { exit: 2, stdout: 'error: usage\n', changes: {} });
t('usage-after-dashdash-not-flag', ['--check', '--', '--strict'], null, {}, { exit: 2, stdout: 'error: no-patch\n', changes: {} });

// --- Parse errors and their line numbers ---
t(
  'parse-diffgit-bad',
  ['p.diff'],
  null,
  { 'p.diff': 'diff --git a/foo\n--- a/foo\n+++ b/foo\n' },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'parse-hunk-bad-header',
  ['p.diff'],
  null,
  { 'p.diff': '--- a/x\n+++ b/x\n@@ -1,2 +1,2\n context\n' },
  { exit: 2, stdout: 'error: parse 3\n', changes: {} },
);
t(
  'parse-hunk-before-section',
  ['p.diff'],
  null,
  { 'p.diff': '@@ -1,1 +1,1 @@\n-x\n+y\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n' },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'parse-dashdash-in-header',
  ['p.diff'],
  null,
  { 'p.diff': 'diff --git a/x b/x\n--- a/x\nindex abc\n@@ -1,1 +1,1 @@\n' },
  { exit: 2, stdout: 'error: parse 3\n', changes: {} },
);
t(
  'parse-sr-no-equals',
  ['p.txt'],
  null,
  { 'p.txt': 'f.txt\n<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE\n' },
  { exit: 2, stdout: 'error: parse 2\n', changes: {} },
);
t(
  'parse-sr-no-path-first',
  ['p.txt'],
  null,
  { 'p.txt': '<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n' },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'parse-v4a-no-begin',
  ['--format=v4a', 'p.txt'],
  null,
  { 'p.txt': '*** Update File: x\n x\n' },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'parse-v4a-no-end',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\n*** Update File: f.txt\n x\n- a\n+ b\n' },
  { exit: 2, stdout: 'error: parse 6\n', changes: {} },
);
t(
  'parse-v4a-update-nochunk',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n' },
  { exit: 2, stdout: 'error: parse 2\n', changes: {} },
);
t(
  'parse-v4a-stray-line',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\nhello\n*** End Patch\n' },
  { exit: 2, stdout: 'error: parse 2\n', changes: {} },
);
t(
  'parse-v4a-first-line-number',
  ['--format=v4a', 'p.txt'],
  null,
  { 'p.txt': '\n\nfoo\n*** Begin Patch\n*** End Patch\n' },
  { exit: 2, stdout: 'error: parse 3\n', changes: {} },
);
t(
  'parse-json-bad-command',
  ['--format=json', 'p.txt'],
  null,
  { 'p.txt': '{"command":"bogus","path":"x"}\n' },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'parse-beats-missing',
  ['p.diff'],
  null,
  { 'p.diff': '--- a/gone.txt\n+++ b/gone.txt\n@@ -1,2 +1,2\n x\n' },
  { exit: 2, stdout: 'error: parse 3\n', changes: {} },
);
t('format-error-prose', ['-'], 'just some prose\nno patch here\n', {}, { exit: 2, stdout: 'error: format\n', changes: {} });
t('format-json-forced-on-v4a', ['--format=json', 'p.txt'], null, { 'p.txt': '*** Begin Patch\n*** End Patch\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t('format-v4a-forced-on-json', ['--format=v4a', 'p.txt'], null, { 'p.txt': '{"command":"create","path":"x","file_text":"y"}\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t('format-unified-forced-on-sr', ['--format=unified', 'p.txt'], null, { 'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t('format-sr-forced-on-unified', ['--format=search-replace', 'p.txt'], null, { 'p.txt': '--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t('no-patch-missing-file', ['missing.patch'], null, {}, { exit: 2, stdout: 'error: no-patch\n', changes: {} });
t('empty-stdin-auto', [], '', {}, { exit: 2, stdout: 'error: format\n', changes: {} });
t('empty-patch-v4a-sections-none', ['p.txt'], null, { 'p.txt': '*** Begin Patch\n*** End Patch\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });

// --- CRLF files (SPEC.md section 3) ---
t(
  'crlf-unified',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n l1\n-l2\n+lX\n l3\n',
    'a.txt': 'l1\r\nl2\r\nl3\r\n',
  },
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'l1\r\nlX\r\nl3\r\n' } },
);
t(
  'crlf-sr',
  ['p.txt'],
  null,
  {
    'p.txt': 'a.txt\n<<<<<<< SEARCH\nl2\n=======\nlX\n>>>>>>> REPLACE\n',
    'a.txt': 'l1\r\nl2\r\nl3\r\n',
  },
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'l1\r\nlX\r\nl3\r\n' } },
);
t(
  'crlf-v4a',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: a.txt\n l1\n-l2\n+lX\n l3\n*** End Patch\n',
    'a.txt': 'l1\r\nl2\r\nl3\r\n',
  },
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'l1\r\nlX\r\nl3\r\n' } },
);
t(
  'crlf-no-final-unified',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-a\n+x\n b\n',
    'a.txt': 'a\r\nb',
  },
  // Matched lines run to the end of the file and no `\` line follows the hunk's last
  // context line, so the result ends with a line break (SPEC.md section 6).
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'x\r\nb\r\n' } },
);
t(
  'crlf-json-insert',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"insert","path":"a.txt","insert_line":1,"new_str":"mid"}\n',
    'a.txt': 'l1\r\nl2\r\n',
  },
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'l1\r\nmid\r\nl2\r\n' } },
);
t(
  'crlf-json-str-replace',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"str_replace","path":"a.txt","old_str":"l2\\n","new_str":"lX\\n"}\n',
    'a.txt': 'l1\r\nl2\r\nl3\r\n',
  },
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', changes: { 'a.txt': 'l1\r\nlX\r\nl3\r\n' } },
);

// --- Matching tiers and re-indent (SPEC.md section 5) ---
t(
  'tier2-reindent-noprefix',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.js\n x = 1;\n return x;\n-}\n+} // done\n*** End Patch\n',
    'f.js': 'function f() {\n  x = 1;\n  return x;\n}\n',
  },
  { exit: 0, stdout: 'M f.js\nok: 1 file\n', changes: { 'f.js': 'function f() {\n  x = 1;\n  return x;\n  } // done\n' } },
);
t(
  'tier2-reindent-deeper',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.js\n  a\n-  b\n+    b2\n*** End Patch\n',
    'f.js': '    a\n    b\n',
  },
  { exit: 0, stdout: 'M f.js\nok: 1 file\n', changes: { 'f.js': '    a\n       b2\n' } },
);
t(
  'tier1-trailing-ws',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-keep   \n+keep2\n other\n',
    'f.txt': 'keep\nother\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'keep2\nother\n' } },
);
t(
  'strict-tier0-only',
  ['--strict', 'p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-keep   \n+keep2\n other\n',
    'f.txt': 'keep\nother\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'nearest-tie-earlier',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-y\n+Y\n',
    'f.txt': 'x\ny\nx\ny\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\nY\nx\ny\n' } },
);
t(
  'nearest-second',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -4,1 +4,1 @@\n-y\n+Y\n',
    'f.txt': 'x\ny\nx\ny\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\ny\nx\nY\n' } },
);

// --- SEARCH/REPLACE (SPEC.md section 7) ---
t(
  'sr-ambiguous',
  ['p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\ndup\n=======\nnew\n>>>>>>> REPLACE\n',
    'f.txt': 'dup\ndup\n',
  },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'sr-create-exists',
  ['p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n',
    'f.txt': 'old\n',
  },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'sr-create-new-subdir',
  ['p.txt'],
  null,
  { 'p.txt': 'sub/new.txt\n<<<<<<< SEARCH\n=======\nline1\nline2\n>>>>>>> REPLACE\n' },
  { exit: 0, stdout: 'A sub/new.txt\nok: 1 file\n', changes: { 'sub/new.txt': 'line1\nline2\n' } },
);
t(
  'sr-create-empty',
  ['p.txt'],
  null,
  { 'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n' },
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': '' } },
);
t(
  'sr-second-block-inherits-path',
  ['p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nB\n' } },
);
t(
  'sr-delete-all-lines',
  ['p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nonly\n=======\n>>>>>>> REPLACE\n',
    'f.txt': 'only\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '' } },
);

// --- Unsafe paths (SPEC.md sections 3 and 10) ---
t('unsafe-dotdot-json', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '{"command":"create","path":"../evil.txt","file_text":"x"}\n' }, { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-absolute-json', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '{"command":"create","path":"/etc/x","file_text":"x"}\n' }, { exit: 1, stdout: 'error: unsafe /etc/x\nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-backslash-json', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '{"command":"create","path":"a\\\\b.txt","file_text":"x"}\n' }, { exit: 1, stdout: 'error: unsafe a\\b.txt\nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-empty-path-json', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '{"command":"create","path":"","file_text":"x"}\n' }, { exit: 1, stdout: 'error: unsafe \nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-empty-seg-unified', ['p.diff'], null, { 'p.diff': '--- x//y\n+++ x//y\n@@ -1,1 +1,1 @@\n-a\n+b\n' }, { exit: 1, stdout: 'error: unsafe x//y\nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-dot-seg-unified', ['p.diff'], null, { 'p.diff': '--- ./x\n+++ ./x\n@@ -1,1 +1,1 @@\n-a\n+b\n' }, { exit: 1, stdout: 'error: unsafe ./x\nfailed: 1 of 1 edits\n', changes: {} });
t('unsafe-prefix-strip-unified', ['p.diff'], null, { 'p.diff': '--- a/../evil\n+++ b/../evil\n@@ -1,1 +1,1 @@\n-a\n+b\n' }, { exit: 1, stdout: 'error: unsafe ../evil\nfailed: 1 of 1 edits\n', changes: {} });
t(
  'unsafe-move-new-v4a',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n*** Move to: ../evil.txt\n a\n*** End Patch\n',
    'f.txt': 'a\n',
  },
  { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'unsafe-add-v4a',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\n*** Add File: /abs.txt\n+x\n*** End Patch\n' },
  { exit: 1, stdout: 'error: unsafe /abs.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'unsafe-beats-missing',
  ['p.diff'],
  null,
  { 'p.diff': '--- a/../gone.txt\n+++ b/../gone.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n' },
  { exit: 1, stdout: 'error: unsafe ../gone.txt\nfailed: 1 of 1 edits\n', changes: {} },
);

// --- Moves and output sorting (SPEC.md section 2) ---
t(
  'move-sort-by-new-ok',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/z.txt b/a/moved.txt\nrename from z.txt\nrename to a/moved.txt\n--- a/z.txt\n+++ b/a/moved.txt\n@@ -1,1 +1,1 @@\n-old\n+new\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\ndiff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-p\n+q\n',
    'z.txt': 'old\n',
    'b.txt': 'x\n',
    'c.txt': 'p\n',
  },
  {
    exit: 0,
    stdout: 'R z.txt -> a/moved.txt\nM b.txt\nM c.txt\nok: 3 files\n',
    changes: { 'z.txt': null, 'a/moved.txt': 'new\n', 'b.txt': 'y\n', 'c.txt': 'q\n' },
  },
);
t(
  'move-v4a',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: sub/new.txt\n@@ head\n first\n-second\n+third\n*** End Patch\n',
    'old.txt': 'head\nfirst\nsecond\n',
  },
  { exit: 0, stdout: 'R old.txt -> sub/new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'sub/new.txt': 'head\nfirst\nthird\n' } },
);
t(
  'move-exists',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'old.txt': 'a\n',
    'new.txt': 'x\n',
  },
  { exit: 1, stdout: 'error: exists new.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'move-missing',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  },
  { exit: 1, stdout: 'error: missing old.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'move-v4a-exists',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@ first\n first\n*** End Patch\n',
    'old.txt': 'first\n',
    'new.txt': 'x\n',
  },
  { exit: 1, stdout: 'error: exists new.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'move-only-v4a-no-chunks',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
    'old.txt': 'same\n',
  },
  { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'same\n' } },
);
t(
  'sort-byte-order',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"create","path":"a.txt","file_text":"a"}\n{"command":"create","path":"Z.txt","file_text":"z"}\n{"command":"create","path":"a/b.txt","file_text":"b"}\n',
  },
  { exit: 0, stdout: 'A Z.txt\nA a.txt\nA a/b.txt\nok: 3 files\n', changes: { 'a.txt': 'a', 'Z.txt': 'z', 'a/b.txt': 'b' } },
);

// --- --check writes nothing (SPEC.md sections 1 and 10) ---
t(
  'check-writes-nothing',
  ['--check', 'p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nhello\n=======\nbye\n>>>>>>> REPLACE\n',
    'f.txt': 'hello\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: {} },
);
t(
  'check-create-writes-nothing',
  ['--check', '--format=json', 'p.jsonl'],
  null,
  { 'p.jsonl': '{"command":"create","path":"new.txt","file_text":"hi"}\n' },
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: {} },
);
t(
  'check-move-writes-nothing',
  ['--check', 'p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@ head\n a\n*** End Patch\n',
    'old.txt': 'head\na\n',
  },
  { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: {} },
);

// --- Empty-O insertion and no-newline rules (SPEC.md section 6) ---
t(
  'insert-at-end-gains-break',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -3,0 +4,1 @@\n+d\n',
    'f.txt': 'a\nb\nc',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\nd\n' } },
);
t(
  'insert-at-end-no-break',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -3,0 +4,1 @@\n+d\n\\ No newline at end of file\n',
    'f.txt': 'a\nb\nc',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\nd' } },
);
t(
  'insert-middle',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+x\n',
    'f.txt': 'a\nb\nc\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nx\nb\nc\n' } },
);
t(
  'insert-past-end-clamps',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -99,0 +100,1 @@\n+z\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nz\n' } },
);
t(
  'noeol-replace-last-gains-break',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
    'f.txt': 'a\nb',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nB\n' } },
);
t(
  'noeol-replace-last-keeps-none',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file\n',
    'f.txt': 'a\nb',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nB' } },
);
t(
  'create-noeol-backslash',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n',
  },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'x' } },
);
t(
  'create-with-break',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+x\n',
  },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'x\n' } },
);

// --- Atomicity: every failure reported, nothing written (SPEC.md section 10) ---
t(
  'atomic-two-failures',
  ['p.txt'],
  null,
  {
    'p.txt': 'ok.txt\n<<<<<<< SEARCH\nkeep\n=======\nkept\n>>>>>>> REPLACE\n\ngone.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n\nok.txt\n<<<<<<< SEARCH\nnope\n=======\nno\n>>>>>>> REPLACE\n',
    'ok.txt': 'keep\n',
  },
  {
    exit: 1,
    stdout: 'error: missing gone.txt\nerror: no-match ok.txt\nfailed: 2 of 3 edits\n',
    changes: {},
  },
);
t(
  'atomic-first-would-succeed',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"str_replace","path":"f.txt","old_str":"a","new_str":"A"}\n{"command":"str_replace","path":"f.txt","old_str":"zzz","new_str":"Z"}\n',
    'f.txt': 'a\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 2 edits\n', changes: {} },
);
t(
  'atomic-move-then-fail',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\ndiff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ b/gone.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
    'old.txt': 'a\n',
  },
  { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 2 edits\n', changes: {} },
);

// --- V4A specifics (SPEC.md section 8) ---
t(
  'v4a-anchor-missing',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ nope\n a\n- b\n+ c\n*** End Patch\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'v4a-cursor-second-occurrence',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ def second():\n     x = 1\n-    return x * 2\n+    return x * 3\n*** End Patch\n',
    'f.txt': 'def first():\n    x = 1\n    return x * 2\n\ndef second():\n    x = 1\n    return x * 2\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def first():\n    x = 1\n    return x * 2\n\ndef second():\n    x = 1\n    return x * 3\n' } },
);
t(
  'v4a-eof-nomatch',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'v4a-eof-ok',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n b\n-c\n+C\n*** End of File\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nC\n' } },
);
t(
  'v4a-eof-insert',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ head\n tail\n+last\n*** End of File\n*** End Patch\n',
    'f.txt': 'head\ntail\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'head\ntail\nlast\n' } },
);
t(
  'v4a-empty-o-insert-at-cursor',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ b\n+inserted\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\ninserted\nc\n' } },
);
t(
  'v4a-add-exists',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Add File: f.txt\n+x\n*** End Patch\n',
    'f.txt': 'old\n',
  },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'v4a-delete-missing',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n' },
  { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'v4a-add-trailing-blanks-stripped',
  ['p.txt'],
  null,
  { 'p.txt': '*** Begin Patch\n*** Add File: n.txt\n+line1\n+\n\n*** End Patch\n' },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'line1\n\n' } },
);
t(
  'v4a-delete-with-blanks-ok',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Delete File: f.txt\n\n\n*** End Patch\n',
    'f.txt': 'x\n',
  },
  { exit: 0, stdout: 'D f.txt\nok: 1 file\n', changes: { 'f.txt': null } },
);

// --- Unified misc (SPEC.md section 6) ---
t(
  'unified-rename-from-to',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/wrong.txt b/wrong2.txt\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'old.txt': 'a\n',
  },
  { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'b\n' } },
);
t(
  'unified-new-file-mode',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hello\n',
  },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'hello\n' } },
);
t(
  'unified-deleted-file-mode',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/d.txt b/d.txt\ndeleted file mode 100644\n--- a/d.txt\n+++ b/d.txt\n@@ -1,1 +0,0 @@\n-x\n',
    'd.txt': 'x\n',
  },
  { exit: 0, stdout: 'D d.txt\nok: 1 file\n', changes: { 'd.txt': null } },
);
t(
  'unified-tab-in-path',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\t2024-01-01\n+++ b/f.txt\t2024-01-01\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n' } },
);
t(
  'unified-fenced',
  ['p.diff'],
  null,
  {
    'p.diff': '```diff\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n```\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n' } },
);
t(
  'unified-create-exists',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+x\n',
    'n.txt': 'old\n',
  },
  { exit: 1, stdout: 'error: exists n.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'unified-delete-missing',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n',
  },
  { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'unified-multi-hunk-drift',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n@@ -50,2 +50,2 @@\n three\n-four\n+4\n',
    'f.txt': 'one\ntwo\nthree\nfour\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'one\n2\nthree\n4\n' } },
);
t(
  'unified-noop-section',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'ok: 0 files\n', changes: {} },
);

// --- JSON bounds and forms (SPEC.md section 9) ---
t(
  'json-insert-at-end-ok',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"c"}\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\n' } },
);
t(
  'json-insert-too-far',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":3,"new_str":"c"}\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'json-insert-negative',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":-1,"new_str":"c"}\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'json-insert-multiline',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"insert","path":"f.txt","insert_line":0,"new_str":"x\\ny"}\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\ny\na\n' } },
);
t(
  'json-array-bad-object',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '[{"command":"create","path":"n.txt","file_text":"x"},{"command":"bogus","path":"n.txt"}]\n',
  },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} },
);
t(
  'json-array-multiline',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '[\n{"command":"create","path":"n.txt","file_text":"x"},\n{"command":"create","path":"m.txt","file_text":"y"}\n]\n',
  },
  { exit: 0, stdout: 'A m.txt\nA n.txt\nok: 2 files\n', changes: { 'n.txt': 'x', 'm.txt': 'y' } },
);
t(
  'json-create-no-trailing-newline',
  ['--format=json', 'p.jsonl'],
  null,
  { 'p.jsonl': '{"command":"create","path":"n.txt","file_text":"no-newline"}\n' },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'no-newline' } },
);
t(
  'json-str-replace-ambiguous',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"str_replace","path":"f.txt","old_str":"dup","new_str":"x"}\n',
    'f.txt': 'dup dup\n',
  },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'json-str-replace-overlap-once',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}\n',
    'f.txt': 'aaa\n',
  },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'json-str-replace-missing-new-str',
  ['--format=json', 'p.jsonl'],
  null,
  {
    'p.jsonl': '{"command":"str_replace","path":"f.txt","old_str":"a"}\n',
    'f.txt': 'aXa\n',
  },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);

// --- Batch 2: riskiest remaining ambiguities ---
t(
  'unified-d-accumulates',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +2,2 @@\n+x\n+y\n@@ -4,1 +6,1 @@\n-d\n+D\n',
    'f.txt': 'a\nb\nc\nd\ne\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nx\ny\nb\nc\nD\ne\n' } },
);
t(
  'unified-trailing-empty-body-stripped',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\nSome prose.\n',
    'f.txt': 'a\nb\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nB\n' } },
);
t(
  'unified-second-pair-new-section',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'f.txt': 'keep\n',
    'g.txt': 'a\n',
  },
  { exit: 0, stdout: 'M g.txt\nok: 1 file\n', changes: { 'g.txt': 'b\n' } },
);
t(
  'unified-header-noise-ignored',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/f.txt b/f.txt\nIndex: f.txt\n===================================================================\nold mode 100644\nnew mode 100644\nsimilarity index 88%\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n' } },
);
t(
  'unified-hunk-header-trailing-text',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@ func foo()\n-a\n+b\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n' } },
);
t(
  'unified-backslash-after-del-ignored',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n x\n-foo\n\\ No newline at end of file\n',
    'f.txt': 'x\nfoo',
  },
  // The `\` line follows the last `-` line, not the hunk's last context or `+` line,
  // so the result ends with a line break (SPEC.md section 6).
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\n' } },
);
t(
  'unified-move-hunk-nomatch',
  ['p.diff'],
  null,
  {
    'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-zzz\n+yyy\n',
    'old.txt': 'a\n',
  },
  { exit: 1, stdout: 'error: no-match old.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'v4a-blank-before-at-chunk-kept',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n def a():\n-    x = 1\n+    x = 9\n \n@@ def b():\n-    y = 2\n+    y = 3\n*** End Patch\n',
    'f.txt': 'def a():\n    x = 1\n\ndef b():\n    y = 2\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def a():\n    x = 9\n\ndef b():\n    y = 3\n' } },
);
t(
  'v4a-anchor-tier1',
  ['p.txt'],
  null,
  {
    // The anchor is trimmed (SPEC.md section 8), so a tier-1 anchor match is a file
    // line with trailing whitespace against a trimmed anchor.
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ def b():\n-    y = 2\n+    y = 3\n*** End Patch\n',
    'f.txt': 'def a():\n    x = 1\n\ndef b():  \n    y = 2\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def a():\n    x = 1\n\ndef b():  \n    y = 3\n' } },
);
t(
  'v4a-eof-only-noop',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n*** End of File\n*** End Patch\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'ok: 0 files\n', changes: {} },
);
t(
  'v4a-move-to-self-exists',
  ['p.txt'],
  null,
  {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n*** Move to: f.txt\n a\n*** End Patch\n',
    'f.txt': 'a\n',
  },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} },
);
t(
  'sr-equals-trailing-ws',
  ['p.txt'],
  null,
  {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======   \nb\n>>>>>>> REPLACE\n',
    'f.txt': 'a\n',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n' } },
);
t(
  'json-create-crlf-bytes',
  ['--format=json', 'p.jsonl'],
  null,
  { 'p.jsonl': '{"command":"create","path":"n.txt","file_text":"a\\r\\nb"}\n' },
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'a\r\nb' } },
);
t('json-empty-patch', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t('json-empty-array', ['--format=json', 'p.jsonl'], null, { 'p.jsonl': '[]\n' }, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
t(
  'unified-empty-file-insert',
  ['p.diff'],
  null,
  {
    'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+first\n',
    'f.txt': '',
  },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'first\n' } },
);

let passed = 0;
const failed = [];
for (const c of CASES) {
  const problems = runCase(c);
  if (problems.length === 0) passed++;
  else failed.push({ name: c.name, problems });
}
for (const f of failed) {
  process.stdout.write(`FAIL ${f.name}\n  ${f.problems.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${CASES.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
