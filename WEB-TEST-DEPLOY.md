# Velta web-test deployment source

`web-test.patch.gz.b64` contains the reviewed source patch, compressed with gzip and encoded as base64. Its base is master commit `c3571a29a150b28cd881a1e46cf4d1fd393d85fe`.

Decode and apply it on that base:

```sh
base64 -d web-test.patch.gz.b64 | gzip -d > /tmp/web-test.patch
git apply --check /tmp/web-test.patch
git apply /tmp/web-test.patch
```

Build without a baked relay proxy:

```sh
node scripts/build-pwa.mjs --wasm-dist wasm --out build/dist-pwa --instance web-test
```

Publish the complete `build/dist-pwa/` contents only as `web-test/` on the `website` branch with a normal commit. Do not replace production `web/` and do not force-push `pwa-dist`.
