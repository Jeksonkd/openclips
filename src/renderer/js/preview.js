// Real-time player: hidden <video>/<img> pool kept in sync with the
// playhead, per-clip WebGL color pass, then a 2D compositor pass that
// applies transform/opacity/blend-mode across tracks (bottom -> top).
// Adjustment-layer tracks re-run the same color pass over the accumulated
// composite so far, matching "adjustment layers affect everything below".

const BLEND_MAP = {
  normal: 'source-over', screen: 'screen', multiply: 'multiply', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', difference: 'difference', addition: 'lighter',
};

function db2lin(db) { return Math.pow(10, db / 20); }

function animCfg(clip, key) {
  const c = clip && clip[key];
  return (c && c.type) ? c : { type: 'none', duration: 0.5 };
}

// Declarative in/out animation math, shared by clip animations and
// transitions (a transition just auto-sets animIn/animOut on the two
// neighboring clips, see ProjectState.applyTransition). inP/outP are 0..1
// progress fractions; everything is a no-op (mul=1, offset=0) outside its
// window since inP/outP saturate to 1 there.
function computeAnimAdjust(clip, localTime, dur, canvasW, canvasH) {
  const inCfg = animCfg(clip, 'animIn');
  const outCfg = animCfg(clip, 'animOut');
  const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
  const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
  const inP = inCfg.type !== 'none' ? Math.max(0, Math.min(1, localTime / inD)) : 1;
  const outP = outCfg.type !== 'none' ? Math.max(0, Math.min(1, (dur - localTime) / outD)) : 1;

  let opacityMul = 1, offsetX = 0, offsetY = 0, scaleMul = 1;
  if (inCfg.type === 'fade') opacityMul *= inP;
  if (outCfg.type === 'fade') opacityMul *= outP;
  if (inCfg.type === 'slide') offsetX += (1 - inP) * canvasW;
  if (outCfg.type === 'slide') offsetX += -(1 - outP) * canvasW;
  if (inCfg.type === 'zoom') scaleMul *= (0.7 + 0.3 * inP);
  if (outCfg.type === 'zoom') scaleMul *= (0.7 + 0.3 * outP);
  return { opacityMul, offsetX, offsetY, scaleMul };
}

// Transition types that need an actual spatial mask (not just an opacity/
// position/scale ramp) - wipe/iris reveal via a clip path, dissolve via a
// tile grid, all mirroring the geq-based masks exportGraph.js builds for the
// real render, so preview and export show the same shape of transition.
const MASK_ANIM_TYPES = new Set(['wipe', 'iris', 'dissolve', 'blinds', 'clock']);

function maskInfoFor(clip, localTime, dur) {
  const inCfg = animCfg(clip, 'animIn');
  const outCfg = animCfg(clip, 'animOut');
  if (MASK_ANIM_TYPES.has(inCfg.type)) {
    const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
    return { type: inCfg.type, progress: Math.max(0, Math.min(1, localTime / inD)) };
  }
  if (MASK_ANIM_TYPES.has(outCfg.type)) {
    const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
    return { type: outCfg.type, progress: Math.max(0, Math.min(1, (dur - localTime) / outD)) };
  }
  return null;
}

