// Adversarial repros vs SPEC.md, run against v1 main.ts. Each case: setup files, patch, expected per SPEC text.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = '/home/hatch/workspace/make-fun-art/hidden-spec-cli-01-run-20261122-v2/main.ts';
let n = 0, fails = [];
function runCase(name, files, args, patchText, expectExit, expectStdout, expectFiles) {
  n++;
  const dir = `/tmp/mend-audit/case${n}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  function dirname(p){ return p.split('/').slice(0,-1).join('/') || '.'; }
  let patchFile = null;
  if (patchText !== null) { patchFile = join(dir, 'patch.txt'); writeFileSync(patchFile, patchText); }
  let code, out;
  try {
    out = execFileSync('node', [MAIN, ...args.map(a => a === 'PATCH' ? patchFile : a)], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    code = 0;
  } catch (e) { code = e.status; out = e.stdout || ''; }
  const gotFiles = {};
  for (const p of Object.keys(expectFiles)) {
    gotFiles[p] = existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null;
  }
  const okExit = code === expectExit, okOut = out === expectStdout;
  const okFiles = JSON.stringify(gotFiles) === JSON.stringify(expectFiles);
  if (okExit && okOut && okFiles) { console.log(`PASS ${name}`); }
  else {
    console.log(`FAIL ${name}`);
    if (!okExit) console.log(`  exit: got ${code} want ${expectExit}`);
    if (!okOut) console.log(`  stdout: got ${JSON.stringify(out)} want ${JSON.stringify(expectStdout)}`);
    if (!okFiles) console.log(`  files: got ${JSON.stringify(gotFiles)} want ${JSON.stringify(expectFiles)}`);
    fails.push(name);
  }
}

// D1: tier-2 re-indent, N line NOT starting with P -> F PREPENDED (house reference behavior,
// proven by practice check v-indent 6b3a9d: expected '  } // node'. v1 is CORRECT; do NOT 'fix' this.
runCase('D1-tier2-noprefix-as-is',
  { 'f.js': 'function f() {\n  x = 1;\n  return x;\n}\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.js\n x = 1;\n return x;\n-}\n+} // done\n*** End Patch\n',
  0, 'M f.js\nok: 1 file\n',
  { 'f.js': 'function f() {\n  x = 1;\n  return x;\n  } // done\n' });

// D1b: tier-2, N line starting with P -> P replaced by F (control, should already pass)
runCase('D1b-tier2-prefix-replaced',
  { 'f.js': '    a\n    b\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.js\n  a\n-  b\n+    b2\n*** End Patch\n',
  0, 'M f.js\nok: 1 file\n',
  { 'f.js': '    a\n       b2\n' });

// D31: V4A blank line after *** End of File, before *** End Patch -> ignored (SPEC s8)
runCase('D31-v4a-blank-after-eof',
  { 'f.txt': 'a\nb\nc\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n\n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n',
  { 'f.txt': 'a\nB\nc\n' });

// D31b: V4A blank line after *** End of File, before next section -> ignored
runCase('D31b-v4a-blank-after-eof-next-section',
  { 'f.txt': 'a\nb\nc\n', 'g.txt': 'x\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n\n*** Update File: g.txt\n x\n-x\n+y\n*** End Patch\n',
  0, 'M f.txt\nM g.txt\nok: 2 files\n',
  { 'f.txt': 'a\nB\nc\n', 'g.txt': 'y\n' });

// D31c: V4A blank line after *** End of File, then @@ chunk -> ? (ambiguous; record behavior)
runCase('D31c-v4a-blank-after-eof-then-chunk',
  { 'f.txt': 'a\nb\nc\nd\n' },
  ['PATCH'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n\n@@ c\n c\n-c\n+C\n*** End Patch\n',
  0, 'M f.txt\nok: 1 file\n',
  { 'f.txt': 'a\nB\nC\nd\n' });

console.log(`\n${n - fails.length}/${n} passed; FAILURES: ${fails.join(', ') || 'none'}`);
