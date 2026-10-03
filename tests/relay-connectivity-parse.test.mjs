import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

// Run the production parseConnectivityHtml, not a copy.
const start = source.indexOf("function parseConnectivityHtml(");
const end = source.indexOf("let relayRefreshBusy", start);
assert.ok(start !== -1 && end > start, "parseConnectivityHtml markers moved");
const script = new Script(source.slice(start, end), {
  filename: "app/js/app.js",
  lineOffset: source.slice(0, start).split("\n").length - 1,
});
const context = createContext({ console });
script.runInContext(context);
const parse = context.parseConnectivityHtml;

const FIXTURE = `<!DOCTYPE html><html><body>
<h3>Incoming Messages</h3><ul>
<li class="transport"><span class="green dot"></span> <b>d13.buro.dev:</b> Connected<br />
<ul class="quota-list"><li>325 MiB of 900 MiB used<div class="bar"><div class="progress grey" style="width: 36%">36%</div></div></li></ul></li>
<li class="transport"><span class="green dot"></span> <b>chatmail.uk:</b> Connected<br />
<ul class="quota-list"><li>224 MiB of 2 GiB used<div class="bar"><div class="progress grey" style="width: 10%">10%</div></div></li></ul></li>
</ul>
<h3>Outgoing Messages</h3><ul><li><span class="green dot"></span> Your last message was sent successfully.
<span class="smtp-via">ada@nine.testrun.org</span></li></ul></body></html>`;

test("#79: parseConnectivityHtml extracts the SMTP loop's bound transport", () => {
  const { segs, smtpState, smtpVia } = parse(FIXTURE);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].domain, "d13.buro.dev");
  assert.equal(smtpState, "ok");
  assert.equal(smtpVia, "ada@nine.testrun.org");
});

test("#79: old cores without smtp-via parse with smtpVia null (configured fallback stays)", () => {
  const legacy = FIXTURE.replace(/<span class="smtp-via">[^<]*<\/span>/, "");
  const { smtpVia } = parse(legacy);
  assert.equal(smtpVia, null);
});
