// Opt-in composer refraction: cache nearby rows, then reproject them in one WebGL pass.
import { toCanvas } from "../vendor/html-to-image.module.js";
import {
  createBufferInfoFromArrays,
  createProgramInfo,
  drawBufferInfo,
  setBuffersAndAttributes,
  setUniforms,
} from "../vendor/twgl-glass.module.js";

const LOW_POWER = matchMedia("(pointer: coarse)").matches;
const MARGIN = 36;
const TEXTURE_MARGIN = LOW_POWER ? 128 : 256;
const CAPTURE_MARGIN = TEXTURE_MARGIN + 128;
const MAX_ROWS = 10;
const CAPTURE_DELAY = 140;

export function createWebGLGlass(host, scroll) {
  const pane = host.querySelector(":scope > .lg-pane");
  if (!pane || !scroll) return { refresh() {}, destroy() {} };

  const canvas = document.createElement("canvas");
  canvas.className = "lg-layer webgl-glass-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return { refresh() {}, destroy() {} };

  const program = createProgramInfo(gl, [`
    attribute vec2 position;
    varying vec2 vUv;
    void main() {
      vUv = position * 0.5 + 0.5;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `, `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec2 uSampleSize;
    uniform vec2 uOutputSize;
    uniform vec2 uMargin;
    uniform float uScrollShift;
    uniform float uRadius;

    void main() {
      vec2 p = vUv * uOutputSize;
      vec2 halfSize = uOutputSize * 0.5;
      vec2 core = max(halfSize - vec2(uRadius), vec2(0.0));
      vec2 fromCenter = p - halfSize;
      vec2 q = abs(fromCenter) - core;
      float distanceToEdge = -(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius);
      float edge = 1.0 - smoothstep(0.0, uRadius, max(distanceToEdge, 0.0));
      vec2 normal = normalize(fromCenter - clamp(fromCenter, -core, core) + vec2(0.0001));
      vec2 bend = normal * edge * edge * min(22.0, uRadius * 0.7);
      vec2 uv = (uMargin + p + vec2(0.0, uScrollShift)) / uSampleSize;
      vec2 dispersion = bend / uSampleSize;
      vec3 color;
      if (abs(uScrollShift) > 0.01) {
        color = texture2D(uTexture, uv + dispersion).rgb;
      } else {
        color = vec3(
          texture2D(uTexture, uv + dispersion * 1.08).r,
          texture2D(uTexture, uv + dispersion).g,
          texture2D(uTexture, uv + dispersion * 0.92).b
        );
      }
      gl_FragColor = vec4(color, 1.0);
    }
  `]);
  const triangle = createBufferInfoFromArrays(gl, {
    position: { numComponents: 2, data: [-1, -1, 3, -1, -1, 3] },
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  pane.before(canvas);
  host.classList.toggle("webgl-low-power", LOW_POWER);

  const sample = document.createElement("canvas");
  const context = sample.getContext("2d", { alpha: false });
  const cache = new Map();
  let dpr = Math.min(devicePixelRatio || 1, LOW_POWER ? 0.75 : 1.5);
  let background = null;
  let revision = 0;
  let timer = 0;
  let frame = 0;
  let frameReuse = false;
  let textureReady = false;
  let renderedScrollTop = scroll.scrollTop;
  let capturing = false;
  let captureAgain = false;
  let dead = false;

  const rowKey = (row, rect) => `${row.dataset.msgid || ""}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  const rows = (margin = TEXTURE_MARGIN) => {
    const box = host.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const left = box.left - MARGIN;
    const right = box.right + MARGIN;
    const top = box.top - margin;
    const bottom = box.bottom + margin;
    return [...scroll.querySelectorAll(".msg-row")].filter(row => {
      const r = row.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > left && r.left < right
        && r.bottom > Math.max(top, view.top) && r.top < Math.min(bottom, view.bottom);
    });
  };

  function resize() {
    const width = Math.max(1, Math.round(host.clientWidth * dpr));
    const height = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function render() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program.program);
    setBuffersAndAttributes(gl, program, triangle);
    setUniforms(program, {
      uTexture: texture,
      uSampleSize: [sample.width, sample.height],
      uOutputSize: [canvas.width, canvas.height],
      uMargin: [MARGIN * dpr, TEXTURE_MARGIN * dpr],
      uScrollShift: -(scroll.scrollTop - renderedScrollTop) * dpr,
      uRadius: Math.min(32 * dpr, canvas.width / 2, canvas.height / 2),
    });
    drawBufferInfo(gl, triangle);
  }

  function draw() {
    frame = 0;
    const reuse = frameReuse;
    frameReuse = false;
    if (dead || host.hidden || !host.clientWidth || !host.clientHeight) return;
    if (reuse && textureReady) {
      render();
      return;
    }
    resize();
    const box = host.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const originX = box.left - MARGIN;
    const originY = box.top - TEXTURE_MARGIN;
    const width = box.width + MARGIN * 2;
    const height = box.height + TEXTURE_MARGIN * 2;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (sample.width !== pixelWidth || sample.height !== pixelHeight) {
      sample.width = pixelWidth;
      sample.height = pixelHeight;
    }
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg-chat").trim() || "#0b0b10";
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    if (background) {
      context.drawImage(
        background,
        (originX - view.left) * dpr, (originY - view.top) * dpr, width * dpr, height * dpr,
        0, 0, pixelWidth, pixelHeight,
      );
    }

    let painted = 0;
    for (const row of rows()) {
      const rect = row.getBoundingClientRect();
      const entry = cache.get(row);
      if (!entry || entry.key !== rowKey(row, rect)) continue;
      cache.delete(row);
      cache.set(row, entry);
      context.drawImage(
        entry.canvas, 0, 0, entry.canvas.width, entry.canvas.height,
        (rect.left - originX) * dpr, (rect.top - originY) * dpr, rect.width * dpr, rect.height * dpr,
      );
      painted++;
    }
    textureReady = painted > 0;
    host.classList.toggle("webgl-ready", textureReady);
    if (!textureReady) return;

    renderedScrollTop = scroll.scrollTop;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sample);
    render();
  }

  function requestDraw(reuse = false) {
    if (dead || document.visibilityState === "hidden") return;
    frameReuse = frame ? frameReuse && reuse : reuse;
    if (!frame) frame = requestAnimationFrame(draw);
  }

  async function capture() {
    if (capturing) {
      captureAgain = true;
      return;
    }
    capturing = true;
    const ticket = revision;
    try {
      if (host.hidden || !host.clientWidth || !rows(CAPTURE_MARGIN).length) return;
      if (!background) {
        const shot = await toCanvas(scroll, {
          pixelRatio: dpr,
          width: scroll.clientWidth,
          height: scroll.clientHeight,
          fontEmbedCSS: "",
          filter: node => node.id !== "history",
          style: { overflow: "hidden", transform: "none" },
        });
        if (ticket === revision) background = shot;
      }
      for (const row of rows(CAPTURE_MARGIN)) {
        const rect = row.getBoundingClientRect();
        const key = rowKey(row, rect);
        if (cache.get(row)?.key === key) continue;
        const shot = await toCanvas(row, {
          pixelRatio: dpr,
          fontEmbedCSS: "",
          style: { animation: "none", transition: "none" },
        });
        if (ticket !== revision || !row.isConnected) continue;
        cache.delete(row);
        cache.set(row, { key, canvas: shot });
        for (const cached of cache.keys()) {
          if (cache.size <= MAX_ROWS && cached.isConnected) break;
          cache.delete(cached);
        }
      }
      if (ticket === revision) requestDraw();
    } catch {
      disable();
    } finally {
      capturing = false;
      if (captureAgain && !dead) {
        captureAgain = false;
        scheduleCapture();
      }
    }
  }

  function scheduleCapture() {
    clearTimeout(timer);
    // DOM rasterization waits for a pause; active scrolling only reuses the GPU texture.
    if (!dead && document.visibilityState !== "hidden") timer = setTimeout(capture, CAPTURE_DELAY);
  }

  function invalidate() {
    revision++;
    background = null;
    cache.clear();
    textureReady = false;
    host.classList.remove("webgl-ready");
    scheduleCapture();
  }

  const mutations = new MutationObserver(records => {
    revision++;
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const row = target?.closest?.(".msg-row");
      if (row) cache.delete(row);
      // Virtual-scroller mount/unmount changes #history, not the cached rows.
      else if (record.type === "attributes") cache.clear();
    }
    requestDraw();
    scheduleCapture();
  });
  mutations.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "src", "data-msgid"] });

  const sizes = new ResizeObserver(() => {
    resize();
    requestDraw();
    scheduleCapture();
  });
  sizes.observe(host);
  const backgroundSize = new ResizeObserver(() => {
    revision++;
    background = null;
    scheduleCapture();
  });
  backgroundSize.observe(scroll);
  const theme = new MutationObserver(invalidate);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-amoled"] });

  const onScroll = () => {
    const outsideTexture = Math.abs(scroll.scrollTop - renderedScrollTop) > TEXTURE_MARGIN - 48;
    requestDraw(!outsideTexture);
    scheduleCapture();
  };
  const onLoad = event => {
    const row = event.target?.closest?.(".msg-row");
    if (!row) return;
    revision++;
    cache.delete(row);
    scheduleCapture();
  };
  const onResize = () => {
    dpr = Math.min(devicePixelRatio || 1, LOW_POWER ? 0.75 : 1.5);
    invalidate();
    resize();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      frame = 0;
    } else scheduleCapture();
  };
  const onContextLoss = event => {
    event.preventDefault();
    disable();
  };
  scroll.addEventListener("scroll", onScroll, { passive: true });
  scroll.addEventListener("load", onLoad, true);
  scroll.addEventListener("velta-row-resized", invalidate);
  addEventListener("resize", onResize, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onContextLoss);

  function disable() {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    mutations.disconnect();
    sizes.disconnect();
    backgroundSize.disconnect();
    theme.disconnect();
    scroll.removeEventListener("scroll", onScroll);
    scroll.removeEventListener("load", onLoad, true);
    scroll.removeEventListener("velta-row-resized", invalidate);
    removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onContextLoss);
    host.classList.remove("webgl-ready", "webgl-low-power");
    textureReady = false;
    cache.clear();
    canvas.remove();
  }

  resize();
  scheduleCapture();
  return { refresh: scheduleCapture, destroy: disable };
}
