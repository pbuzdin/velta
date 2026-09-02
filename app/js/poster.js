// poster.js — lazy WebP poster frames for video placeholders.
//
// A poster must not touch the media-serving path that <video> uses (the
// asset protocol fails mid-file range reads on Android; desktop WebViews
// differ). Instead the file is read once through the scoped Rust command
// into a blob URL, a frame is captured from a hidden <video>, encoded as
// WebP and persisted next to the account database. Later mounts get the
// cached image served through the asset protocol (plain GETs work fine).

const MAX_EXTRACT_BYTES = 128 * 1024 * 1024; // don't buffer huge files for a frame
const CAPTURE_AT = 1.0; // seconds into the clip (clamped to 10% for shorts)
const MAX_EDGE = 480; // poster longest side in px

const results = new Map(); // src -> Promise<string|null>
let chain = Promise.resolve(); // serialize extractions: one decode at a time

function invokeFn() {
    const tauri = window.__TAURI__;
    return tauri?.core?.invoke || tauri?.invoke || null;
}

function videoFrameAsWebP(bytes) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([bytes], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        const cleanup = () => {
            v.removeAttribute("src");
            v.load();
            URL.revokeObjectURL(url);
        };
        const fail = (err) => { cleanup(); reject(err); };
        const timer = setTimeout(() => fail(new Error("poster frame timeout")), 15000);
        let captured = false;
        const capture = () => {
            if (captured || !v.videoWidth) return;
            captured = true;
            try {
                const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
                const w = Math.max(2, Math.round(v.videoWidth * scale));
                const h = Math.max(2, Math.round(v.videoHeight * scale));
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                canvas.getContext("2d").drawImage(v, 0, 0, w, h);
                canvas.toBlob(
                    (webp) => {
                        clearTimeout(timer);
                        cleanup();
                        if (webp && webp.type === "image/webp") {
                            webp.arrayBuffer().then(resolve, (e) => reject(e));
                        } else {
                            // Encoder missing → no poster; the placeholder
                            // with badges remains.
                            resolve(null);
                        }
                    },
                    "image/webp",
                    0.72
                );
            } catch (e) {
                clearTimeout(timer);
                fail(e);
            }
        };
        v.addEventListener("loadedmetadata", () => {
            const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
            const at = Math.min(CAPTURE_AT, dur * 0.1);
            if (at > 0) {
                v.currentTime = at;
            } else {
                // Already at 0 — seeking there never fires `seeked`.
                setTimeout(capture, 120); // let the first frame land
            }
        });
        v.addEventListener("seeked", capture, { once: true });
        v.addEventListener("error", () => { clearTimeout(timer); fail(new Error("poster video decode failed")); });
        v.src = url;
    });
}

/**
 * Resolve a poster image URL for a video file path.
 * Returns a WebView-safe URL for the cached WebP, or null when extraction
 * is impossible (no backend, oversized, undecodable). Results are cached
 * per source path and extractions run one at a time.
 */
export function ensurePoster(file) {
    if (!file) return Promise.resolve(null);
    if (results.has(file)) return results.get(file);
    const job = chain.then(() => extract(file)).catch(() => null);
    // Keep the pipeline flowing even when a caller ignores the per-file job.
    results.set(file, job);
    chain = job.then(() => {}, () => {});
    return job;
}

async function extract(file) {
    const invoke = invokeFn();
    if (!invoke) return null;
    try {
        const meta = await invoke("poster_cache_path", { src: file });
        if (meta?.exists) return fileUrlOf(meta.path);

        const bytes = await invoke("read_media_bytes", { src: file });
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_EXTRACT_BYTES) return null;

        const webp = await videoFrameAsWebP(bytes);
        if (!webp) return null;

        const path = await invoke("write_poster", { src: file, bytes: new Uint8Array(webp) });
        return path ? fileUrlOf(path) : null;
    } catch (e) {
        return null;
    }
}

function fileUrlOf(path) {
    // media.js fileUrl without the import cycle risk — same resolution rules.
    const tauri = window.__TAURI__;
    if (tauri?.core?.convertFileSrc) {
        let resolved = path.replace(/\\/g, "/");
        const isAbs = /^([a-zA-Z]:|\/)/.test(resolved);
        if (!isAbs && window.veltaAccountsDir) {
            const base = window.veltaAccountsDir.replace(/\\/g, "/").replace(/\/$/, "");
            resolved = `${base}/${resolved.replace(/^\/+/, "")}`;
        }
        return tauri.core.convertFileSrc(resolved);
    }
    return path;
}
