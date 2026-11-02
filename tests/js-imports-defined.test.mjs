import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Static guard for the "used but not imported" bug class: app.js called
// proxy.js's makeChooser without importing it (the socks5 rename dropped it
// from the import list) — a missing NAME in an import list is not a link
// error, it only throws ReferenceError when that code path runs, so the
// fake-DOM suite never saw it.
//
// This walks app/js/*.js, collects every module's exports, and flags a
// foreign export a file uses as a callee or in a value position
// (`: NAME`, `= NAME`, `return NAME`) while neither importing nor
// declaring it. Deliberately NOT flagged: destructured parameters and
// dynamic-import destructuring (the { a } in `function f({ a })` /
// `const { a } = await import(…)`), object-literal keys, and bare
// shorthand references — a regex can't tell those scopes apart, and the
// repo's dependency-injection style ({ showModal, toast }) would drown
// the signal in false positives.
//
// A recursive scanner blanks everything that is not code: comments, string
// contents, template literals (including nested `${ code }` — templates
// here embed HTML, and naive scanning desyncs on `</tag>`), and regex
// literals (`/` after one of `(,=:[!&|?{};+-*%~^<>` or file start opens a
// regex — the standard division-vs-regex heuristic).
const DIR = new URL("../app/js/", import.meta.url);
const SKIP_LEN = 3;
const ALLOW = new Set(); // "file.js:name" escape hatch — keep minimal

const blankNonCode = (src) => {
  const n = src.length;
  let out = "";
  const blankTo = (ch) => { out += ch === "\n" ? "\n" : " "; };

  // Template literal: i is just past the opening backtick. Blank literal
  // chars; `${` recurses into code until the matching `}`.
  const scanTemplate = (i) => {
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") return i + 1;
      if (src[i] === "$" && src[i + 1] === "{") { blankTo(src[i]); blankTo(src[i + 1]); i = scanCode(i + 2, "}"); continue; }
      blankTo(src[i]); i++;
    }
    return i;
  };

  // String: i is just past the opening quote.
  const scanString = (i, quote) => {
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === quote) return i + 1;
      blankTo(src[i]); i++;
    }
    return i;
  };

  // Code: i is just past the opening quote.
  const scanRegex = (i) => {
    let inClass = false;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "[") inClass = true;
      else if (src[i] === "]") inClass = false;
      else if (src[i] === "/" && !inClass) return i + 1;
      else if (src[i] === "\n") return i; // not a regex after all
      blankTo(src[i]); i++;
    }
    return i;
  };

  // Code until EOF, or (when endBrace) until the `}` closing a `${`.
  const scanCode = (i, endBrace) => {
    let prev = ""; // last significant char, for division-vs-regex
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (endBrace) {
        if (c === "{") depth++;
        if (c === "}") { if (depth === 0) return i + 1; depth--; }
      }
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") {
        i += 2;
        while (i + 1 < n && !(src[i] === "*" && src[i + 1] === "/")) { blankTo(src[i]); i++; }
        i += 2; continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        out += c;
        i = c === "`" ? scanTemplate(i + 1) : scanString(i + 1, c);
        prev = c;
        continue;
      }
      if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev))) { i = scanRegex(i + 1); prev = "/"; continue; }
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return i;
  };

  scanCode(0, null);
  return out;
};

const declaredNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/\b(?:async\s+)?function\s*\*?\s*(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:class|const|let|var)\s+(\w+)/g)) names.add(m[1]);
  // destructured bindings: `const { a, b: c, d = 1 } = …`, function
  // parameters — plain `(a, b)` and destructured `({ showModal, toast })`,
  // arrow and method forms. Over-broad by design: object-literal keys in
  // matched braces land in the set too, which only weakens detection for
  // same-file name collisions.
  const groups = [];
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) groups.push(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) groups.push(m[1]); // array destructuring
  for (const m of src.matchAll(/\bfunction\s*\*?\s*\w*\s*\(([^)]*)\)/g)) groups.push(m[1]);
  for (const m of src.matchAll(/[(,]\s*\{([^}]*)\}\s*(?:=>|\)|\{)/g)) groups.push(m[1]);
  for (const content of groups) {
    // a binding never sits in callee position — strip `name(` tokens so
    // object literals passed as call arguments don't launder a missing
    // import into "have" (`choose: makeChooser(showModal)` inside a
    // captured group must stay a USE)
    for (const tok of content.replace(/([\w$]+)\s*\(/g, "(").matchAll(/[\w$]+/g)) names.add(tok[0]);
  }
  return names;
};

const exportNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:class|const|let|var)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
};

const importedNames = (src) => {
  const names = new Set();
  // import { a, b as c } from "…"; import d from "…"; import d, { a } from "…"
  for (const m of src.matchAll(/\bimport\s+(?:(\w+)\s*,\s*)?\{([^}]+)\}\s*from/g)) {
    if (m[1]) names.add(m[1]);
    for (const part of m[2].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/\bimport\s+(\w+)\s+from/g)) names.add(m[1]);
  // import * as NS — namespace use is property access, nothing to track
  return names;
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".js"));
const sources = new Map(files.map((f) => [f, blankNonCode(readFileSync(new URL(f, DIR), "utf8"))]));

const allExports = new Map(); // name -> Set of exporting files
for (const [f, src] of sources) {
  for (const name of exportNames(src)) {
    if (name.length >= SKIP_LEN) {
      if (!allExports.has(name)) allExports.set(name, new Set());
      allExports.get(name).add(f);
    }
  }
}

test("every app/js module export used as callee/value is imported or declared locally", () => {
  const violations = [];
  for (const [f, src] of sources) {
    const have = importedNames(src).union(declaredNames(src));
    for (const [name, exporters] of allExports) {
      if (have.has(name) || ALLOW.has(`${f}:${name}`)) continue;
      const used =
        new RegExp(`(?<![.\\w'"\`])${name}\\s*\\(`).test(src) || // callee
        new RegExp(`(?<=[:=]\\s*)${name}\\b`).test(src) || // value after : or =
        new RegExp(`\\breturn\\s+${name}\\b`).test(src); // returned value
      if (used) violations.push(`${f}: uses "${name}" (exported by ${[...exporters].join(", ")}) without importing it`);
    }
  }
  assert.deepEqual(violations, []);
});
