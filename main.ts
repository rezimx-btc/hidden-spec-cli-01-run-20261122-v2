// mend: applies edits an AI model wrote to a tree of text files.
//
// Four patch formats: unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, and text-editor tool calls as JSON. Every file is changed or
// nothing is. Node 22, standard library alone. See SPEC.md.
//
// When MAKEFUN_ENV_URL is set, this file hands the trial over to runner.ts
// instead of running the CLI (see the end of this file).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse fault: the patch cannot be read in its format at line `line`. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** A file as the editor sees it: lines, its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  brk: string;
  eob: boolean;
}

/** Split patch text (or a JSON new_str) into lines: at `\n`, one trailing `\r` removed each, no empty piece after a final `\n`; empty text has no lines. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** Split a file's text into its model (SPEC section 3). */
function parseFileText(text: string): FileModel {
  if (text === '') return { lines: [], brk: '\n', eob: false };
  const firstLf = text.indexOf('\n');
  const brk = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const eob = text.endsWith(brk);
  const body = eob ? text.slice(0, text.length - brk.length) : text;
  return { lines: body.split(brk), brk, eob };
}

/** Write a file model back to text. A file of no lines is written empty. */
function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.eob ? m.brk : '');
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

const TRAIL_WS = /[ \t]+$/;
const LEAD_WS = /^[ \t]*/;

/** Remove trailing spaces and tabs. */
function rstripWs(s: string): string {
  return s.replace(TRAIL_WS, '');
}

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = LEAD_WS.exec(s);
  return m === null ? '' : m[0];
}

/** Is the line empty or only spaces and tabs. */
function isBlankLine(s: string): boolean {
  return s.trim() === '';
}

/** Compare two lines at a matching tier (SPEC section 5). */
function lineEqAt(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return rstripWs(a).replace(LEAD_WS, '') === rstripWs(b).replace(LEAD_WS, '');
}

