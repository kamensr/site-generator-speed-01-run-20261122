// A fast static site generator: a byte-identical drop-in for makefun-site 1.0.0.
// run(input) returns exactly the output tree makefun-site's build returns for
// the case's site: every page's index.html, the index and tag pages,
// build-report.txt and each static file, as a JSON object of path -> text.
//
// Written from the makefun-site README and its reference code's semantics, in
// this module's own shape: a streaming Markdown renderer (no token objects, the
// inline pass works in chunks instead of a character at a time), a template
// engine compiled to flat jump tables, memoised slugs, dates and word counts,
// and a front-matter pass that never copies a body. Nothing here changes a
// single output byte: every quirk of the dialect is kept.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

/** The HTML escape table. */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. A single scan; the input itself when it holds none of them. */
function esc(text) {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out += text.slice(last, i) + ENT[text[i]];
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Whether a string holds a character outside ASCII (NFKD is the identity on ASCII). */
const NON_ASCII = /[^\x00-\x7F]/;
/** Unicode combining marks. */
const MARKS = /\p{M}/gu;

/** Slugs already worked out, by their text: titles, tag names and headings repeat. */
const slugCache = new Map();

/** The slug of `text`, makefun-site's rule: NFKD, combining marks dropped, A-Z lowered, every run of other characters one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    if (out.length >= 64) break;
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (slugCache.size > 20000) slugCache.clear();
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Long dates already worked out, by their YYYY-MM-DD string. */
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    if (dateCache.size > 4096) dateCache.clear();
    dateCache.set(date, hit);
  }
  return hit;
}

