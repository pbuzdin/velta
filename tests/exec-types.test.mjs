import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executableKind, fileExtension, isExecutableName } from "../app/js/exec-types.js";

test("program, script, shortcut and package types are recognised", () => {
  const cases = {
    "setup.exe": "program", "a.MSI": "program", "x.scr": "program", "tool.jar": "program", "Thing.app": "program",
    "run.bat": "script", "run.CMD": "script", "s.ps1": "script", "v.vbs": "script", "x.js": "script", "x.jse": "script",
    "x.wsf": "script", "x.hta": "script", "x.sh": "script", "x.command": "script", "x.py": "script",
    "link.lnk": "shortcut", "site.url": "shortcut", "a.desktop": "shortcut",
    "x.pkg": "package", "x.deb": "package", "x.dmg": "package", "x.chm": "package",
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(executableKind(name), kind, name);
});

test("documents and media are not flagged", () => {
  for (const n of ["a.pdf", "p.jpg", "notes.txt", "r.docx", "x.zip", "song.mp3", "README", "archive.tar.gz", "", null, undefined, ".bashrc"]) {
    assert.equal(isExecutableName(n), false, String(n));
  }
});

test("only the last extension counts, so a decoy name does not hide the type", () => {
  assert.equal(executableKind("invoice.pdf.exe"), "program");
  assert.equal(isExecutableName("setup.exe.txt"), false);
});

test("trailing dots and spaces and path prefixes are ignored like Windows does", () => {
  assert.equal(fileExtension("a.exe. "), "exe");
  assert.equal(fileExtension("a.exe..."), "exe");
  assert.equal(executableKind("C:\\Users\\x\\run.BAT"), "script");
  assert.equal(executableKind("dir/run.sh"), "script");
});

test("desktop open asks before launching; Android is not gated", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function openAttachmentFile"), src.indexOf("// Image extensions the lightbox"));
  assert.match(fn, /const kind = !isAndroid\(\) \? executableKind\(fileName\) : null/);
  assert.ok(fn.indexOf("confirmOpenProgram") < fn.indexOf('"plugin:opener|open_path"'));
  assert.match(fn, /choice === "folder"/);
  assert.match(fn, /if \(choice !== "open"\) return/);
});