/** All 0-based positions at or after `from` where O matches lines at `tier`. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqAt(tier, o[j], lines[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: its text, whether it is a context line, and for context lines its index into O. */
interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Build the replacement lines for a matched O at `pos` (SPEC section 5). A context line is
 * written as the file's own matched line. At tier 2 every other non-empty, non-whitespace-only
 * line of N is re-indented: P (the leading whitespace of O's first line) is replaced by F
 * (that of the file's first matched line) when the line starts with P, and F is put in front
 * of the line when it does not. At tiers 0 and 1 the lines of N are written as they are.
 */
function buildNew(o: string[], n: NewItem[], lines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadingWs(lines[pos]);
    const p = leadingWs(o[0]);
    for (const item of n) {
      if (item.ctx) {
        out.push(lines[pos + item.oIdx]);
      } else if (item.text !== '' && !/^[ \t]+$/.test(item.text)) {
        out.push(item.text.startsWith(p) ? f + item.text.slice(p.length) : f + item.text);
      } else {
        out.push(item.text);
      }
    }
    return out;
  }
  for (const item of n) {
    out.push(item.ctx ? lines[pos + item.oIdx] : item.text);
  }
  return out;
}

/** Compare two paths (or sort keys) in UTF-8 byte order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* Edits and the in-memory tree                                        */
/* ------------------------------------------------------------------ */

interface HunkBodyLine {
  k: 'ctx' | 'del' | 'add' | 'mark';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewItem[];
  eof: boolean;
}

type Edit =
  | { format: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; isMove: boolean; hunks: Hunk[] }
  | { format: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { format: 'v4a-add'; path: string; lines: string[] }
  | { format: 'v4a-delete'; path: string }
  | { format: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { format: 'json-create'; path: string; text: string }
  | { format: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { format: 'json-insert'; path: string; insertLine: number; newStr: string };

interface EditFailure {
  code: string;
  path: string;
}

/** The tree as the patch leaves it: each touched path's bytes before the patch and now. */
interface TreeEntry {
  orig: string | null;
  cur: string | null;
}

const tree = new Map<string, TreeEntry>();
/** Successful moves, for the `R old -> new` output line. */
const moves: { old: string; new: string }[] = [];

function touch(path: string): TreeEntry {
  let e = tree.get(path);
  if (e === undefined) {
    let orig: string | null = null;
    try {
      orig = readFileSync(path, 'utf8');
    } catch {
      orig = null;
    }
    e = { orig, cur: orig };
    tree.set(path, e);
  }
  return e;
}

function treeHas(path: string): boolean {
  return touch(path).cur !== null;
}

function readModel(path: string): FileModel {
  const cur = touch(path).cur;
  return parseFileText(cur === null ? '' : cur);
}

function setModel(path: string, m: FileModel): void {
  touch(path).cur = serializeFile(m);
}

function setText(path: string, text: string): void {
  touch(path).cur = text;
}

function deletePath(path: string): void {
  touch(path).cur = null;
}

/* ------------------------------------------------------------------ */
/* Invocation (SPEC section 1)                                         */
/* ------------------------------------------------------------------ */

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  positional: string | null;
}

function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let positional: string | null = null;
  const seen = new Set<string>();
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash) {
      if (a === '--') {
        afterDashDash = true;
        continue;
      }
      if (a === '--check') {
        if (seen.has('check')) return null;
        seen.add('check');
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seen.has('strict')) return null;
        seen.add('strict');
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seen.has('format')) return null;
        seen.add('format');
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
        continue;
      }
      if (a.startsWith('-') && a !== '-') return null;
    }
    if (positional !== null) return null;
    positional = a;
  }
  return { format, check, strict, positional };
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC section 4)                               */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => !isBlankLine(l));
  if (firstNonBlank !== undefined && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== undefined) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => rstripWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, surrounding spaces removed, one leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function toBodyLine(line: string): HunkBodyLine {
  if (line === '') return { k: 'ctx', text: '' };
  const c = line[0];
  if (c === ' ') return { k: 'ctx', text: line.slice(1) };
  if (c === '-') return { k: 'del', text: line.slice(1) };
  if (c === '+') return { k: 'add', text: line.slice(1) };
  return { k: 'mark', text: line.slice(1) };
}

/** O and N of a hunk, in body order, with context flags on N. */
function hunkON(hunk: Hunk): { o: string[]; n: NewItem[] } {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const b of hunk.body) {
    if (b.k === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.k === 'del') {
      o.push(b.text);
    } else if (b.k === 'add') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function lastCtxOrAddHasMark(hunk: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < hunk.body.length; i++) {
    if (hunk.body[i].k === 'ctx' || hunk.body[i].k === 'add') last = i;
  }
  if (last === -1) return false;
  return hunk.body[last + 1] !== undefined && hunk.body[last + 1].k === 'mark';
}

