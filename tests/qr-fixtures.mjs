// Representative QR payloads (placeholders only: example.org, fake keys/tokens).
const FPR = "1F2E3D4C5B6A79880F1E2D3C4B5A69788796A5B4";
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
export const keyB64 = btoa(String.fromCharCode(...KEY));
export const QR_PAYLOADS = {
  "contact invite": `https://i.delta.chat/#${FPR}&v=3&i=Wd7bLk3xQp9ZtR2mNv8sYc1A&s=Hq4Tn8Vx2Kp6Rz9Lm3Bc7Fw0&a=alice%40example.org&n=Alice`,
  "group invite": `https://i.delta.chat/#${FPR}&v=3&x=Gk2Lp9Qx7Rt4Vn8Zc1Mw3Yb6&i=Wd7bLk3xQp9ZtR2mNv8sYc1A&s=Hq4Tn8Vx2Kp6Rz9Lm3Bc7Fw0&a=alice%40example.org&n=Alice&g=Weekend+Hikers`,
  "openpgp4fpr contact": `OPENPGP4FPR:${FPR}#a=alice%40example.org&n=Alice&i=Wd7bLk3xQp9ZtR2mNv8sYc1A&s=Hq4Tn8Vx2Kp6Rz9Lm3Bc7Fw0`,
  "dclogin": "DCLOGIN:alice@example.org?p=correct-horse-battery&v=1&ih=imap.example.org&sh=smtp.example.org",
  "dcaccount": "DCACCOUNT:https://example.org/new_email?t=1w_7wDjgjelxeX884x96v3",
  "p2p ticket": "VELTAP2P1:" + "AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QCAIREEYUCULBOGAZDINRYHI6D4QCAIRE3X5Z".repeat(1),
  "backup": "DCBACKUP2:Jq3Lw9Px2Zr7Vt5Nb8Mc1Kd4&{\"node_id\":\"8a0f4e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7\",\"relay_url\":\"https://relay.example.org./\",\"direct_addresses\":[\"192.0.2.10:51000\",\"[2001:db8::10]:51000\"]}",
};
