// Mobile safety net injected into every served drop at /p/:slug/raw.
//
// Why this exists: the most common failure mode for agent-authored drops is
// horizontal scroll on mobile — wide <pre> blocks, unbreakable strings, fixed
// pixel widths, tables setting page width. The SKILL.md mobile floor tells
// agents not to ship that, but the floor is advisory. This is the guard.
//
// We modify user HTML by appending ~250 bytes of CSS at the tail of <head>
// and (if missing) a viewport meta. That's a small, defensible deviation
// from "we don't touch the user's content" — no drop wants horizontal scroll
// on <body>; this only ever clamps a broken layout.
//
// Trade-offs deliberately accepted:
//   - We don't try to detect or repair specific patterns (wide tables, etc.).
//     The injected style is small and universal; agents that want tighter
//     control already follow the SKILL.md prescription.
//   - We don't offer an opt-out. If a drop ever legitimately wants horizontal
//     scrolling on <body>, it can wrap content in an inner container with
//     `overflow-x: auto`. The floor stays on.
//
// Hot path: this runs on every raw view, on up to 2 MB of HTML the drop's
// author fully controls. Finding the insertion points is one forward pass
// (findInsertionPoints) — never a backtracking regex over the whole
// document, which a drop shaped like `<head<head<head…` can make quadratic
// and push past the Worker's CPU limit on every view.

// Compact rule set. `overflow-x: clip` over `hidden` so we don't create a
// scroll container (would break position: sticky descendants).
const SAFETY_STYLE =
  '<style data-htmlbin-safety>' +
  'html,body{max-width:100vw;overflow-x:clip}' +
  'img,svg{max-width:100%;height:auto}' +
  'video,iframe{max-width:100%}' +
  'pre,table{max-width:100%}' +
  'pre{overflow-x:auto}' +
  '</style>';

const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

// Matched only against a single tag's own text, never the whole document.
const VIEWPORT_ATTR_RE = /\bname\s*=\s*["']?viewport\b/i;

// Elements whose content is raw text: a `</head>` inside a <script> string
// is data, not markup, and must not receive the style.
const RAW_TEXT_CLOSE: Record<string, RegExp> = {
  script: /<\/script/gi,
  style: /<\/style/gi,
  textarea: /<\/textarea/gi,
  title: /<\/title/gi,
};

function isLetter(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}

type Points = {
  doctypeEnd: number; // after the doctype's `>`, when it leads the document
  htmlOpenEnd: number;
  headOpenEnd: number;
  headCloseStart: number;
  bodyOpenStart: number;
  hasViewport: boolean;
};

// Walks tags the way a tokenizer would: comments are skipped, raw-text
// element bodies are skipped, and a tag runs to its first `>`. Every index
// only moves forward, so the cost is linear in the input. -1 = not found.
function findInsertionPoints(html: string): Points {
  const p: Points = {
    doctypeEnd: -1,
    htmlOpenEnd: -1,
    headOpenEnd: -1,
    headCloseStart: -1,
    bodyOpenStart: -1,
    hasViewport: false,
  };
  let seenTag = false;
  let gt = -1; // cached position of the next `>`; recomputed only once passed
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    const closing = next === 47; // "/"
    if (!closing && !isLetter(next) && next !== 33 && next !== 63) {
      i = lt + 1; // a bare "<" in text
      continue;
    }
    if (gt <= lt) gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // no tag after this point can be complete
    const tagEnd = gt + 1;

    if (next === 33 || next === 63) {
      // <!doctype …>, <!…>, <?…>
      if (
        !seenTag &&
        p.doctypeEnd === -1 &&
        html.slice(lt + 2, lt + 9).toLowerCase() === "doctype"
      )
        p.doctypeEnd = tagEnd;
      seenTag = true;
      i = tagEnd;
      continue;
    }
    seenTag = true;

    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < gt) {
      const ch = html.charCodeAt(nameEnd);
      if (ch === 47 || ch === 32 || (ch >= 9 && ch <= 13)) break;
      nameEnd++;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    i = tagEnd;

    if (closing) {
      if (name === "head" && p.headCloseStart === -1) p.headCloseStart = lt;
      continue;
    }
    if (name === "html" && p.htmlOpenEnd === -1) p.htmlOpenEnd = tagEnd;
    else if (name === "head" && p.headOpenEnd === -1) p.headOpenEnd = tagEnd;
    else if (name === "body" && p.bodyOpenStart === -1) p.bodyOpenStart = lt;
    else if (name === "meta" && !p.hasViewport)
      p.hasViewport = VIEWPORT_ATTR_RE.test(html.slice(nameEnd, gt));

    const rawClose = RAW_TEXT_CLOSE[name];
    if (rawClose) {
      rawClose.lastIndex = tagEnd;
      const m = rawClose.exec(html);
      if (!m) break;
      i = m.index;
    }
  }
  return p;
}

export function injectMobileSafetyNet(html: string): string {
  const p = findInsertionPoints(html);
  // With no tag to anchor to, go right after a leading doctype: anything
  // placed before it drops the page into quirks mode.
  const top = p.doctypeEnd === -1 ? 0 : p.doctypeEnd;

  const inserts: Array<[number, string]> = [];
  if (!p.hasViewport) {
    const at =
      p.headOpenEnd !== -1 ? p.headOpenEnd
      : p.htmlOpenEnd !== -1 ? p.htmlOpenEnd
      : top;
    inserts.push([at, VIEWPORT_META]);
  }
  const styleAt =
    p.headCloseStart !== -1 ? p.headCloseStart
    : p.bodyOpenStart !== -1 ? p.bodyOpenStart
    : top;
  inserts.push([styleAt, SAFETY_STYLE]);

  // Positions are ascending (viewport sits at or before the style point in
  // every well-formed case); sort anyway so a stray order can't corrupt.
  inserts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let from = 0;
  for (const [at, text] of inserts) {
    out += html.slice(from, at) + text;
    from = at;
  }
  return out + html.slice(from);
}