/** Does a `\` line follow the section's last `+` line (for a created file)? */
function lastAddHasMark(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h].body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].k === 'add') return body[i + 1] !== undefined && body[i + 1].k === 'mark';
    }
  }
  return false;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let inBody = false;
  let curHunk: Hunk | null = null;
  const newSection = (diffOld: string | null, diffNew: string | null): UnifiedSection => ({
    diffOld,
    diffNew,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const finishBody = (): void => {
    if (curHunk !== null) {
      while (
        curHunk.body.length > 0 &&
        curHunk.body[curHunk.body.length - 1].k === 'ctx' &&
        curHunk.body[curHunk.body.length - 1].text === ''
      ) {
        curHunk.body.pop();
      }
    }
    curHunk = null;
    inBody = false;
  };
  const finishSection = (): void => {
    finishBody();
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (inBody) {
      const isDiffGit = line.startsWith('diff --git ');
      const isPair = line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ');
      const isBodyLine =
        line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
      if (!isDiffGit && !isPair && isBodyLine) {
        if (curHunk !== null) curHunk.body.push(toBodyLine(line));
        continue;
      }
      finishBody();
      // fall through: this line is dispatched below
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseError(n);
      finishSection();
      cur = newSection(m[1], m[2]);
      inHeader = true;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        i++;
        continue;
      }
      finishSection();
      cur = newSection(null, null);
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new ParseError(n + 1);
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairNew === null) cur.pairNew = headerPath(line);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseError(n);
      if (cur === null) throw new ParseError(n);
      curHunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(curHunk);
      inHeader = false;
      inBody = true;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  finishSection();
  if (sections.length === 0) throw new ParseError(1);
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld !== null ? s.pairOld : s.renameFrom !== null ? s.renameFrom : s.diffOld;
    const newPath = s.pairNew !== null ? s.pairNew : s.renameTo !== null ? s.renameTo : s.diffNew;
    const oldIsNull = oldPath === '/dev/null';
    const newIsNull = newPath === '/dev/null';
    const oldP = oldIsNull ? null : oldPath;
    const newP = newIsNull ? null : newPath;
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    edits.push({ format: 'unified', oldPath: oldP, newPath: newP, isCreate, isDelete, isMove, hunks: s.hunks });
  }
  return edits;
}