// Draws via drawFn() (which is expected to draw into a coordinate space
// already translated/rotated to the clip's center, matching how the caller
// draws its image) clipped to the current mask shape/progress. w/h are the
// clip's own on-screen box size in that same local space.
function applyMaskAndDraw(ctx, mask, drawFn, w, h) {
  if (!mask) { drawFn(); return; }
  if (mask.type === 'wipe') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w * mask.progress, h);
    ctx.clip();
    drawFn();
    ctx.restore();
  } else if (mask.type === 'iris') {
    ctx.save();
    ctx.beginPath();
    const r = Math.max(0, Math.hypot(w, h) / 2 * mask.progress);
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    drawFn();
    ctx.restore();
  } else if (mask.type === 'dissolve') {
    const cols = 12, rows = 8;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const idx = ty * cols + tx;
        const hash = ((idx * 2654435761) % 1000) / 1000;
        if (hash > mask.progress) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(-w / 2 + tx * (w / cols), -h / 2 + ty * (h / rows), w / cols + 1, h / rows + 1);
        ctx.clip();
        drawFn();
        ctx.restore();
      }
    }
  } else if (mask.type === 'blinds') {
    const stripes = 8;
    const stripeW = w / stripes;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < stripes; i++) {
      ctx.rect(-w / 2 + i * stripeW, -h / 2, stripeW * mask.progress, h);
    }
    ctx.clip();
    drawFn();
    ctx.restore();
  } else if (mask.type === 'clock') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const r = Math.hypot(w, h);
    const sweep = mask.progress * Math.PI * 2;
    // Matches the rotate-handle convention (0 at 12 o'clock, clockwise) used
    // elsewhere in this file/canvasOverlay.js: angle measured from -Y, going
    // clockwise, so start at (0,-r) and arc using -PI/2 as the zero point.
    ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + sweep);
    ctx.closePath();
    ctx.clip();
    drawFn();
    ctx.restore();
  } else {
    drawFn();
  }
}

// Static (non-animated) clip mask - rect/ellipse crop from the Mask & Blend
// tab. w/h here are the SOURCE canvas's own pixel dimensions (unlike
// applyMaskAndDraw, this runs before any transform/translate is applied).
// Resolves a clip's mask config at a given local time, sampling
// mask_posX/mask_posY/mask_sizeX/mask_sizeY as keyframed properties (same
// KF property names the Mask & Blend tab's fields use) when animated, else
// falling back to the mask's static values.
function sampledMaskFor(clip, localTime) {
  const m = clip.mask;
  if (!m || !m.type || m.type === 'none') return m;
  return {
    type: m.type,
    invert: m.invert,
    posX: KF.sample(clip, 'mask_posX', localTime, m.posX == null ? 0.5 : m.posX),
    posY: KF.sample(clip, 'mask_posY', localTime, m.posY == null ? 0.5 : m.posY),
    sizeX: KF.sample(clip, 'mask_sizeX', localTime, m.sizeX == null ? 0.3 : m.sizeX),
    sizeY: KF.sample(clip, 'mask_sizeY', localTime, m.sizeY == null ? 0.3 : m.sizeY),
  };
}

function hexToRgb(hex) {
  hex = (hex || '#00ff00').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16) || 0x00ff00;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Green screen / chroma key. A per-pixel RGB-distance test with a soft
// blended edge band, matching the density (how wide the keyed color range
// is) / shadows (how gradually its edge fades) controls in the Mask &
// Blend tab - see exportGraph.js's buildChromaKeyFilter for why export
// uses ffmpeg's real chromakey filter instead of this same math (this is
// the preview-only approximation; the real render is more accurate since
// it works in YUV, which is more forgiving of shadow/lighting variation).
function applyChromaKey(source, chromaKey, w, h) {
  if (!chromaKey || !chromaKey.enabled) return source;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(source, 0, 0, w, h);
  let imgData;
  try {
    imgData = octx.getImageData(0, 0, w, h);
  } catch (e) { return source; }
  const data = imgData.data;
  const key = hexToRgb(chromaKey.color);
  const density = (chromaKey.density == null ? 50 : chromaKey.density) / 100;
  const shadows = (chromaKey.shadows == null ? 50 : chromaKey.shadows) / 100;
  const simThreshold = density * 180;
  const blendRange = Math.max(1, shadows * 140);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - key.r, dg = data[i + 1] - key.g, db = data[i + 2] - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < simThreshold) {
      data[i + 3] = 0;
    } else if (dist < simThreshold + blendRange) {
      const t = (dist - simThreshold) / blendRange;
      data[i + 3] = Math.round(data[i + 3] * t);
    }
  }
  octx.putImageData(imgData, 0, 0);
  return off;
}

