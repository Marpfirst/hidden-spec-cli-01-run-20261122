// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7), V4A patches (section 8), matching lines at three tiers (section 5), and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line as a tier sees it (SPEC.md section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O occurs in lines at one tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const no = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs at least once at or after `from`, with its occurrences. */
function findOccurrences(lines: string[], o: string[], strict: boolean, from: number): Found | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One chunk of old lines O replaced by new lines N; nCtx maps an N index to its O index for context lines. */
interface Chunk {
  o: string[];
  n: string[];
  nCtx: Map<number, number>;
}

/** N with context lines taken from the file's own matched lines, and tier-2 re-indentation (section 5). */
function chunkNewLines(c: Chunk, matched: string[], tier: number): string[] {
  const f = leadingWS(matched.length > 0 ? matched[0]! : '');
  const p = leadingWS(c.o.length > 0 ? c.o[0]! : '');
  return c.n.map((l, ni) => {
    const oi = c.nCtx.get(ni);
    if (oi !== undefined) return matched[oi]!;
    if (tier !== 2) return l;
    if (l === '' || /^[ \t]+$/.test(l)) return l;
    return l.startsWith(p) ? f + l.slice(p.length) : l;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path holds a file in the tree, or exists on disk at all (a directory counts). */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;
type Moves = Array<[string, string]>;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk extends Chunk {
  a: number;
  plus: string[];
  lastPlusBs: boolean;
  noNlAfterLast: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  hasHeaderPair: boolean;
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, trimmed, leading a/ or b/ removed. Null is /dev/null. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

interface BodyEl {
  kind: ' ' | '-' | '+';
  text: string;
  rawEmpty: boolean;
  bs: boolean;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const line = lines[i]!;
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const els: BodyEl[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      els.push({ kind: ' ', text: '', rawEmpty: true, bs: false });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      els.push({ kind: c, text: l.slice(1), rawEmpty: false, bs: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (els.length > 0) els[els.length - 1]!.bs = true;
      j++;
      continue;
    }
    break;
  }
  while (els.length > 0 && els[els.length - 1]!.rawEmpty) els.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nCtx = new Map<number, number>();
  const plus: string[] = [];
  for (const el of els) {
    if (el.kind === ' ') {
      nCtx.set(n.length, o.length);
      o.push(el.text);
      n.push(el.text);
    } else if (el.kind === '-') {
      o.push(el.text);
    } else {
      n.push(el.text);
      plus.push(el.text);
    }
  }
  let noNlAfterLast = false;
  for (let k = els.length - 1; k >= 0; k--) {
    const el = els[k]!;
    if (el.kind === ' ' || el.kind === '+') {
      noNlAfterLast = el.bs;
      break;
    }
  }
  let lastPlusBs = false;
  for (let k = els.length - 1; k >= 0; k--) {
    if (els[k]!.kind === '+') {
      lastPlusBs = els[k]!.bs;
      break;
    }
  }
  return { hunk: { o, n, nCtx, a, plus, lastPlusBs, noNlAfterLast }, next: j };
}

/** Apply a section's hunks in order to a file's lines (section 6). */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const wasEnd = at === state.lines.length;
      const nl = chunkNewLines(h, [], 0);
      state.lines.splice(at, 0, ...nl);
      if (wasEnd) state.final = !h.noNlAfterLast;
      d += nl.length;
      continue;
    }
    const found = findOccurrences(state.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const matched = state.lines.slice(best, best + h.o.length);
    const nl = chunkNewLines(h, matched, found.tier);
    const touchesEnd = best + h.o.length === state.lines.length;
    state.lines.splice(best, h.o.length, ...nl);
    if (touchesEnd) state.final = !h.noNlAfterLast;
    d += nl.length - h.o.length;
  }
}

function unifiedEdit(sec: Section, strict: boolean, moves: Moves): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null || sec.create) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) plus.push(...h.plus);
      let noNl = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.plus.length > 0) {
          noNl = sec.hunks[k]!.lastPlusBs;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP === null || sec.del) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.exists(newP)) throw new Fail('exists', newP);
    const st = parseFile(before);
    applyHunks(st, sec.hunks, strict, oldP);
    const out = serializeFile(st);
    if (oldP !== newP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, create: false, del: false, hunks: [], hasHeaderPair: false };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.oldPath = m[1]!;
      s.newPath = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasHeaderPair) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasHeaderPair = true;
      } else {
        const s = newSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        s.hasHeaderPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      inHeader = false;
      i = h.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.hasHeaderPair) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.hasHeaderPair) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = parseFile(before);
    const found = findOccurrences(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const matched = st.lines.slice(pos, pos + oldLines.length);
    const chunk: Chunk = { o: oldLines, n: newLines, nCtx: new Map() };
    const nl = chunkNewLines(chunk, matched, found.tier);
    st.lines.splice(pos, oldLines.length, ...nl);
    tree.now.set(path, serializeFile(st));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let j = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${j + 1}`);
      path = prevPath;
    }
    let nextSearch = lines.length;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        nextSearch = k;
        break;
      }
    }
    let eq = -1;
    for (let k = j + 1; k < nextSearch; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < nextSearch; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${j + 1}`);
    const oldLines = lines.slice(j + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk extends Chunk {
  anchor: string | null;
  eof: boolean;
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `cursor` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = Math.max(0, cursor); i < lines.length; i++) {
      if (normLine(lines[i]!, tier) === normLine(anchor, tier)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `cursor`, at the first tier with one (end-of-file chunks only take one ending at the last line). */
function findChunkOccurrence(lines: string[], o: string[], cursor: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(lines, o, tier, cursor).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { pos: occ[0]!, tier };
  }
  return null;
}

function v4aUpdateEdit(
  path: string,
  secLines: Array<{ text: string; no: number }>,
  updateLineNo: number,
  strict: boolean,
  moves: Moves,
): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  for (; idx < secLines.length; idx++) {
    const sl = secLines[idx]!;
    const t = sl.text;
    if (t.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = t.slice(2).trim();
      cur = { o: [], n: [], nCtx: new Map(), anchor: a === '' ? null : a, eof: false };
      started = true;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (!started) {
          cur = { o: [], n: [], nCtx: new Map(), anchor: null, eof: false };
          started = true;
        } else {
          throw new Exit2(`error: parse ${sl.no}`);
        }
      }
      if (t === '') {
        cur.nCtx.set(cur.n.length, cur.o.length);
        cur.o.push('');
        cur.n.push('');
      } else if (t[0] === ' ') {
        cur.nCtx.set(cur.n.length, cur.o.length);
        cur.o.push(t.slice(1));
        cur.n.push(t.slice(1));
      } else if (t[0] === '-') {
        cur.o.push(t.slice(1));
      } else {
        cur.n.push(t.slice(1));
      }
      continue;
    }
    if (t.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${sl.no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    throw new Exit2(`error: parse ${sl.no}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const st = parseFile(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const ai = findAnchor(st.lines, c.anchor, cursor, strict);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? st.lines.length : cursor;
        const nl = chunkNewLines(c, [], 0);
        st.lines.splice(at, 0, ...nl);
        cursor = at + nl.length;
        continue;
      }
      const occ = findChunkOccurrence(st.lines, c.o, cursor, strict, c.eof);
      if (occ === null) throw new Fail('no-match', path);
      const matched = st.lines.slice(occ.pos, occ.pos + c.o.length);
      const nl = chunkNewLines(c, matched, occ.tier);
      st.lines.splice(occ.pos, c.o.length, ...nl);
      cursor = occ.pos + nl.length;
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    const kind = v4aSectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const secLines: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j]!) === null) {
      secLines.push({ text: lines[j]!, no: j + 1 });
      j++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text === '') fileLines.push('');
        else if (sl.text[0] === '+') fileLines.push(sl.text.slice(1));
        else throw new Exit2(`error: parse ${sl.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.no}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, secLines, i + 1, strict, moves));
    }
    i = j;
  }
  return edits;
}

// ---- Running the CLI (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Moves = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (!covered.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
