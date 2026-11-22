import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const MAIN = '/home/hatch/workspace/make-fun-art/hidden-spec-cli-01-run-20261122-v2/main.ts';
let n = 0, fails = [];
function runCase(name, files, args, patchText, expectExit, expectStdout, expectFiles) {
  n++;
  const dir = `/tmp/mend-audit/c2-${n}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) { const d = join(dir, dirname(p)); mkdirSync(d, { recursive: true }); writeFileSync(join(dir, p), c); }
  let patchFile = null;
  if (patchText !== null) { patchFile = join(dir, 'patch.txt'); writeFileSync(patchFile, patchText); }
  let code, out;
  try { out = execFileSync('node', [MAIN, ...args.map(a => a === 'PATCH' ? patchFile : a)], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); code = 0; }
  catch (e) { code = e.status; out = e.stdout || ''; }
  const gotFiles = {};
  for (const p of Object.keys(expectFiles)) gotFiles[p] = existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null;
  const ok = code === expectExit && out === expectStdout && JSON.stringify(gotFiles) === JSON.stringify(expectFiles);
  if (ok) console.log(`PASS ${name}`);
  else { console.log(`FAIL ${name}`); if (code !== expectExit) console.log(`  exit: got ${code} want ${expectExit}`); if (out !== expectStdout) console.log(`  stdout: got ${JSON.stringify(out)} want ${JSON.stringify(expectStdout)}`); if (JSON.stringify(gotFiles) !== JSON.stringify(expectFiles)) console.log(`  files: got ${JSON.stringify(gotFiles)} want ${JSON.stringify(expectFiles)}`); fails.push(name); }
}

// D9: diff --git with spaces in paths (SPEC s6: section starts at `diff --git a/<X> b/<Y>`)
runCase('D9-diffgit-spaces',
  { 'my file.txt': 'hello\nworld\n' },
  ['PATCH'],
  'diff --git a/my file.txt b/my file.txt\n--- a/my file.txt\n+++ b/my file.txt\n@@ -1,2 +1,2 @@\n-hello\n+hi\n world\n',
  0, 'M my file.txt\nok: 1 file\n', { 'my file.txt': 'hi\nworld\n' });

// Unified: rename-only section, no hunks -> move, R line
runCase('U-rename-only',
  { 'old.txt': 'same\n' },
  ['PATCH'],
  'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n',
  0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'same\n' });

// Unified: delete with a hunk that would not match -> hunks not read, delete succeeds
runCase('U-delete-hunks-ignored',
  { 'f.txt': 'x\n' },
  ['PATCH'],
  '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-nope\n',
  0, 'D f.txt\nok: 1 file\n', { 'f.txt': null });

// Unified: create, \\ after last + -> no trailing break
runCase('U-create-no-trailing-break',
  {},
  ['PATCH'],
  '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
  0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'one\ntwo' });

// Unified: --- not followed by +++ inside header -> parse <line after it>
runCase('U-lone-triple-dash-in-header',
  { 'f.txt': 'a\n' },
  ['PATCH'],
  'diff --git a/f.txt b/f.txt\n--- a/f.txt\nindex 1234\n',
  2, 'error: parse 3\n', { 'f.txt': 'a\n' });

// SR: second block with no path line takes previous path
runCase('SR-second-block-inherits-path',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'A\nB\nc\n' });

// SR: empty old + empty new -> creates empty file
runCase('SR-empty-create-empty',
  {},
  ['PATCH'],
  'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
  0, 'A new.txt\nok: 1 file\n', { 'new.txt': '' });

// JSON: str_replace overlapping occurrence -> ambiguous
runCase('J-overlap-ambiguous',
  { 'f.txt': 'aaa\n' },
  ['PATCH'],
  '[{"command": "str_replace", "path": "f.txt", "old_str": "aa", "new_str": "b"}]',
  1, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'aaa\n' });

// JSON: insert at line == number of lines (append)
runCase('J-insert-append',
  { 'f.txt': 'a\nb\n' },
  ['PATCH'],
  '{"command": "insert", "path": "f.txt", "insert_line": 2, "new_str": "c"}',
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nb\nc\n' });

// JSON: insert_line negative -> no-match
runCase('J-insert-neg',
  { 'f.txt': 'a\n' },
  ['PATCH'],
  '{"command": "insert", "path": "f.txt", "insert_line": -1, "new_str": "x"}',
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'a\n' });

// JSON: create with CRLF in file_text written byte for byte
runCase('J-create-crlf-bytes',
  {},
  ['PATCH'],
  '{"command": "create", "path": "n.txt", "file_text": "a\\r\\nb\\r\\n"}',
  0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'a\r\nb\r\n' });

// JSON: str_replace in CRLF file, old_str with LF
runCase('J-strreplace-crlf',
  { 'f.txt': 'a\r\nb\r\n' },
  ['PATCH'],
  '{"command": "str_replace", "path": "f.txt", "old_str": "a\\nb", "new_str": "x\\ny"}',
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'x\r\ny\r\n' });

// CLI: two positionals -> usage
runCase('CLI-two-positionals',
  { 'p.txt': 'x' },
  ['PATCH', 'other.txt'],
  'x',
  2, 'error: usage\n', { 'p.txt': 'x' });

// CLI: --format=JSON uppercase -> usage
runCase('CLI-format-uppercase',
  {},
  ['--format=JSON', 'PATCH'],
  '{"command": "create", "path": "n.txt", "file_text": "x"}',
  2, 'error: usage\n', {});

// CLI: unknown option -> usage
runCase('CLI-unknown-option',
  {},
  ['--bogus', 'PATCH'],
  'x',
  2, 'error: usage\n', {});

// CLI: --check with failing edit -> exit 1, no writes
runCase('CLI-check-fail-no-write',
  { 'f.txt': 'a\n' },
  ['--check', 'PATCH'],
  'f.txt\n<<<<<<< SEARCH\nzzz\n=======\nZ\n>>>>>>> REPLACE\n',
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', { 'f.txt': 'a\n' });

// V4A: Update with only Move to, no chunks -> pure move
runCase('V4A-move-only',
  { 'old.txt': 'data\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
  0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'data\n' });

// V4A: chunk with empty O + anchor -> insert at cursor (after anchor)
runCase('V4A-empty-O-anchor',
  { 'f.txt': 'head\ntail\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ head\n+ins\n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'head\nins\ntail\n' });

// Unified: hunk O empty, A beyond EOF -> insert at end
runCase('U-empty-O-beyond-eof',
  { 'f.txt': 'a\n' },
  ['PATCH'],
  '--- a/f.txt\n+++ b/f.txt\n@@ -99,0 +99,1 @@\n+zzz\n',
  0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nzzz\n' });

// Output order: byte order, Z before a
runCase('OUT-byte-order',
  {},
  ['PATCH'],
  '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n--- /dev/null\n+++ b/Z.txt\n@@ -0,0 +1 @@\n+y\n',
  0, 'A Z.txt\nA a.txt\nok: 2 files\n', { 'a.txt': 'x\n', 'Z.txt': 'y\n' });

// Detect: blank lines then Begin Patch -> v4a
runCase('DET-blank-then-v4a',
  { 'f.txt': 'a\n' },
  ['PATCH'],
  '\n\n  \n*** Begin Patch\n*** Delete File: f.txt\n*** End Patch\n',
  0, 'D f.txt\nok: 1 file\n', { 'f.txt': null });

// --format=unified with prose only -> parse 1
runCase('FMT-unified-no-edits',
  {},
  ['--format=unified', 'PATCH'],
  'just some prose\nno diff here\n',
  2, 'error: parse 1\n', {});

console.log(`\n${n - fails.length}/${n} passed; FAILURES: ${fails.join(', ') || 'none'}`);
