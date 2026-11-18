# Third-party material in Velta KMP

Velta KMP is GPLv3, same as the rest of this repository. This file lists
third-party work that is bundled or incorporated, and the licence it carries.
Code reused from deltachat-android or ArcaneChat Android (both GPLv3)
belongs here too: keep the upstream copyright header, and record the
upstream path next to the entry.

## Golos Text

- Copyright 2019 The Golos Text Project Authors (https://github.com/googlefonts/golos-text)
- Licence: SIL Open Font License 1.1 (https://scripts.sil.org/OFL)
- Upstream: https://github.com/google/fonts/tree/main/ofl/golostext

Only the capital “K” glyph, instanced at ExtraBold (wght 800), is used. It
was converted to a path in `art/velta-kmp-icon-badge.svg` (the optional
KMP “K badge” launcher icon). The font file itself is not shipped.

## Bouncy Castle

- Copyright The Legion of the Bouncy Castle
- Licence: MIT (https://www.bouncycastle.org/licence.html)
- Artifact: `org.bouncycastle:bcprov-jdk18on` on `jvmCommon`
- Used only for Argon2id in the Android app-lock PIN wrap (`PinWrap`).
  AES-GCM stays on `javax.crypto`. Not registered as a JCA provider.