function applyStaticMask(source, mask, w, h) {
  if (!mask || !mask.type || mask.type === 'none') return source;
  const shape = document.createElement('canvas');
  shape.width = w; shape.height = h;
  const sctx = shape.getContext('2d');
  const cx = w * (mask.posX == null ? 0.5 : mask.posX);
  const cy = h * (mask.posY == null ? 0.5 : mask.posY);
  const rx = w * Math.max(0.01, mask.sizeX == null ? 0.3 : mask.sizeX);
  const ry = h * Math.max(0.01, mask.sizeY == null ? 0.3 : mask.sizeY);
  sctx.fillStyle = '#fff';
  sctx.beginPath();
  if (mask.type === 'ellipse') {
    sctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  } else if (mask.type === 'diamond') {
    sctx.moveTo(cx, cy - ry);
    sctx.lineTo(cx + rx, cy);
    sctx.lineTo(cx, cy + ry);
    sctx.lineTo(cx - rx, cy);
    sctx.closePath();
  } else if (mask.type === 'triangle') {
    sctx.moveTo(cx, cy - ry);
    sctx.lineTo(cx + rx, cy + ry);
    sctx.lineTo(cx - rx, cy + ry);
    sctx.closePath();
  } else if (mask.type === 'star') {
    // Same polar-radius-modulation formula as exportGraph.js's geq mask, so
    // the preview and the real render agree on the shape.
    const steps = 72;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const thresh = 0.725 + 0.275 * Math.cos(5 * theta);
      const x = cx + Math.cos(theta) * rx * thresh;
      const y = cy + Math.sin(theta) * ry * thresh;
      if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    }
    sctx.closePath();
  } else {
    sctx.rect(cx - rx, cy - ry, rx * 2, ry * 2);
  }
  sctx.fill();

  let finalShape = shape;
  if (mask.invert) {
    const inv = document.createElement('canvas');
    inv.width = w; inv.height = h;
    const ictx = inv.getContext('2d');
    ictx.fillStyle = '#fff';
    ictx.fillRect(0, 0, w, h);
    ictx.globalCompositeOperation = 'destination-out';
    ictx.drawImage(shape, 0, 0);
    finalShape = inv;
  }

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  octx.drawImage(source, 0, 0, w, h);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(finalShape, 0, 0);
  return out;
}

// Renders one of the "effect" clip kind's looks onto an offscreen canvas the
// size of `source`. Used both for a global effect clip (source = a snapshot
// of the composite so far, like an adjustment layer) and a targeted one
// (source = one specific clip's own rendered frame, before it's composited).
function applyEffectToCanvas(source, effect, w, h) {
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  const amt = (effect && effect.amount == null) ? 50 : ((effect && effect.amount) || 0);
  const type = effect && effect.type;
  if (type === 'blur') {
    octx.filter = `blur(${(amt / 100 * 20).toFixed(1)}px)`;
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'bw') {
    octx.filter = 'grayscale(1)';
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'invert') {
    octx.filter = 'invert(1)';
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'mirror') {
    octx.translate(w, 0);
    octx.scale(-1, 1);
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'pixelate') {
    const blocks = Math.max(2, Math.round(4 + (amt / 100) * 60));
    const sw = Math.max(1, Math.round(w / blocks));
    const sh = Math.max(1, Math.round(h / blocks));
    const tiny = document.createElement('canvas');
    tiny.width = sw; tiny.height = sh;
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(source, 0, 0, sw, sh);
    octx.imageSmoothingEnabled = false;
    octx.drawImage(tiny, 0, 0, sw, sh, 0, 0, w, h);
  } else if (type === 'vflip') {
    octx.translate(0, h);
    octx.scale(1, -1);
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'sepia') {
    octx.filter = `sepia(${(amt / 100).toFixed(2)})`;
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'hueRotate') {
    octx.filter = `hue-rotate(${((amt / 100) * 360).toFixed(0)}deg)`;
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'vintage') {
    // Approximates ffmpeg's curves=preset=vintage look for live preview -
    // the export uses the real preset, this just needs to read as "similar".
    octx.filter = 'sepia(0.35) saturate(1.3) contrast(1.1) brightness(0.92)';
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'crossProcess') {
    octx.filter = 'contrast(1.35) saturate(1.5) hue-rotate(8deg) brightness(1.05)';
    octx.drawImage(source, 0, 0, w, h);
  } else if (type === 'rgbSplit') {
    // Cheap real-time approximation of a channel shift: additive ghosting
    // offset left/right (true per-channel isolation is what export's
    // rgbashift does exactly; this just needs to look "glitchy" live).
    const shift = Math.max(1, Math.round((amt / 100) * 20));
    octx.drawImage(source, 0, 0, w, h);
    octx.globalCompositeOperation = 'screen';
    octx.globalAlpha = 0.7;
    octx.drawImage(source, -shift, 0, w, h);
    octx.drawImage(source, shift, 0, w, h);
    octx.globalAlpha = 1;
  } else if (type === 'edgeDetect' || type === 'emboss') {
    // Runs the convolution at a small resolution so a raw per-pixel kernel
    // loop stays cheap enough for real-time preview - reads as a stylized/
    // chunky version of the precise full-res kernel export applies.
    return smallConvolve(source, w, h, type === 'edgeDetect'
      ? [-1, -1, -1, -1, 8, -1, -1, -1, -1]
      : [-2, -1, 0, -1, 1, 1, 0, 1, 2], type === 'emboss' ? 128 : 0);
  } else {
    octx.drawImage(source, 0, 0, w, h);
  }
  return off;
}

