// Corrected D31 variants: same shapes as /tmp/mend-audit/repro.mjs D31/D31b/D31c, but with
// EOF chunks whose O really ends at the file's last line (as the generator emits them).
// The original repro cases use O=['a','b'] in file ['a','b','c'] with *** End of File, which
// SPEC s8 forbids from matching ("an end-of-file chunk takes only an occurrence that ends
// at the file's last line") -- the same chunk+file is the 128-suite's v4a-eof-nomatch case,
// which expects no-match. So the originals cannot succeed however the blank line is handled;
// these corrected variants prove the blank-line fix itself works end to end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const MAIN = '/home/hatch/workspace/make-fun-art/hidden-spec-cli-01-run-20261122-v2/main.ts';
let n = 0, fails = [];
function runCase(name, files, args, patchText, expectExit, expectStdout, expectFiles) {
  n++;
  const dir = `/tmp/mend-audit/d31fix-${n}`;
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

// D31-fixed: EOF chunk O=['b','c'] ends at last line; blank after End of File, before End Patch
runCase('D31-fixed-blank-after-eof',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n b\n-c\n+C\n*** End of File\n\n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n',
  { 'f.txt': 'a\nb\nC\n' });

// D31-fixed with a whitespace-only blank line ("   ") after End of File
runCase('D31-fixed-ws-blank-after-eof',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n b\n-c\n+C\n*** End of File\n   \n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n',
  { 'f.txt': 'a\nb\nC\n' });

// D31b-fixed: blank after End of File, before next section
runCase('D31b-fixed-blank-after-eof-next-section',
  { 'f.txt': 'a\nb\nc\n', 'g.txt': 'x\ny\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n b\n-c\n+C\n*** End of File\n\n*** Update File: g.txt\n x\n-y\n+Y\n*** End Patch\n',
  0, 'M f.txt\nM g.txt\nok: 2 files\n',
  { 'f.txt': 'a\nb\nC\n', 'g.txt': 'x\nY\n' });

// D31c-fixed: blank after End of File, then an @@ chunk that can match
// (empty-O insert at the cursor, which sits at end of file after the EOF chunk)
runCase('D31c-fixed-blank-after-eof-then-chunk',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n b\n-c\n+C\n*** End of File\n\n@@\n+tail\n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n',
  { 'f.txt': 'a\nb\nC\ntail\n' });

// Control: the ORIGINAL D31 patch (O=['a','b'] in ['a','b','c']) must be no-match,
// exactly like the 128-suite's v4a-eof-nomatch case (same chunk+file, no blank line).
// This pins the discrepancy: the blank line is skipped (no parse error), the EOF rule decides.
runCase('D31-control-original-is-nomatch',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n\n*** End Patch\n',
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
  { 'f.txt': 'a\nb\nc\n' });

// Control 2: same as above but WITHOUT the blank line -> identical outcome (blank is inert).
runCase('D31-control-noblank-is-nomatch',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n*** End Patch\n',
  1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
  { 'f.txt': 'a\nb\nc\n' });

console.log(`\n${n - fails.length}/${n} passed; FAILURES: ${fails.join(', ') || 'none'}`);
