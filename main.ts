// mend: one patch tool for every AI edit format (SPEC.md is the contract).
//
// Reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, or JSON edit
// objects — applies every edit to the tree rooted at the working directory, and writes every
// change or none. Lines an edit names are found at the first of three matching tiers (exact,
// trailing-whitespace-insensitive, fully whitespace-insensitive) unless --strict is given.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines of
// this file then hand over to runner.ts, which runs this CLI on each of the trial's checks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with a SPEC.md section 2 code at a path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is relative, backslash-free and has no empty, dot or dotdot segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// File model (section 3): a file is its lines, its own line break, and
// whether it ends with that break. An empty file has no lines and no break.
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** A file an edit creates: LF breaks, ending with a break unless a format says otherwise. */
function createdText(lines: string[], finalBreak: boolean): string {
  return writeModel({ lines, br: '\n', final: finalBreak });
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it. `now` holds every path an edit touched
// (null: deleted); anything else is read from disk, once, as the original.
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

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
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (section 5). Tier 0 is exact; tier 1 ignores trailing
// spaces and tabs; tier 2 ignores leading and trailing spaces and tabs.
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every start position, at or after `from`, where O's lines match the file's lines at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when none does. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A line of N: its patch text, and for a context line its index in O (else -1). */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines to write for N, once O has matched at `pos`: a context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented, the file's first
 * matched line's leading whitespace F replacing O's first line's P where the line starts
 * with P and is not only whitespace.
 */
function renderN(n: NLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(o[0]!);
  }
  return n.map((it) => {
    if (it.ctx >= 0) return fileLines[pos + it.ctx]!;
    if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(p)) return f + it.text.slice(p.length);
    return it.text;
  });
}

/** One patch body line, shared by unified hunks and V4A chunks. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

/** Split a hunk/chunk body into O (context and old lines) and N (context and new lines). */
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function backslashAfterLastNew(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === 'ctx' || k === 'new') return i + 1 < body.length && body[i + 1]!.kind === 'bs';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function newSection(): USection {
  return {
    gitOld: null,
    gitNew: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

/** The path on a --- or +++ line: after the four characters, to the first tab, spaces removed. */
function pairPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const pairAt = (j: number): boolean =>
    (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || pairAt(i)) break;
        const c = bl.charAt(0);
        if (bl === '') body.push({ kind: 'ctx', text: '', raw: bl });
        else if (c === ' ') body.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
        else if (c === '-') body.push({ kind: 'old', text: bl.slice(1), raw: bl });
        else if (c === '+') body.push({ kind: 'new', text: bl.slice(1), raw: bl });
        else if (c === '\\') body.push({ kind: 'bs', text: bl.slice(1), raw: bl });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (pairAt(i)) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) {
        cur = newSection();
        sections.push(cur);
      }
      cur.pairOld = pairPath(lines[i]!);
      cur.pairNew = pairPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // Outside bodies and headers, lines are ignored.
  }
  return sections;
}

