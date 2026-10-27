// Invite dialog (drawer "Invite friends"): Velta branding + native Share button.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canShareLink, shareLink } from "../app/js/qr-actions.js";
import fr from "../app/locales/fr.json" with { type: "json" };
import ru from "../app/locales/ru.json" with { type: "json" };

const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
const fn = ui.slice(ui.indexOf("export function showInvite("), ui.indexOf("async function showAbout"));

test("invite dialog says Velta, not Delta Chat (en/ru/fr)", () => {
  assert.doesNotMatch(fn, /Delta Chat/);
  for (const k of ["Invite to Velta", "Share invite link", "Chat with me on Velta", "Anyone scanning this code with Velta can reach you with verified end-to-end encryption."]) {
    assert.ok(fn.includes(`t("${k}")`), k);
    for (const [n, l] of [["ru", ru], ["fr", fr]]) assert.ok(l[k] && !/Delta Chat/.test(l[k]), `${n}: ${k}`);
  }
});

test("Share button only renders when a native share path exists", () => {
  assert.match(fn, /\$\{inviteCanShare\(\) \? `<button type="button" class="btn-text" data-share aria-label=/);
  assert.match(fn, /\$\{ICON\.share\}/);
  assert.equal(canShareLink({ ua: "Windows NT", hasInvoke: true, hasWebShare: false }), false, "desktop without Web Share: hidden");
  assert.equal(canShareLink({ ua: "Windows NT", hasInvoke: true, hasWebShare: true }), true);
  assert.equal(canShareLink({ ua: "Linux; Android 14", hasInvoke: true, hasWebShare: false }), true, "Android shell share_text");
});

test("shareLink sends the invite text + URL through the right path", async () => {
  const calls = [];
  await shareLink("https://i.delta.chat/#X", { ua: "Android", invoke: (c, a) => calls.push([c, a]), text: "Chat with me on Velta: https://i.delta.chat/#X", title: "T" });
  assert.deepEqual(calls, [["share_text", { text: "Chat with me on Velta: https://i.delta.chat/#X", title: "T" }]]);
  let got;
  await shareLink("https://i.delta.chat/#X", { ua: "Mac", webShare: o => { got = o; }, text: "Hi: https://i.delta.chat/#X", title: "T" });
  assert.deepEqual(got, { title: "T", text: "Hi: https://i.delta.chat/#X", url: "https://i.delta.chat/#X" });
});

test("group/channel invite dialog shares 'Join <name> on Velta'; helper toasts, no errToast in ui.js", () => {
  assert.match(fn, /group \? t\("Join \{name\} on Velta", \{ name: title \}\) : t\("Chat with me on Velta"\)/);
  const helper = ui.slice(ui.indexOf("export async function shareInviteLink("), ui.indexOf("export function showInvite("));
  assert.match(helper, /toast\(t\("Couldn't share the link: "\)/);
  assert.doesNotMatch(ui.replace(/\/\/.*$/gm, ""), /\berrToast\(/, "ui.js has no errToast");
  for (const k of ["Join {name} on Velta", "Chat with {name} on Velta"]) for (const l of [ru, fr]) assert.ok(l[k]?.includes("{name}") && l[k].includes("Velta"), k);
});

test("in-chat invite cards get a Share button only when sharing is available", async () => {
  const src = readFileSync(new URL("../app/js/invites.js", import.meta.url), "utf8");
  assert.match(src, /if \(!inviteCanShare\(\)\) return "";/);
  assert.match(src, /data-invite-share=/);
  assert.match(src, /shareInviteLink\(shareBtn\.getAttribute\("data-invite-share"\), shareBtn\.getAttribute\("data-share-text"\)\)/);
  assert.equal((src.match(/inviteShareBtn\(/g) || []).length, 3, "full + short cards");
});

test("Your QR code screen shares 'Chat with me on Velta: <link>'", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.ok(app.includes('text: `${t("Chat with me on Velta")}: ${inviteText}`'));
});

test("copy buttons beside Share carry the outline copy icon", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.ok(fn.includes('data-copy>${ICON.copy}<span>${escapeHtml(t("Copy invite link"))}</span>'));
  assert.ok(app.includes('data-copy-link disabled>${ICON.copy}<span>'));
  assert.ok(app.includes('data-share-link disabled>${ICON.share}<span>'));
});

test("create_qr_svg QRs carry the Velta logo, not the Delta Chat overlay", async () => {
  const { brandCoreQrSvg, VELTA_QR_LOGO } = await import("../app/js/qr-encode.js");
  const core = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect/><g transform="translate(48,48)"><path style="fill:#000000" d="M0,0h1v1h-1z" transform="scale(16)"/></g><g transform="translate(208,208) scale(2)"><path style="fill:#ffffff" d="m 24"/><g><path d="x"/></g></g></svg>';
  const out = brandCoreQrSvg(core);
  assert.ok(out.includes(VELTA_QR_LOGO) && out.endsWith("</svg>"));
  assert.doesNotMatch(out, /translate\(208,208\) scale\(2\)/);
  assert.ok(out.includes('transform="translate(48,48)"'), "QR modules untouched");
  assert.equal(brandCoreQrSvg("<svg>other</svg>"), "<svg>other</svg>");
  const rpc = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.ok(rpc.includes('brandCoreQrSvg(reencodeCoreQrSvg(await this._call("create_qr_svg", text), text))'));
});