function applyUnified(edit: Extract<Edit, { format: 'unified' }>, strict: boolean): EditFailure | null {
  const { oldPath, newPath, isCreate, isDelete, isMove, hunks } = edit;
  const checkPaths: (string | null)[] = isCreate
    ? [newPath]
    : isDelete
      ? [oldPath]
      : isMove
        ? [oldPath, newPath]
        : [oldPath];
  for (const p of checkPaths) {
    if (p !== null && !isSafePath(p)) return { code: 'unsafe', path: p };
  }
  if (isCreate) {
    if (newPath === null) return null;
    if (treeHas(newPath)) return { code: 'exists', path: newPath };
    const lines: string[] = [];
    for (const h of hunks) for (const b of h.body) if (b.k === 'add') lines.push(b.text);
    setModel(newPath, { lines, brk: '\n', eob: !lastAddHasMark(hunks) });
    return null;
  }
  if (isDelete) {
    if (oldPath === null) return null;
    if (!treeHas(oldPath)) return { code: 'missing', path: oldPath };
    deletePath(oldPath);
    return null;
  }
  if (oldPath === null) return null;
  if (!treeHas(oldPath)) return { code: 'missing', path: oldPath };
  if (isMove && newPath !== null && treeHas(newPath)) return { code: 'exists', path: newPath };
  const model = readModel(oldPath);
  let lines = model.lines;
  let eob = model.eob;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk);
    if (o.length === 0) {
      let idx = hunk.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
      if (atEnd) eob = !lastCtxOrAddHasMark(hunk);
      d += n.length;
    } else {
      const found = findTier(lines, o, 0, strict);
      if (found === null) return { code: 'no-match', path: oldPath };
      const target = hunk.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const runsToEnd = pos + o.length === lines.length;
      const newLines = buildNew(o, n, lines, pos, found.tier);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + o.length)];
      if (runsToEnd) eob = !lastCtxOrAddHasMark(hunk);
      d += n.length - o.length;
    }
  }
  if (isMove && newPath !== null) {
    deletePath(oldPath);
    setModel(newPath, { lines, brk: model.brk, eob });
    moves.push({ old: oldPath, new: newPath });
  } else {
    setModel(oldPath, { lines, brk: model.brk, eob });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rstripWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const cand = lines[j];
      if (cand.trim() === '') continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(i + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = rstripWs(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseError(i + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (rstripWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseError(i + 1);
    edits.push({ format: 'sr', path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applySR(edit: Extract<Edit, { format: 'sr' }>, strict: boolean): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.oldLines.length === 0) {
    if (treeHas(edit.path)) return { code: 'exists', path: edit.path };
    setModel(edit.path, { lines: [...edit.newLines], brk: '\n', eob: true });
    return null;
  }
  if (!treeHas(edit.path)) return { code: 'missing', path: edit.path };
  const model = readModel(edit.path);
  const found = findTier(model.lines, edit.oldLines, 0, strict);
  if (found === null) return { code: 'no-match', path: edit.path };
  if (found.positions.length > 1) return { code: 'ambiguous', path: edit.path };
  const pos = found.positions[0];
  const nItems: NewItem[] = edit.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  const newLines = buildNew(edit.oldLines, nItems, model.lines, pos, found.tier);
  const lines = [
    ...model.lines.slice(0, pos),
    ...newLines,
    ...model.lines.slice(pos + edit.oldLines.length),
  ];
  setModel(edit.path, { lines, brk: model.brk, eob: model.eob });
  return null;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4aSectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
  return line.slice(prefix.length).trim();
}

interface RawLine {
  text: string;
  no: number;
}

function addChunkBodyLine(chunk: VChunk, b: HunkBodyLine): void {
  if (b.k === 'ctx') {
    chunk.o.push(b.text);
    chunk.n.push({ text: b.text, ctx: true, oIdx: chunk.o.length - 1 });
  } else if (b.k === 'del') {
    chunk.o.push(b.text);
  } else if (b.k === 'add') {
    chunk.n.push({ text: b.text, ctx: false, oIdx: -1 });
  }
}

function parseV4AUpdate(path: string, raw: RawLine[], sectionLineNo: number): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0].text.startsWith('*** Move to:')) {
    moveTo = raw[0].text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  const openChunk = (anchor: string | null): VChunk => {
    const c: VChunk = { anchor, o: [], n: [], eof: false };
    chunks.push(c);
    started = true;
    return c;
  };
  for (; idx < raw.length; idx++) {
    const { text, no } = raw[idx];
    if (text.startsWith('@@')) {
      cur = openChunk(text.slice(2).trim() === '' ? null : text.slice(2).trim());
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) {
        const c: VChunk = { anchor: null, o: [], n: [], eof: true };
        chunks.push(c);
        started = true;
      } else {
        cur.eof = true;
        cur = null;
      }
      continue;
    }
    if (isBlankLine(text)) {
      // Blank lines after a chunk closed by `*** End of File` are skipped (D31). A blank
      // line before the first chunk, or inside an open chunk, is an empty context line.
      if (cur === null && started) continue;
      if (cur === null) cur = openChunk(null);
      addChunkBodyLine(cur, { k: 'ctx', text: '' });
      continue;
    }
    if (text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      // A non-blank body line after `*** End of File` without a new `@@` is a parse error.
      if (cur === null && started) throw new ParseError(no);
      if (cur === null) cur = openChunk(null);
      addChunkBodyLine(cur, toBodyLine(text));
      continue;
    }
    throw new ParseError(no);
  }
  if (!started && moveTo === null) throw new ParseError(sectionLineNo);
  return { format: 'v4a-update', path, moveTo, chunks };
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlankLine(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlankLine(lines[i])) i++;
    if (i >= last) break;
    const kind = v4aSectionKind(lines[i]);
    if (kind === null) throw new ParseError(i + 1);
    const sectionLineNo = i + 1;
    const path = v4aSectionPath(lines[i], kind);
    const raw: RawLine[] = [];
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j]) === null) {
      raw.push({ text: lines[j], no: j + 1 });
      j++;
    }
    while (raw.length > 0 && isBlankLine(raw[raw.length - 1].text)) raw.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) out.push(r.text.slice(1));
        else if (r.text === '') out.push('');
        else throw new ParseError(r.no);
      }
      edits.push({ format: 'v4a-add', path, lines: out });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new ParseError(raw[0].no);
      edits.push({ format: 'v4a-delete', path });
    } else {
      edits.push(parseV4AUpdate(path, raw, sectionLineNo));
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** First line at or after `cursor` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEqAt(t, anchor, lines[i])) return i;
    }
  }
  return -1;
}