/** Apply one section's hunks to a file model, in order; `state.d` is the running line drift. */
function applyHunks(model: FileModel, hunks: UHunk[], strict: boolean, path: string): void {
  const state = { d: 0 };
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.body);
    if (o.length === 0) {
      const lenBefore = model.lines.length;
      const pos = Math.min(hunk.a + state.d, lenBefore);
      const texts = n.map((x) => x.text);
      model.lines.splice(pos, 0, ...texts);
      if (pos === lenBefore) model.final = !backslashAfterLastNew(hunk.body);
      state.d += n.length;
      continue;
    }
    const found = findTier(model.lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + state.d;
    let pos = found.at[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const reachesEnd = pos + o.length === model.lines.length;
    const written = renderN(n, o, model.lines, pos, found.tier);
    model.lines.splice(pos, o.length, ...written);
    if (reachesEnd) model.final = !backslashAfterLastNew(hunk.body);
    state.d += n.length - o.length;
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom ?? sec.gitOld;
    const newP = sec.hasPair ? sec.pairNew : sec.renameTo ?? sec.gitNew;
    const creation = sec.newFile || (sec.hasPair && sec.pairOld === null);
    const deletion = sec.delFile || (sec.hasPair && sec.pairNew === null);

    if (creation) {
      // A creation whose new path is /dev/null names no file: there is nowhere
      // to write the + lines, and the section changes nothing.
      if (newP === null) return;
      const p = newP;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const all: BodyLine[] = [];
      for (const h of sec.hunks) all.push(...h.body);
      const outLines = all.filter((b) => b.kind === 'new').map((b) => b.text);
      tree.now.set(p, createdText(outLines, !backslashAfterLastNew(all)));
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const from = oldP!;
    const to = newP!;
    if (!isSafe(from)) throw new Fail('unsafe', from);
    if (to !== from && !isSafe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const isMove = to !== from;
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, from);
    tree.now.set(to, writeModel(model));
    if (isMove) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchAt + 1}`);
    }
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const blockPath = path;
    edits.push((tree) => {
      if (!isSafe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, createdText([...newLines], true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const model = parseFile(before);
      const found = findTier(model.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.at.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.at[0]!;
      const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
      const written = renderN(n, oldLines, model.lines, pos, found.tier);
      model.lines.splice(pos, oldLines.length, ...written);
      tree.now.set(blockPath, writeModel(model));
    });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

const V_PREFIX: Record<string, { kind: VSection['kind']; pre: string }> = {
  add: { kind: 'add', pre: '*** Add File: ' },
  del: { kind: 'del', pre: '*** Delete File: ' },
  upd: { kind: 'upd', pre: '*** Update File: ' },
};

function vSectionStart(line: string): { kind: VSection['kind']; path: string } | null {
  for (const { kind, pre } of Object.values(V_PREFIX)) {
    if (line.startsWith(pre)) return { kind, path: line.slice(pre.length).trim() };
  }
  return null;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const start = vSectionStart(line);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i;
    i += 1;
    const bodyStart = i;
    while (i < last && vSectionStart(lines[i]!) === null) i += 1;
    let body = lines.slice(bodyStart, i);
    while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();

    if (start.kind === 'add') {
      const addLines: string[] = [];
      body.forEach((l, idx) => {
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + idx + 1}`);
      });
      sections.push({ kind: 'add', path: start.path, moveTo: null, addLines, chunks: [] });
    } else if (start.kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
      sections.push({ kind: 'del', path: start.path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      let restStart = bodyStart;
      if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
        restStart += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      rest.forEach((l, idx) => {
        const ln = restStart + idx + 1;
        if (l === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          return;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          return;
        }
        const c = l.charAt(0);
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          const kind = l === '' || c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new';
          cur.body.push({ kind, text: l === '' ? '' : l.slice(1), raw: l });
          return;
        }
        throw new Exit2(`error: parse ${ln}`);
      });
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
      sections.push({ kind: 'upd', path: start.path, moveTo, addLines: [], chunks });
    }
  }
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText([...sec.addLines], true));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update File, with an optional move.
    const to = sec.moveTo;
    if (to !== null && !isSafe(to)) throw new Fail('unsafe', to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const model = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const anchor = chunk.anchor;
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let j = cursor; j < model.lines.length; j += 1) {
            if (lineEq(model.lines[j]!, anchor, tier)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const texts = n.map((x) => x.text);
        model.lines.splice(pos, 0, ...texts);
        cursor = pos + texts.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiers) {
        const at = occurrences(model.lines, o, tier, cursor).filter(
          (atPos) => !chunk.eof || atPos + o.length === model.lines.length,
        );
        if (at.length > 0) {
          placed = { tier, pos: at[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', p);
      const written = renderN(n, o, model.lines, placed.pos, placed.tier);
      model.lines.splice(placed.pos, o.length, ...written);
      cursor = placed.pos + written.length;
    }
    if (to !== null) {
      tree.now.set(to, writeModel(model));
      tree.now.set(p, null);
      tree.moves.push([p, to]);
    } else {
      tree.now.set(p, writeModel(model));
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => v4aEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object as an Edit, or null when it is not a valid one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(needle);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + needle.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const model = parseFile(before);
      if (at < 0 || at > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(at, 0, ...add);
      tree.now.set(p, writeModel(model));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (section 4) and the command line (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Every change is written (unless --check), then reported in byte order of
  // the paths; a successful move replaces its D and A lines with one R line.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  const inMove = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    const co = changed.get(oldP);
    const cn = changed.get(newP);
    if (
      co !== undefined &&
      cn !== undefined &&
      co.was !== null &&
      co.now === null &&
      cn.was === null &&
      cn.now !== null &&
      !inMove.has(oldP) &&
      !inMove.has(newP)
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      inMove.add(oldP);
      inMove.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (inMove.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byteCompare(x.key, y.key));
  const outLines = rows.map((r) => r.line);
  outLines.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: outLines };
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
