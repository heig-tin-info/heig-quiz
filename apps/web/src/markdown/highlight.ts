/*
 * A deliberately small code tokenizer for fenced blocks in question prompts.
 *
 * Not a highlighter: Prism or Shiki would add 30–100 kB to a bundle a student
 * downloads on a phone in an exam room (N-PERF-05), to colour four or five
 * lines of C. Four token classes — comment, string, number, keyword — carry
 * the whole readability gain of syntax colour; everything past that is
 * decoration. Unknown languages fall through to escaped text, which is the
 * correct answer for a block of shell output.
 */

/** Keywords per language family. One list per family, not per language. */
const KEYWORDS = {
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL",
  cpp: "auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
  js: "as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  sql: "and as asc by create delete desc distinct drop from group having insert inner into join left limit not null on or order outer select set table update values where",
} as const;

/** Language tag of a fence -> the keyword family it borrows. */
const FAMILY: Record<string, keyof typeof KEYWORDS> = {
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  cc: "cpp",
  js: "js",
  javascript: "js",
  jsx: "js",
  ts: "js",
  typescript: "js",
  tsx: "js",
  json: "js",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sql: "sql",
};

/** Line-comment opener per family; `/* … *\/` blocks are handled for the C ones. */
const LINE_COMMENT: Record<keyof typeof KEYWORDS, string> = {
  c: "//",
  cpp: "//",
  js: "//",
  python: "#",
  rust: "//",
  sql: "--",
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escapes a plain-text run. Every token below goes through it. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The language family a fence tag maps to, or null for "just escape it". */
export function languageFamily(lang: string | undefined | null): keyof typeof KEYWORDS | null {
  if (!lang) return null;
  const tag = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return FAMILY[tag] ?? null;
}

/**
 * Escaped HTML for one fenced block: the four token spans, everything else as
 * text. The scan is a single left-to-right pass, so a keyword inside a string
 * or a comment stays inside it — the one mistake a regex-per-class approach
 * always makes.
 */
export function highlight(code: string, lang?: string | null): string {
  const family = languageFamily(lang);
  if (!family) return escapeHtml(code);
  const keywords = new Set(KEYWORDS[family].split(" "));
  const lineComment = LINE_COMMENT[family];
  const blockComments = family !== "python" && family !== "sql";
  const out: string[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push(escapeHtml(plain));
    plain = "";
  };
  const token = (cls: string, text: string) => {
    flush();
    out.push(`<span class="tok-${cls}">${escapeHtml(text)}</span>`);
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (rest.startsWith(lineComment)) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      token("com", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (blockComments && rest.startsWith("/*")) {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      token("com", code.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = code[i]!;
    if (quote === '"' || quote === "'" || (quote === "`" && family === "js")) {
      let j = i + 1;
      while (j < code.length && code[j] !== quote) j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, code.length);
      token("str", code.slice(i, stop));
      i = stop;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      const text = word[0];
      if (keywords.has(text)) token("kw", text);
      else plain += text;
      i += text.length;
      continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num) {
      token("num", num[0]);
      i += num[0].length;
      continue;
    }
    plain += quote;
    i += 1;
  }
  flush();
  return out.join("");
}