function applyV4AAdd(edit: Extract<Edit, { format: 'v4a-add' }>): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (treeHas(edit.path)) return { code: 'exists', path: edit.path };
  setModel(edit.path, { lines: [...edit.lines], brk: '\n', eob: true });
  return null;
}

function applyV4ADelete(edit: Extract<Edit, { format: 'v4a-delete' }>): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (!treeHas(edit.path)) return { code: 'missing', path: edit.path };
  deletePath(edit.path);
  return null;
}

function applyV4AUpdate(edit: Extract<Edit, { format: 'v4a-update' }>, strict: boolean): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
  if (!treeHas(edit.path)) return { code: 'missing', path: edit.path };
  if (edit.moveTo !== null && treeHas(edit.moveTo)) return { code: 'exists', path: edit.moveTo };
  const model = readModel(edit.path);
  let lines = model.lines;
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null) {
      const idx = findAnchor(lines, chunk.anchor, cursor, strict);
      if (idx === -1) return { code: 'no-match', path: edit.path };
      cursor = idx + 1;
    }
    if (chunk.o.length === 0) {
      const insAt = chunk.eof ? lines.length : cursor;
      const ins = chunk.n.map((x) => x.text);
      lines = [...lines.slice(0, insAt), ...ins, ...lines.slice(insAt)];
      cursor = insAt + ins.length;
    } else {
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; positions: number[] } | null = null;
      for (const t of tiers) {
        let pos = occurrences(lines, chunk.o, t, cursor);
        if (chunk.eof) pos = pos.filter((p) => p + chunk.o.length === lines.length);
        if (pos.length > 0) {
          found = { tier: t, positions: pos };
          break;
        }
      }
      if (found === null) return { code: 'no-match', path: edit.path };
      const pos = found.positions[0];
      const newLines = buildNew(chunk.o, chunk.n, lines, pos, found.tier);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + chunk.o.length)];
      cursor = pos + newLines.length;
    }
  }
  if (edit.moveTo !== null) {
    deletePath(edit.path);
    setModel(edit.moveTo, { lines, brk: model.brk, eob: model.eob });
    moves.push({ old: edit.path, new: edit.moveTo });
  } else {
    setModel(edit.path, { lines, brk: model.brk, eob: model.eob });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

function validateEditObject(obj: unknown, lineNo: number): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(lineNo);
  if (typeof o.command !== 'string') throw new ParseError(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
    return { format: 'json-create', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { format: 'json-str-replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { format: 'json-insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw new ParseError(lineNo);
}

function parseJSON(lines: string[], rawText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  if (lines[firstIdx].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const obj of arr) edits.push(validateEditObject(obj, firstIdx + 1));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applyJSONCreate(edit: Extract<Edit, { format: 'json-create' }>): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (treeHas(edit.path)) return { code: 'exists', path: edit.path };
  setText(edit.path, edit.text);
  return null;
}

function applyJSONStrReplace(edit: Extract<Edit, { format: 'json-str-replace' }>): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (!treeHas(edit.path)) return { code: 'missing', path: edit.path };
  const cur = touch(edit.path).cur ?? '';
  const model = parseFileText(cur);
  let text = cur;
  let oldStr = edit.oldStr;
  let newStr = edit.newStr;
  if (model.brk === '\r\n') {
    text = cur.replace(/\r\n/g, '\n');
    oldStr = edit.oldStr.replace(/\r\n/g, '\n');
    newStr = edit.newStr.replace(/\r\n/g, '\n');
  }
  let count = 0;
  let firstIdx = -1;
  let from = 0;
  while (true) {
    const idx = text.indexOf(oldStr, from);
    if (idx === -1) break;
    count++;
    if (firstIdx === -1) firstIdx = idx;
    if (count > 1) break;
    from = idx + 1;
  }
  if (count === 0) return { code: 'no-match', path: edit.path };
  if (count > 1) return { code: 'ambiguous', path: edit.path };
  let result = text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
  if (model.brk === '\r\n') result = result.replace(/\n/g, '\r\n');
  setText(edit.path, result);
  return null;
}

function applyJSONInsert(edit: Extract<Edit, { format: 'json-insert' }>): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (!treeHas(edit.path)) return { code: 'missing', path: edit.path };
  const model = readModel(edit.path);
  if (edit.insertLine < 0 || edit.insertLine > model.lines.length) return { code: 'no-match', path: edit.path };
  const insLines = splitPatchLines(edit.newStr);
  const lines = [
    ...model.lines.slice(0, edit.insertLine),
    ...insLines,
    ...model.lines.slice(edit.insertLine),
  ];
  setModel(edit.path, { lines, brk: model.brk, eob: model.eob });
  return null;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC sections 2 and 10)                            */
/* ------------------------------------------------------------------ */

function applyEdit(edit: Edit, strict: boolean): EditFailure | null {
  switch (edit.format) {
    case 'unified':
      return applyUnified(edit, strict);
    case 'sr':
      return applySR(edit, strict);
    case 'v4a-add':
      return applyV4AAdd(edit);
    case 'v4a-delete':
      return applyV4ADelete(edit);
    case 'v4a-update':
      return applyV4AUpdate(edit, strict);
    case 'json-create':
      return applyJSONCreate(edit);
    case 'json-str-replace':
      return applyJSONStrReplace(edit);
    case 'json-insert':
      return applyJSONInsert(edit);
  }
}

function run(): number {
  const outLines: string[] = [];
  const out = (s: string): void => {
    outLines.push(s);
  };
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    out('error: usage');
    process.stdout.write(outLines.map((l) => l + '\n').join(''));
    return 2;
  }
  let patchText: string;
  if (opts.positional === null || opts.positional === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.positional, 'utf8');
    } catch {
      out('error: no-patch');
      process.stdout.write(outLines.map((l) => l + '\n').join(''));
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  let edits: Edit[];
  try {
    const fmt = opts.format === 'auto' ? detectFormat(lines) : opts.format;
    if (fmt === null) {
      out('error: format');
      process.stdout.write(outLines.map((l) => l + '\n').join(''));
      return 2;
    }
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      out(`error: parse ${e.line}`);
      process.stdout.write(outLines.map((l) => l + '\n').join(''));
      return 2;
    }
    throw e;
  }
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const f = applyEdit(edit, opts.strict);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(outLines.map((l) => l + '\n').join(''));
    return 1;
  }
  const changeLines: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of moves) {
    const o = tree.get(m.old);
    const n = tree.get(m.new);
    if (o !== undefined && n !== undefined && o.orig !== null && o.cur === null && n.orig === null && n.cur !== null) {
      changeLines.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      suppressed.add(m.old);
      suppressed.add(m.new);
    }
  }
  for (const [path, st] of tree) {
    if (suppressed.has(path)) continue;
    if (st.orig === st.cur) continue;
    if (st.orig === null) changeLines.push({ key: path, line: `A ${path}` });
    else if (st.cur === null) changeLines.push({ key: path, line: `D ${path}` });
    else changeLines.push({ key: path, line: `M ${path}` });
  }
  changeLines.sort((a, b) => byteCompare(a.key, b.key));
  for (const c of changeLines) out(c.line);
  const n = changeLines.length;
  out(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  process.stdout.write(outLines.map((l) => l + '\n').join(''));
  if (!opts.check) {
    for (const [path, st] of tree) {
      if (st.orig === st.cur) continue;
      if (st.cur === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, st.cur);
      }
    }
  }
  return 0;
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = run();
}