function smallConvolve(source, w, h, kernel, bias) {
  const smallW = 160;
  const smallH = Math.max(1, Math.round(h * (smallW / w)));
  const small = document.createElement('canvas');
  small.width = smallW; small.height = smallH;
  const sctx = small.getContext('2d');
  sctx.drawImage(source, 0, 0, smallW, smallH);
  const imgData = sctx.getImageData(0, 0, smallW, smallH);
  const src = imgData.data;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.min(smallW - 1, Math.max(0, x + kx));
          const sy = Math.min(smallH - 1, Math.max(0, y + ky));
          const idx = (sy * smallW + sx) * 4;
          const kv = kernel[(ky + 1) * 3 + (kx + 1)];
          r += src[idx] * kv; g += src[idx + 1] * kv; b += src[idx + 2] * kv;
        }
      }
      const oidx = (y * smallW + x) * 4;
      out[oidx] = r + bias; out[oidx + 1] = g + bias; out[oidx + 2] = b + bias;
      out[oidx + 3] = src[oidx + 3];
    }
  }
  sctx.putImageData(new ImageData(out, smallW, smallH), 0, 0);
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  const fctx = full.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.drawImage(small, 0, 0, w, h);
  return full;
}

class PreviewEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mediaElements = new Map(); // mediaId -> HTMLVideoElement/HTMLImageElement
    this.pipelines = new Map(); // clipId -> ColorPipeline
    this.snapshotPipeline = new ColorPipeline();
    this.snapshotCanvas = document.createElement('canvas');
    this._rafId = null;
    this._wallStart = 0;
    this._timeStart = 0;
    this.audioCtx = null;
    this.audioChains = new Map(); // mediaElement -> {source, panner, gain}
  }

  _ensureAudioCtx() {
    if (!this.audioCtx) {
      try { this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.audioCtx = null; }
    }
    return this.audioCtx;
  }

  _audioChainFor(el) {
    if (this.audioChains.has(el)) return this.audioChains.get(el);
    const ctx = this._ensureAudioCtx();
    if (!ctx) return null;
    try {
      const source = ctx.createMediaElementSource(el);
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      source.connect(panner).connect(gain).connect(ctx.destination);
      const chain = { source, panner, gain };
      this.audioChains.set(el, chain);
      return chain;
    } catch (e) { return null; }
  }

  getMediaEl(media) {
    if (this.mediaElements.has(media.id)) return this.mediaElements.get(media.id);
    let el;
    if (media.type === 'image') {
      el = document.createElement('img');
      el.src = window.engine.toMediaUrl(media.path);
    } else {
      el = document.createElement('video');
      el.src = window.engine.toMediaUrl(media.path);
      el.preload = 'auto';
      el.playsInline = true;
      el.muted = false;
    }
    this.mediaElements.set(media.id, el);
    return el;
  }

  pipelineFor(clipId) {
    if (!this.pipelines.has(clipId)) this.pipelines.set(clipId, new ColorPipeline());
    return this.pipelines.get(clipId);
  }

  activeClipsAt(time) {
    const out = [];
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        const dur = project.clipDisplayDuration(clip);
        if (time >= clip.startTime && time < clip.startTime + dur) out.push({ clip, track });
      }
    }
    return out;
  }

  play() {
    if (project.isPlaying) return;
    project.isPlaying = true;
    this._wallStart = performance.now();
    this._timeStart = project.timeline.currentTime;
    const loop = () => {
      if (!project.isPlaying) return;
      const elapsed = (performance.now() - this._wallStart) / 1000;
      let t = this._timeStart + elapsed;
      const dur = project.projectDuration();
      if (t >= dur) { t = dur; this.pause(); }
      project.timeline.currentTime = t;
      project.emit('time:changed');
      this.renderFrame(t, true);
      if (project.isPlaying) this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  pause() {
    project.isPlaying = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    for (const el of this.mediaElements.values()) {
      if (el.tagName === 'VIDEO' && !el.paused) el.pause();
    }
  }

  seek(time) {
    project.timeline.currentTime = Math.max(0, Math.min(project.projectDuration(), time));
    project.emit('time:changed');
    this.renderFrame(project.timeline.currentTime, false);
  }

  _syncMediaElement(el, media, clip, track, localTime, playing) {
    const mult = (clip.speed && clip.speed.multiplier) || 1;
    if (el.tagName === 'VIDEO') {
      const naturalDuration = media.duration || el.duration || Infinity;
      const needsLoop = clip.outPoint > naturalDuration + 0.01;
      el.loop = needsLoop;

      const rawSourceTime = clip.inPoint + localTime * mult;
      let sourceTime = rawSourceTime;
      if (needsLoop && naturalDuration > clip.inPoint) {
        const span = naturalDuration - clip.inPoint;
        sourceTime = clip.inPoint + (((rawSourceTime - clip.inPoint) % span) + span) % span;
      }
      el.playbackRate = Math.max(0.1, Math.min(16, mult));
      if (Math.abs(el.currentTime - sourceTime) > 0.2 || !playing) {
        try { el.currentTime = Math.max(0, Math.min(el.duration || sourceTime, sourceTime)); } catch (e) {}
      }
      el.muted = !!track.muted;
      const chain = this._audioChainFor(el);
      const dur = project.clipDisplayDuration(clip);
      let fadeMul = 1;
      if (clip.fadeIn && localTime < clip.fadeIn) fadeMul *= localTime / clip.fadeIn;
      if (clip.fadeOut && localTime > dur - clip.fadeOut) fadeMul *= Math.max(0, (dur - localTime) / clip.fadeOut);
      const effectiveDb = KF.sample(clip, 'volume', localTime, clip.volume);
      const vol = track.muted ? 0 : Math.max(0, Math.min(1, db2lin(effectiveDb) * fadeMul));
      if (chain) {
        chain.gain.gain.value = vol;
        chain.panner.pan.value = Math.max(-1, Math.min(1, clip.pan || 0));
      } else {
        el.volume = vol;
      }
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  }

  // Shared by rendering and the on-canvas move/resize overlay so both agree
  // on where a clip currently sits (keyframe-sampled transform + box size).
  transformStateFor(clip, localTime, srcW, srcH) {
    const scale = KF.sample(clip, 'scale', localTime, clip.transform.scale);
    const rotation = KF.sample(clip, 'rotation', localTime, clip.transform.rotation);
    const opacity = KF.sample(clip, 'opacity', localTime, clip.transform.opacity);
    const posX = KF.sample(clip, 'positionX', localTime, clip.transform.positionX);
    const posY = KF.sample(clip, 'positionY', localTime, clip.transform.positionY);
    const dur = project.clipDisplayDuration(clip);
    const anim = computeAnimAdjust(clip, localTime, dur, project.canvas.width, project.canvas.height);
    const finalScale = scale * anim.scaleMul;
    return {
      scale: finalScale, rotation,
      opacity: opacity * anim.opacityMul,
      posX: posX + anim.offsetX, posY: posY + anim.offsetY,
      drawW: srcW * finalScale, drawH: srcH * finalScale,
    };
  }

  intrinsicSizeFor(clip) {
    if (clip.kind === 'text') {
      const t = clip.text || {};
      const ctx = this.ctx;
      ctx.save();
      ctx.font = `${t.fontSize || 64}px ${t.fontFamily || 'Sans'}`;
      const lines = String(t.content || '').split('\n');
      const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
      const h = Math.max(1, lines.length * (t.fontSize || 64) * 1.2);
      ctx.restore();
      return { w, h };
    }
    if (clip.kind === 'adjustment') return { w: project.canvas.width, h: project.canvas.height };
    const media = project.media[clip.mediaId];
    return { w: (media && media.width) || project.canvas.width, h: (media && media.height) || project.canvas.height };
  }

  drawText(ctx, clip, state, w, h) {
    const t = clip.text || {};
    const opacity = Math.max(0, Math.min(1, state.opacity));
    ctx.save();
    ctx.globalCompositeOperation = BLEND_MAP[clip.transform.blendMode] || 'source-over';
    ctx.translate(w / 2 + state.posX, h / 2 + state.posY);
    ctx.rotate((state.rotation || 0) * Math.PI / 180);
    ctx.scale(state.scale || 1, state.scale || 1);
    ctx.font = `${t.fontSize || 64}px ${t.fontFamily || 'Sans'}`;
    ctx.textAlign = t.align || 'center';
    ctx.textBaseline = 'middle';
    const lines = String(t.content || '').split('\n');
    const lineHeight = (t.fontSize || 64) * 1.2;
    const totalH = lineHeight * lines.length;

    if (t.bgEnabled) {
      const maxWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
      const pad = (t.fontSize || 64) * 0.18;
      let boxX;
      if (t.align === 'left') boxX = -pad;
      else if (t.align === 'right') boxX = -maxWidth - pad;
      else boxX = -maxWidth / 2 - pad;
      ctx.globalAlpha = opacity * (t.bgOpacity == null ? 0.6 : t.bgOpacity);
      ctx.fillStyle = t.bgColor || '#000000';
      ctx.fillRect(boxX, -totalH / 2 - pad, maxWidth + pad * 2, totalH + pad * 2);
    }

    ctx.globalAlpha = opacity;
    ctx.fillStyle = t.color || '#ffffff';
    lines.forEach((line, i) => {
      ctx.fillText(line, 0, -totalH / 2 + lineHeight / 2 + i * lineHeight);
    });
    ctx.restore();
  }

  renderFrame(time, playing) {
    const w = project.canvas.width;
    const h = project.canvas.height;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const active = this.activeClipsAt(time);
    const playedMediaIds = new Set();

    // Effect clips targeting specific other clips apply at the point those
    // target clips render (below), not at the effect clip's own position in
    // the track loop - collect that mapping up front.
    const targetEffectsByClip = new Map();
    for (const { clip: ec } of active) {
      if (ec.kind === 'effect' && ec.effectTargets && ec.effectTargets.length > 0) {
        for (const tid of ec.effectTargets) {
          if (!targetEffectsByClip.has(tid)) targetEffectsByClip.set(tid, []);
          targetEffectsByClip.get(tid).push(ec.effect);
        }
      }
    }

    for (const { clip, track } of active) {
      const localTime = time - clip.startTime;

      if (clip.kind === 'adjustment') {
        this.snapshotCanvas.width = w;
        this.snapshotCanvas.height = h;
        this.snapshotCanvas.getContext('2d').drawImage(this.canvas, 0, 0);
        const out = this.snapshotPipeline.render(this.snapshotCanvas, clip.adjustments, w, h, time);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(out, 0, 0, w, h);
        ctx.restore();
        continue;
      }

      if (clip.kind === 'effect') {
        // Targeted effects (effectTargets non-empty) contribute nothing here
        // directly - they're picked up via targetEffectsByClip when their
        // target clip renders below. Only a global effect (no targets) acts
        // like an adjustment layer, on the composite so far.
        if (!clip.effectTargets || clip.effectTargets.length === 0) {
          this.snapshotCanvas.width = w;
          this.snapshotCanvas.height = h;
          this.snapshotCanvas.getContext('2d').drawImage(this.canvas, 0, 0);
          const out = applyEffectToCanvas(this.snapshotCanvas, clip.effect, w, h);
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(out, 0, 0, w, h);
          ctx.restore();
        }
        continue;
      }

      if (clip.kind === 'text') {
        const state = this.transformStateFor(clip, localTime, 1, 1);
        this.drawText(ctx, clip, state, w, h);
        continue;
      }

      if (clip.kind === 'draw') {
        // Strokes are recorded in project.canvas pixel space, so the "source"
        // is exactly that size - at the default transform (position 0,0,
        // scale 1) the drawing lines up 1:1 with where the user actually drew.
        this.drawScratch = this.drawScratch || document.createElement('canvas');
        this.drawScratch.width = w;
        this.drawScratch.height = h;
        const dctx = this.drawScratch.getContext('2d');
        const reveal = KF.sample(clip, 'reveal', localTime, clip.draw && clip.draw.reveal != null ? clip.draw.reveal : 1);
        DrawEngine.renderStrokesToCanvas(dctx, clip.draw && clip.draw.strokes, reveal, w, h);

        let pipelineCanvas = this.drawScratch;
        pipelineCanvas = applyChromaKey(pipelineCanvas, clip.chromaKey, w, h);
        pipelineCanvas = applyStaticMask(pipelineCanvas, sampledMaskFor(clip, localTime), w, h);

        const state = this.transformStateFor(clip, localTime, w, h);
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, state.opacity));
        ctx.globalCompositeOperation = BLEND_MAP[clip.transform.blendMode] || 'source-over';
        ctx.translate(w / 2 + state.posX, h / 2 + state.posY);
        ctx.rotate((state.rotation || 0) * Math.PI / 180);
        ctx.drawImage(pipelineCanvas, -state.drawW / 2, -state.drawH / 2, state.drawW, state.drawH);
        ctx.restore();
        continue;
      }

      const media = project.media[clip.mediaId];
      if (!media) continue;

      const el = this.getMediaEl(media);
      this._syncMediaElement(el, media, clip, track, localTime, playing);
      playedMediaIds.add(media.id);
      if (media.type === 'audio') continue;

      const ready = (el.tagName === 'IMG') ? (el.complete && el.naturalWidth > 0) : el.readyState >= 2;
      if (!ready) continue;

      const srcW = el.naturalWidth || el.videoWidth || media.width || w;
      const srcH = el.naturalHeight || el.videoHeight || media.height || h;

      let pipelineCanvas;
      try {
        pipelineCanvas = this.pipelineFor(clip.id).render(el, clip.adjustments, srcW, srcH, time);
      } catch (e) { continue; }

      const targetFx = targetEffectsByClip.get(clip.id);
      if (targetFx) {
        for (const fx of targetFx) pipelineCanvas = applyEffectToCanvas(pipelineCanvas, fx, srcW, srcH);
      }
      pipelineCanvas = applyChromaKey(pipelineCanvas, clip.chromaKey, srcW, srcH);
      pipelineCanvas = applyStaticMask(pipelineCanvas, sampledMaskFor(clip, localTime), srcW, srcH);

      const state = this.transformStateFor(clip, localTime, srcW, srcH);
      const dur = project.clipDisplayDuration(clip);
      const mask = maskInfoFor(clip, localTime, dur);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, state.opacity));
      ctx.globalCompositeOperation = BLEND_MAP[clip.transform.blendMode] || 'source-over';
      ctx.translate(w / 2 + state.posX, h / 2 + state.posY);
      ctx.rotate((state.rotation || 0) * Math.PI / 180);
      applyMaskAndDraw(ctx, mask, () => {
        ctx.drawImage(pipelineCanvas, -state.drawW / 2, -state.drawH / 2, state.drawW, state.drawH);
      }, state.drawW, state.drawH);
      ctx.restore();
    }

    // Pause any video/audio elements that fell out of the active window.
    for (const [mediaId, el] of this.mediaElements) {
      if (!playedMediaIds.has(mediaId) && el.tagName === 'VIDEO' && !el.paused) el.pause();
    }
  }
}

window.PreviewEngine = PreviewEngine;