/** Whether a code unit is whitespace, JavaScript's \s set exactly. */
function isWs(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. One scan, nothing allocated; the rare non-ASCII whitespace set is only consulted past ASCII. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWs(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * The closing "---" is found by scanning for it, so the body is one slice, never a split and a join.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeAt = -1;
  let closeEnd = -1;
  let at = 3;
  for (;;) {
    const idx = text.indexOf('\n---', at);
    if (idx === -1) break;
    if (idx + 4 === text.length) {
      closeAt = idx;
      closeEnd = text.length;
      break;
    }
    if (text.charCodeAt(idx + 4) === 10) {
      closeAt = idx;
      closeEnd = idx + 5;
      break;
    }
    at = idx + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const lines = text.slice(4, closeAt).split('\n');
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (line === '' || /^[ \t]+$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------ markdown

/** A line of two or more spaces then a non-space: a list item's continuation. */
const CONTINUED = /^ {2,}\S/;

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language, or null: three backticks, an optional language, spaces or tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let j = k + 1;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) break;
    j++;
  }
  let end = line.length;
  while (end > j) {
    const d = line.charCodeAt(end - 1);
    if (d !== 32 && d !== 9) break;
    end--;
  }
  if (end === j) return null;
  return { depth: k, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs only after. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return isBlank(line);
}

/** A bullet item's text, or null: `- ` or `* ` then the item. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null: 1 to 9 digits, `. `, then the item. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** The characters a backslash escapes, by code: \ ` * _ [ ] ( ) # + - . ! >. */
const ESC_TABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESC_TABLE[c] = 1;

/** Whether the character at `j` in `s` is escaped: the run of backslashes just before it has odd length (escapes pair backslashes up from the left, so an odd one left over escapes what follows). */
function isEscaped(s, j) {
  let n = 0;
  while (j - 1 - n >= 0 && s.charCodeAt(j - 1 - n) === 92) n++;
  return (n & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. An escaped star is passed over on its own; a ** pair is passed over whole, so its second star is never a candidate. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline construct or character to escape: a backslash, a backtick, *, [, &, <, >, " or '. Shared by every inline call; each pass sets lastIndex before it searches, so a nested call cannot disturb its caller. */
const NEXT_SPECIAL = /[\\`*\[&<>"']/g;

/** Whether a string holds an inline construct at all: a backslash, a backtick, * or [. */
const HAS_CONSTRUCT = /[\\`*\[]/;
/** Whether a string holds a character to escape: ' " & < or >. */
const HAS_ESCAPABLE = /['"&<>]/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Most lines hold no construct at all, and most of those
 * hold nothing to escape either, so those two cases are answered by a test each and the line itself; the rest go
 * through the search below, which jumps from one construct to the next so plain text moves in whole runs.
 */
function inline(s, env) {
  if (!HAS_CONSTRUCT.test(s)) {
    if (!HAS_ESCAPABLE.test(s)) return s;
    return esc(s);
  }
  const parts = [];
  const n = s.length;
  const re = NEXT_SPECIAL;
  let i = 0;
  let chunk = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    const p = m.index;
    const c = s.charCodeAt(p);
    if (c === 92) {
      // A backslash: escaped when the next character is one it escapes, itself otherwise.
      if (p + 1 < n && ESC_TABLE[s.charCodeAt(p + 1)]) {
        if (p > chunk) parts.push(s.slice(chunk, p));
        parts.push(s[p + 1] === '>' ? '&gt;' : s[p + 1]);
        i = p + 2;
        chunk = i;
      } else i = p + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (p > chunk) parts.push(s.slice(chunk, p));
        parts.push('<code>', esc(s.slice(p + 1, j)), '</code>');
        i = j + 1;
        chunk = i;
      } else i = p + 1;
      continue;
    }
    if (c === 42) {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          if (p > chunk) parts.push(s.slice(chunk, p));
          parts.push('<strong>', inline(s.slice(p + 2, j), env), '</strong>');
          i = j + 2;
          chunk = i;
        } else i = p + 2;
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        if (p > chunk) parts.push(s.slice(chunk, p));
        parts.push('<em>', inline(s.slice(p + 1, j), env), '</em>');
        i = j + 1;
        chunk = i;
      } else i = p + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', p + 1);
      const t = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !/\s/.test(target)) {
        if (p > chunk) parts.push(s.slice(chunk, p));
        parts.push('<a href="', esc(env.link(target)), '">', inline(s.slice(p + 1, k), env), '</a>');
        i = t + 1;
        chunk = i;
      } else i = p + 1;
      continue;
    }
    // & < > " or ': escaped, one character.
    if (p > chunk) parts.push(s.slice(chunk, p));
    parts.push(ENT[s[p]]);
    i = p + 1;
    chunk = i;
  }
  if (n > chunk) parts.push(s.slice(chunk, n));
  return parts.join('');
}

/**
 * `src` rendered, in one pass over its lines and straight into the output: its HTML (each block on its own lines,
 * a "\n" after the last), its table of contents (every level 2 and 3 heading: level, id and its inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        let body = '';
        i++;
        while (i < n && !fenceClose(lines[i])) body += `${esc(lines[i++])}\n`;
        i++;
        blocks.push(`<pre><code${cls}>${body}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, env);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i++];
        q = q.slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        const t = trimLine(q);
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let parts = [trimLine(isOrdered ? ordered.text : bullet)];
      i++;
      while (i < n) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push(parts.join('\n'));
            parts = [trimLine(m.text)];
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push(parts.join('\n'));
            parts = [trimLine(m)];
            i++;
            continue;
          }
        }
        if (CONTINUED.test(lines[i])) {
          parts.push(trimLine(lines[i]));
          i++;
          continue;
        }
        break;
      }
      items.push(parts.join('\n'));
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let lis = '';
      for (const item of items) lis += `<li>${inline(item, env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` compiled to a flat list of operations, with jumps: text (0), escaped
 * value (1), raw value (2), if (3, with alt: where to go when the branch is not
 * taken), jump (5, past an else), for (6, with end: past its body), include (7).
 * A TemplateError when it does not parse, with the reference's own reasons.
 */
function parseTemplate(name, src) {
  const ops = [];
  const stack = [];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') ops.push({ t: 0, s: tok.text });
    else if (tok.t === 'var') ops.push({ t: 1, p: tok.path });
    else if (tok.t === 'raw') ops.push({ t: 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack.length === 0 ? null : stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const op = { t: 6, name: m[1], p: pathOf(name, m[2]), end: 0 };
        ops.push(op);
        stack.push({ kind: 'for', op });
      } else if ((m = IF.exec(tag)) !== null) {
        const op = { t: 3, p: pathOf(name, m[2]), not: m[1] !== undefined, alt: 0, jump: -1 };
        ops.push(op);
        stack.push({ kind: 'if', op, elseSeen: false });
      } else if (tag === 'else') {
        if (top === null || top.kind !== 'if' || top.elseSeen) throw new TemplateError(`template "${name}": an else outside an if`);
        top.elseSeen = true;
        const jump = { t: 5, to: 0 };
        ops.push(jump);
        top.op.jump = ops.length - 1;
        top.op.alt = ops.length;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top === null || top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        if (tag === 'endfor') top.op.end = ops.length;
        else {
          if (top.elseSeen) ops[top.op.jump].to = ops.length;
          else top.op.alt = ops.length;
        }
      } else if ((m = INCLUDE.exec(tag)) !== null) ops.push({ t: 7, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return ops;
}

/** The value at `path` in the scope frames: its first name from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/**
 * Operations `ops[start..end)` rendered in the scope frames, appended to `out`. `ctx.templates` holds the parsed
 * templates (a template that did not parse absent); `depth` is the include depth; `bound` is the names the enclosing
 * fors bind, innermost last.
 */
function renderRange(ops, start, end, frames, bound, ctx, depth, out) {
  let i = start;
  while (i < end) {
    const op = ops[i];
    switch (op.t) {
      case 0:
        out.push(op.s);
        i++;
        break;
      case 1: {
        const v = lookup(frames, op.p);
        out.push(esc(typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : Array.isArray(v) ? v.map(textOf).join(', ') : ''));
        i++;
        break;
      }
      case 2: {
        const v = lookup(frames, op.p);
        out.push(typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : Array.isArray(v) ? v.map(textOf).join(', ') : '');
        i++;
        break;
      }
      case 3: {
        const v = lookup(frames, op.p);
        const t = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
        i = t !== op.not ? i + 1 : op.alt;
        break;
      }
      case 5:
        i = op.to;
        break;
      case 6: {
        const xs = lookup(frames, op.p);
        if (Array.isArray(xs)) {
          // One frame for the whole loop, its item and loop counter moved on each pass: the body only ever reads the
          // current pass, and a nested run of this same for (through an include) builds its own frame, so nothing is
          // shared across executions. A loop named "loop" keeps the meta object, as the reference's literal does.
          const frame = { [op.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
          frames.push(frame);
          bound.push(op.name);
          for (let k = 0; k < xs.length; k++) {
            if (op.name !== 'loop') frame[op.name] = xs[k];
            frame.loop.index = k + 1;
            frame.loop.first = k === 0;
            frame.loop.last = k === xs.length - 1;
            renderRange(ops, i + 1, op.end, frames, bound, ctx, depth, out);
          }
          frames.pop();
          bound.pop();
        }
        i = op.end;
        break;
      }
      case 7: {
        const t = ctx.templates.get(op.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          // A template that reads only the case's own values (site, tags, recent) renders the same at every include,
          // unless an enclosing for binds one of those names; a template that reads a single value renders the same
          // for the same value. Both are worth keeping: the header and footer repeat on every page, and a post's card
          // repeats on its index page and every tag page.
          if (t.constant && (bound.length === 0 || !t.free.some((n) => bound.includes(n)))) {
            let s = t.constCache === undefined ? undefined : t.constCache.get(depth);
            if (s === undefined) {
              const tmp = [];
              renderRange(t.ops, 0, t.ops.length, frames, bound, ctx, depth + 1, tmp);
              s = tmp.join('');
              if (t.constCache === undefined) t.constCache = new Map();
              t.constCache.set(depth, s);
            }
            out.push(s);
          } else if (t.single !== null) {
            const v = lookup(frames, t.singlePath);
            let byDepth = t.valCache === undefined ? undefined : t.valCache.get(depth);
            let s = byDepth === undefined ? undefined : byDepth.get(v);
            if (s === undefined) {
              const tmp = [];
              renderRange(t.ops, 0, t.ops.length, frames, bound, ctx, depth + 1, tmp);
              s = tmp.join('');
              if (byDepth === undefined) {
                byDepth = new Map();
                if (t.valCache === undefined) t.valCache = new Map();
                t.valCache.set(depth, byDepth);
              }
              byDepth.set(v, s);
            }
            out.push(s);
          } else renderRange(t.ops, 0, t.ops.length, frames, bound, ctx, depth + 1, out);
        }
        i++;
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens with a scheme: a letter, then letters, digits, + - or ., then ":". */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let j = 1; j < target.length; j++) {
    const c = target.charCodeAt(j);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, { ops: parseTemplate(name, input.templates[name]), free: null, constant: false, single: null, singlePath: null, constCache: undefined, valCache: undefined });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // The root names each template may read: its own lookups outside its fors' bindings, plus the names of every
  // template it includes, to a fixed point (includes may cycle). Over-approximate on purpose: a name bound by an
  // enclosing for at an include site still counts as free, which only ever withholds caching, never wrongly allows it.
  for (const t of templates.values()) {
    const reads = new Set();
    const stack = [];
    const ops = t.ops;
    for (let i = 0; i < ops.length; i++) {
      while (stack.length > 0 && stack[stack.length - 1].end <= i) stack.pop();
      const op = ops[i];
      if (op.t === 6) {
        if (!stack.some((b) => b.name === op.p[0])) reads.add(op.p[0]);
        stack.push({ end: op.end, name: op.name }, { end: op.end, name: 'loop' });
      } else if (op.t === 1 || op.t === 2 || op.t === 3) {
        if (!stack.some((b) => b.name === op.p[0])) reads.add(op.p[0]);
      }
    }
    t.free = reads;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of templates.values()) {
      for (const op of t.ops) {
        if (op.t !== 7) continue;
        const sub = templates.get(op.name);
        if (sub === undefined) continue;
        for (const r of sub.free) {
          if (!t.free.has(r)) {
            t.free.add(r);
            changed = true;
          }
        }
      }
    }
  }
  // A template that reads only the case's own values is constant for the case; one that reads a single value other
  // than the loop counter is a function of that value. (The loop counter is left out: its object is moved on each
  // pass, so its identity alone does not fix its contents.)
  for (const t of templates.values()) {
    t.free = [...t.free];
    t.constant = t.free.every((n) => n === 'site' || n === 'tags' || n === 'recent');
    if (t.free.length === 1 && t.free[0] !== 'loop') {
      t.single = t.free[0];
      t.singlePath = [t.free[0]];
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n"; a file that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.text = undefined;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolved = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirCache = resolved.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      resolved.set(dir, dirCache);
    }
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let href = dirCache.get(rel);
        if (href === undefined) {
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = bySource.get(path).url;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}`;
          else href = null;
          dirCache.set(rel, href);
        }
        if (href !== null) return `${href}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, one per source, worked out once: a card's reading time counts the body's words a single time.
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const root = { site, tags: allTags, recent };
  const ctx = { templates };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderRange(t.ops, 0, t.ops.length, [root, vars], [], ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
