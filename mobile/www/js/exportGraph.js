// OpenClips mobile - multi-track ffmpeg filter graph builder.
// Pure logic, no DOM/Capacitor access, so it can be loaded either in the
// WebView (attaches to window) or directly under plain Node for testing
// (module.exports) - mirrors the desktop app's src/main/exportGraph.js
// architecture (nullsrc base canvas, per-clip filter chain, overlay onto a
// running composite) adapted to mobile's simpler clip shape: no media
// registry (clips carry their own path/width/height), no keyframes (only
// static values), and animIn is reused as the "transition into this clip"
// mechanism instead of desktop's manual free-form overlap.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return clamp(v, 0, 1); }

function clipDuration(c) { return Math.max(0.05, c.outPoint - c.inPoint); }

function animCfg(clip, key) {
  const c = clip && clip[key];
  return (c && c.type) ? c : { type: 'none', duration: 0.5 };
}
function hasAnimType(clip, type) {
  return animCfg(clip, 'animIn').type === type || animCfg(clip, 'animOut').type === type;
}

// Per-frame factor expressions for entry/exit transitions. LT stands for
// "local clip time" (0 at this clip's own start) in whichever time variable
// the surrounding filter uses - lowercase t for most filters, uppercase T
// for geq. Mirrors desktop's exportGraph.js exactly, minus the keyframe
// (buildKeyframeExpr) plumbing mobile clips don't have.
function animOpacityFactorExpr(clip, dur, LT) {
  const inCfg = animCfg(clip, 'animIn'), outCfg = animCfg(clip, 'animOut');
  const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
  const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
  const parts = [];
  if (inCfg.type === 'fade') parts.push(`min(max((${LT})/${inD.toFixed(4)}\\,0)\\,1)`);
  if (outCfg.type === 'fade') parts.push(`min(max((${dur.toFixed(4)}-(${LT}))/${outD.toFixed(4)}\\,0)\\,1)`);
  return parts.length ? parts.map((p) => `(${p})`).join('*') : null;
}
function animScaleFactorExpr(clip, dur, LT) {
  const inCfg = animCfg(clip, 'animIn'), outCfg = animCfg(clip, 'animOut');
  const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
  const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
  const parts = [];
  if (inCfg.type === 'zoom') parts.push(`(0.7+0.3*min(max((${LT})/${inD.toFixed(4)}\\,0)\\,1))`);
  if (outCfg.type === 'zoom') parts.push(`(0.7+0.3*min(max((${dur.toFixed(4)}-(${LT}))/${outD.toFixed(4)}\\,0)\\,1))`);
  return parts.length ? parts.join('*') : null;
}
const MASK_ANIM_TYPES = new Set(['wipe', 'iris', 'dissolve', 'blinds', 'clock']);

function maskExprFor(type, pExpr) {
  if (type === 'wipe') return `if(lt(X\\,W*(${pExpr}))\\,1\\,0)`;
  if (type === 'iris') return `if(lt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2)\\,pow(hypot(W\\,H)/2*(${pExpr})\\,2))\\,1\\,0)`;
  if (type === 'dissolve') return `if(lt(abs(mod(sin(X*12.9898+Y*78.233)*43758.5453\\,1))\\,(${pExpr}))\\,1\\,0)`;
  if (type === 'blinds') {
    const stripes = 8;
    return `if(lt(mod(X\\,W/${stripes})\\,(W/${stripes})*(${pExpr}))\\,1\\,0)`;
  }
  if (type === 'clock') {
    const ang = `mod(atan2(X-W/2\\,-(Y-H/2))+2*PI\\,2*PI)`;
    return `if(lt(${ang}\\,2*PI*(${pExpr}))\\,1\\,0)`;
  }
  return '1';
}
function animMaskFactorExpr(clip, dur, LT) {
  const inCfg = animCfg(clip, 'animIn'), outCfg = animCfg(clip, 'animOut');
  const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
  const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
  const parts = [];
  if (MASK_ANIM_TYPES.has(inCfg.type)) {
    const inP = `min(max((${LT})/${inD.toFixed(4)}\\,0)\\,1)`;
    parts.push(maskExprFor(inCfg.type, inP));
  }
  if (MASK_ANIM_TYPES.has(outCfg.type)) {
    const outP = `min(max((${dur.toFixed(4)}-(${LT}))/${outD.toFixed(4)}\\,0)\\,1)`;
    parts.push(maskExprFor(outCfg.type, outP));
  }
  return parts.length ? parts.map((p) => `(${p})`).join('*') : null;
}
function animOffsetXExpr(clip, dur, LT, canvasW) {
  const inCfg = animCfg(clip, 'animIn'), outCfg = animCfg(clip, 'animOut');
  const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
  const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));
  const parts = [];
  if (inCfg.type === 'slide') parts.push(`(1-min(max((${LT})/${inD.toFixed(4)}\\,0)\\,1))*${canvasW}`);
  if (outCfg.type === 'slide') parts.push(`-(1-min(max((${dur.toFixed(4)}-(${LT}))/${outD.toFixed(4)}\\,0)\\,1))*${canvasW}`);
  return parts.length ? parts.join('+') : null;
}

// Static (non-animated - mobile has no keyframes) rect/ellipse/diamond/
// triangle/star mask, same math as desktop's staticMaskExpr minus the
// keyframe branch.
function staticMaskExpr(clip) {
  const m = clip.mask;
  if (!m || !m.type || m.type === 'none') return null;
  const cx = `W*${(m.posX == null ? 0.5 : m.posX).toFixed(4)}`;
  const cy = `H*${(m.posY == null ? 0.5 : m.posY).toFixed(4)}`;
  const rx = `W*${Math.max(0.01, m.sizeX == null ? 0.3 : m.sizeX).toFixed(4)}`;
  const ry = `H*${Math.max(0.01, m.sizeY == null ? 0.3 : m.sizeY).toFixed(4)}`;
  let inside;
  if (m.type === 'ellipse') {
    inside = `if(lt(((X-(${cx}))*(X-(${cx})))/((${rx})*(${rx}))+((Y-(${cy}))*(Y-(${cy})))/((${ry})*(${ry}))\\,1)\\,1\\,0)`;
  } else if (m.type === 'diamond') {
    inside = `if(lt(abs(X-(${cx}))/(${rx})+abs(Y-(${cy}))/(${ry})\\,1)\\,1\\,0)`;
  } else if (m.type === 'triangle') {
    const halfWidthAtY = `(${rx})*((Y-(${cy})+(${ry}))/(2*(${ry})))`;
    inside = `if(lt(Y\\,(${cy})+(${ry}))\\,if(lt(abs(X-(${cx}))\\,${halfWidthAtY})\\,1\\,0)\\,0)`;
  } else if (m.type === 'star') {
    const nx = `(X-(${cx}))/(${rx})`;
    const ny = `(Y-(${cy}))/(${ry})`;
    const theta = `atan2(${ny}\\,${nx})`;
    const dist = `hypot(${nx}\\,${ny})`;
    const thresh = `(0.725+0.275*cos(5*${theta}))`;
    inside = `if(lt(${dist}\\,${thresh})\\,1\\,0)`;
  } else {
    inside = `if(lt(abs(X-(${cx}))\\,${rx})\\,if(lt(abs(Y-(${cy}))\\,${ry})\\,1\\,0)\\,0)`;
  }
  return m.invert ? `(1-(${inside}))` : inside;
}

function convolutionFilter(kernel) {
  const k = kernel.join(' ');
  return `convolution=0m='${k}':1m='${k}':2m='${k}':3m='0 0 0 0 1 0 0 0 0'`;
}

// Green screen / chroma key - real alpha-producing chromakey filter (not the
// old RGB-distance darken-to-black hack) since multi-track means there is
// now genuinely something underneath to reveal.
function buildChromaKeyFilter(clip) {
  const ck = clip.chromaKey;
  if (!ck || !ck.enabled) return null;
  const color = (ck.color || '#00ff00').replace('#', '0x');
  const density = clamp(ck.density == null ? 50 : ck.density, 0, 100) / 100;
  const shadows = clamp(ck.shadows == null ? 50 : ck.shadows, 0, 100) / 100;
  const similarity = Math.max(0.00001, Math.min(1, 0.03 + density * 0.5)).toFixed(4);
  const blend = Math.max(0, Math.min(1, shadows * 0.6)).toFixed(4);
  return `chromakey=color=${color}:similarity=${similarity}:blend=${blend}`;
}

// Full desktop effect catalog (Effect tab parity).
function buildEffectFilters(clip) {
  const e = clip.effect || {};
  const amt = clamp(e.amount == null ? 50 : e.amount, 0, 100);
  const chain = [];
  switch (e.type) {
    case 'blur': {
      const sigma = (amt / 100) * 20;
      if (sigma > 0.05) chain.push(`gblur=sigma=${sigma.toFixed(2)}`);
      break;
    }
    case 'pixelate': {
      const block = Math.max(2, Math.round(2 + (amt / 100) * 46));
      chain.push(`pixelize=w=${block}:h=${block}`);
      break;
    }
    case 'bw': chain.push('eq=saturation=0'); break;
    case 'invert': chain.push('negate'); break;
    case 'mirror': chain.push('hflip'); break;
    case 'vflip': chain.push('vflip'); break;
    case 'sepia': {
      const t = amt / 100;
      const mix = (id, sepiaV) => (id + (sepiaV - id) * t).toFixed(4);
      chain.push(`colorchannelmixer=rr=${mix(1, 0.393)}:rg=${mix(0, 0.769)}:rb=${mix(0, 0.189)}:` +
        `gr=${mix(0, 0.349)}:gg=${mix(1, 0.686)}:gb=${mix(0, 0.168)}:` +
        `br=${mix(0, 0.272)}:bg=${mix(0, 0.534)}:bb=${mix(1, 0.131)}`);
      break;
    }
    case 'hueRotate': {
      const deg = (amt / 100) * 360;
      chain.push(`hue=h=${deg.toFixed(1)}`);
      break;
    }
    case 'vintage': chain.push('curves=preset=vintage'); break;
    case 'crossProcess': chain.push('curves=preset=cross_process'); break;
    case 'rgbSplit': {
      const shift = Math.round((amt / 100) * 20);
      chain.push(`rgbashift=rh=${-shift}:bh=${shift}`);
      break;
    }
    case 'edgeDetect': chain.push(convolutionFilter([-1, -1, -1, -1, 8, -1, -1, -1, -1])); break;
    case 'emboss': chain.push(convolutionFilter([-2, -1, 0, -1, 1, 1, 0, 1, 2])); break;
  }
  return chain;
}

// Full desktop Adjust tab parity (brightness/contrast/... through vignette).
function buildAdjustmentFilters(clip) {
  const adj = clip.adjustments || {};
  const chain = [];

  const brightness = (adj.brightness || 0) / 200;
  const exposureMul = Math.pow(2, (adj.exposure || 0) / 100);
  const contrast = 1 + (adj.contrast || 0) / 100;
  const saturation = 1 + (adj.saturation || 0) / 100;

  if (brightness || contrast !== 1 || saturation !== 1) {
    chain.push(`eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${Math.max(0, saturation).toFixed(4)}`);
  }
  if (exposureMul !== 1) {
    chain.push(`colorchannelmixer=rr=${exposureMul.toFixed(4)}:gg=${exposureMul.toFixed(4)}:bb=${exposureMul.toFixed(4)}`);
  }

  const shadows = (adj.shadows || 0) / 400;
  const highlights = (adj.highlights || 0) / 400;
  const blacks = (adj.blacks || 0) / 300;
  const whites = (adj.whites || 0) / 300;
  if (shadows || highlights || blacks || whites) {
    const p0 = clamp01(0 + blacks);
    const p1 = clamp01(0.25 + shadows * 0.7);
    const p3 = clamp01(0.75 + highlights * 0.7);
    const p4 = clamp01(1 + whites);
    chain.push(`curves=all='0/${p0.toFixed(3)} 0.25/${p1.toFixed(3)} 0.5/0.5 0.75/${p3.toFixed(3)} 1/${p4.toFixed(3)}'`);
  }

  if (adj.temperature || adj.tint) {
    const temp = clamp((adj.temperature || 0) * 30, -3000, 3000);
    chain.push(`colortemperature=temperature=${(6500 + temp).toFixed(0)}:mix=1:pl=1`);
    if (adj.tint) {
      const t = clamp(adj.tint, -100, 100) / 100;
      chain.push(`colorbalance=gs=${(-t * 0.4).toFixed(3)}:gm=${(-t * 0.4).toFixed(3)}:gh=${(-t * 0.4).toFixed(3)}:rs=${(t * 0.2).toFixed(3)}:bs=${(t * 0.2).toFixed(3)}`);
    }
  }

  if (adj.sharpen) {
    const amt = clamp(adj.sharpen, 0, 100) / 100 * 1.5;
    chain.push(`unsharp=5:5:${amt.toFixed(3)}:5:5:0.0`);
  }
  if (adj.clarity) {
    const amt = clamp(adj.clarity, 0, 100) / 100 * 1.2;
    chain.push(`unsharp=13:13:${amt.toFixed(3)}:13:13:0.0`);
  }
  if (adj.dehaze) {
    const d = clamp(adj.dehaze, 0, 100) / 100;
    chain.push(`eq=contrast=${(1 + d * 0.4).toFixed(3)}:saturation=${(1 + d * 0.3).toFixed(3)}`);
  }
  if (adj.grain) {
    const g = clamp(adj.grain, 0, 100) / 100 * 40;
    chain.push(`noise=alls=${g.toFixed(1)}:allf=t+u`);
  }
  if (adj.vignette) {
    const v = clamp(adj.vignette, 0, 100) / 100;
    const angle = (Math.PI / 2.2) * (1 - v * 0.75);
    chain.push(`vignette=angle=${angle.toFixed(4)}:mode=forward`);
  }

  return chain;
}

function ffmpegBlendMode(mode) {
  const map = {
    normal: 'normal', screen: 'screen', multiply: 'multiply', overlay: 'overlay',
    darken: 'darken', lighten: 'lighten', difference: 'difference', addition: 'addition',
  };
  return map[mode] || 'normal';
}

function escDrawtext(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, '’')
    .replace(/\r\n|\r|\n/g, ' ');
}

function db2lin(db) { return Math.pow(10, db / 20); }

// "Quality" is a resolution preset (Export Settings), not a compression
// tier - each maps to a target long-edge pixel count, scaled around the
// source clip's own aspect ratio (so a 480p export of a 9:16 clip is
// 480x854, not stretched to 16:9). libx264/yuv420p need even dimensions.
// Note picking 4K deliberately reintroduces the memory pressure that a
// lower cap here previously existed to avoid (a plausible cause of the
// originally-reported export crash) - that's an accepted tradeoff of
// exposing 4K as an explicit user choice rather than always capping it.
const RESOLUTION_LONG_EDGE = { '480p': 854, '720p': 1280, '1080p': 1920, '2k': 2560, '4k': 3840 };
const DEFAULT_CRF = 21;

function computeCanvasSize(tracks, quality) {
  let firstMedia = null;
  outer: for (const t of tracks) {
    for (const c of t.clips) {
      if (c.kind === 'media' && c.width && c.height) { firstMedia = c; break outer; }
    }
  }
  let W = (firstMedia && firstMedia.width) || 1080;
  let H = (firstMedia && firstMedia.height) || 1920;
  const targetLong = RESOLUTION_LONG_EDGE[quality] || RESOLUTION_LONG_EDGE['1080p'];
  const largest = Math.max(W, H);
  const scale = targetLong / largest;
  W = Math.max(2, Math.round((W * scale) / 2) * 2);
  H = Math.max(2, Math.round((H * scale) / 2) * 2);
  return { W, H };
}

// A bare filter with no options (negate, hflip) needs `=enable=` for its
// first option, not `:enable=`.
function gateFilter(f, enableExpr) {
  const sep = f.includes('=') ? ':' : '=';
  return `${f}${sep}enable='${enableExpr}'`;
}

function buildFilterGraph(state, outputPath) {
  // Muted means "hide this layer" (video and audio both), not merely
  // "silence its audio".
  const activeTracks = (state.tracks || []).filter((t) => !t.muted);
  const { W, H } = computeCanvasSize(activeTracks, state.exportSettings && state.exportSettings.quality);
  const fps = (state.exportSettings && state.exportSettings.framerate) || 30;

  let totalDuration = 0.01;
  for (const track of activeTracks) {
    for (const clip of track.clips) {
      totalDuration = Math.max(totalDuration, clip.startTime + clipDuration(clip));
    }
  }

  const args = [];
  const inputs = [];
  const inputIndexByPath = new Map();
  function resolveVideoInput(clip) {
    const isImage = clip.type === 'image';
    const key = isImage ? `img:${clip.id}` : `vid:${clip.path}`;
    if (inputIndexByPath.has(key)) return inputIndexByPath.get(key);
    const idx = inputs.length;
    if (isImage) {
      inputs.push(['-loop', '1', '-framerate', String(fps), '-t', clipDuration(clip).toFixed(3), '-i', clip.path]);
    } else {
      inputs.push(['-i', clip.path]);
    }
    inputIndexByPath.set(key, idx);
    return idx;
  }

  const filterLines = [];
  filterLines.push(`nullsrc=size=${W}x${H}:rate=${fps}:duration=${totalDuration.toFixed(3)},format=rgba[base0]`);
  let composite = 'base0';
  let stage = 0;
  let vCounter = 0;
  const audioLabels = [];
  let aCounter = 0;

  for (const track of activeTracks) {
    const clips = track.clips.slice().sort((a, b) => a.startTime - b.startTime);

    // Detect genuine time-overlaps within this track (created by the
    // transition auto-shift) so audio can be crossfaded across the overlap
    // window regardless of which video transition type produced it.
    const audioFade = new Map(); // clipId -> { outDur, inDur }
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i], b = clips[i + 1];
      const aEnd = a.startTime + clipDuration(a);
      const overlap = aEnd - b.startTime;
      if (overlap > 0.02) {
        const cur = audioFade.get(a.id) || {};
        cur.outDur = overlap;
        audioFade.set(a.id, cur);
        const curB = audioFade.get(b.id) || {};
        curB.inDur = overlap;
        audioFade.set(b.id, curB);
      }
    }

    for (const clip of clips) {
      if (clip.kind === 'text') {
        const dur = clipDuration(clip);
        const txt = escDrawtext(clip.text.content);
        const color = (clip.text.color || '#ffffff').replace('#', '0x');
        const fontSize = Math.round(H * 0.06);
        const fontPath = state.fontPath || '/system/fonts/Roboto-Regular.ttf';
        const vlabel = `v${vCounter++}`;
        // Transparent RGBA base (not desktop's libass/subtitles path, since
        // this ffmpeg build has drawtext, not libass) so the glyphs overlay
        // onto whatever is on tracks underneath instead of a black card.
        let chain = `nullsrc=size=${W}x${H}:rate=${fps}:duration=${dur.toFixed(3)},format=rgba,` +
          `drawtext=fontfile=${fontPath}:text='${txt}':fontcolor=${color}:fontsize=${fontSize}:` +
          `x=(w-text_w)/2:y=(h-text_h)/2`;
        const opacityAnimExpr = animOpacityFactorExpr(clip, dur, 't');
        if (opacityAnimExpr) chain += `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='alpha(X\\,Y)*(${opacityAnimExpr})'`;
        chain += `,setpts=PTS+${clip.startTime.toFixed(3)}/TB`;
        filterLines.push(`${chain}[${vlabel}]`);
        const enable = `between(t\\,${clip.startTime}\\,${(clip.startTime + dur).toFixed(3)})`;
        const next = `stage${++stage}`;
        filterLines.push(`[${composite}][${vlabel}]overlay=x=0:y=0:enable='${enable}'[${next}]`);
        composite = next;
        continue;
      }

      // clip.kind === 'media'
      const dur = clipDuration(clip);
      const idx = resolveVideoInput(clip);
      const isImage = clip.type === 'image';
      const vlabel = `v${vCounter++}`;

      const chain = [];
      if (isImage) {
        chain.push(`trim=duration=${dur.toFixed(3)}`);
      } else {
        chain.push(`trim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)}`);
        chain.push('setpts=PTS-STARTPTS');
      }
      chain.push('format=rgba');
      // Fit the clip's own frame to the canvas, letterboxing with a
      // TRANSPARENT pad (not opaque black) so an overlay clip's bars don't
      // blot out whatever is on the track(s) underneath.
      chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
      chain.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`);

      chain.push(...buildAdjustmentFilters(clip));

      const chromaKeyFilter = buildChromaKeyFilter(clip);
      if (chromaKeyFilter) {
        chain.push('format=rgba');
        chain.push(chromaKeyFilter);
      }

      chain.push(...buildEffectFilters(clip));

      const opacityAnimExpr = animOpacityFactorExpr(clip, dur, 'T');
      const maskAnimExpr = animMaskFactorExpr(clip, dur, 'T');
      const staticMaskExprVal = staticMaskExpr(clip);
      const baseOpacity = clip.opacity == null ? 1 : clip.opacity;
      if (opacityAnimExpr || maskAnimExpr || staticMaskExprVal || baseOpacity !== 1) {
        let expr = String(baseOpacity);
        if (opacityAnimExpr) expr = `(${expr})*(${opacityAnimExpr})`;
        if (maskAnimExpr) expr = `(${expr})*(${maskAnimExpr})`;
        if (staticMaskExprVal) expr = `(${expr})*(${staticMaskExprVal})`;
        chain.push('format=rgba');
        chain.push(`geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='alpha(X\\,Y)*(${expr})'`);
      }

      chain.push(`setpts=PTS+${clip.startTime.toFixed(3)}/TB`);

      filterLines.push(`[${idx}:v]${chain.join(',')}[${vlabel}]`);

      const enable = `between(t\\,${clip.startTime}\\,${(clip.startTime + dur).toFixed(3)})`;
      const blend = clip.blendMode || 'normal';
      const startExpr = `(t-${clip.startTime})`;
      const offXExpr = animOffsetXExpr(clip, dur, startExpr, W);
      const next = `stage${++stage}`;

      if (blend === 'normal' || offXExpr) {
        const x = offXExpr ? `(${offXExpr})` : '0';
        filterLines.push(`[${composite}][${vlabel}]overlay=x='${x}':y=0:enable='${enable}':eval=frame[${next}]`);
      } else {
        // ffmpeg's `blend` filter computes the merge formula (multiply,
        // screen, ...) at every pixel regardless of the top layer's alpha -
        // it is NOT alpha-aware like `overlay` is. Applied directly, a
        // masked/chroma-keyed/letterboxed clip's transparent pixels (RGB
        // 0,0,0 under the hood) would multiply the layer below down to
        // black instead of leaving it untouched. Fix: compute the blended
        // result as if the clip were fully opaque, then re-attach the
        // clip's real alpha and let `overlay` (which IS alpha-aware) do the
        // actual per-pixel mix against the untouched composite.
        const rgbLabel = `blendrgb${vCounter}`;
        const alphaLabel = `blenda${vCounter}`;
        const mergedLabel = `blendm${vCounter}`;
        const compA = `compa${vCounter}`, compB = `compb${vCounter}`;
        // `composite` is about to feed both the blend step and the final
        // overlay - a named pad can only be consumed once in ffmpeg's
        // filtergraph syntax, so it has to be split explicitly first.
        filterLines.push(`[${composite}]split=2[${compA}][${compB}]`);
        filterLines.push(`[${vlabel}]split=2[${rgbLabel}][${alphaLabel}src]`);
        filterLines.push(`[${alphaLabel}src]format=rgba,alphaextract[${alphaLabel}]`);
        filterLines.push(`[${compA}][${rgbLabel}]blend=all_mode=${ffmpegBlendMode(blend)}[${mergedLabel}]`);
        filterLines.push(`[${mergedLabel}][${alphaLabel}]alphamerge[${mergedLabel}a]`);
        filterLines.push(`[${compB}][${mergedLabel}a]overlay=x=0:y=0:enable='${enable}'[${next}]`);
      }
      composite = next;

      // audio
      if (!isImage) {
        const aChain = [`atrim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];
        if (clip.volume) aChain.push(`volume=${db2lin(clip.volume).toFixed(4)}`);
        const fade = audioFade.get(clip.id);
        if (fade && fade.inDur) aChain.push(`afade=t=in:st=0:d=${fade.inDur.toFixed(3)}`);
        if (fade && fade.outDur) aChain.push(`afade=t=out:st=${Math.max(0, dur - fade.outDur).toFixed(3)}:d=${fade.outDur.toFixed(3)}`);
        const delayMs = Math.round(clip.startTime * 1000);
        aChain.push(`adelay=${delayMs}|${delayMs}`);
        const alabel = `a${aCounter++}`;
        filterLines.push(`[${idx}:a]${aChain.join(',')}[${alabel}]`);
        audioLabels.push(alabel);
      }
    }
  }

  filterLines.push(`[${composite}]format=yuv420p,fps=${fps}[outv]`);

  let audioMap;
  if (audioLabels.length > 0) {
    filterLines.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[outa]`);
    audioMap = 'outa';
  } else {
    filterLines.push(`anullsrc=channel_layout=stereo:sample_rate=48000[outa]`);
    audioMap = 'outa';
  }

  for (const inp of inputs) args.push(...inp);
  args.push('-filter_complex', filterLines.join(';'));
  args.push('-map', '[outv]', '-map', `[${audioMap}]`);
  args.push('-t', totalDuration.toFixed(3));

  const exportSettings = state.exportSettings || {};
  if (exportSettings.bitrateKbps) {
    const kbps = exportSettings.bitrateKbps;
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(DEFAULT_CRF), '-pix_fmt', 'yuv420p');
  }
  args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-y', outputPath);

  return { args, totalDuration, width: W, height: H };
}

// Pure helper (no ffmpeg/DOM involvement) - applies or clears an entry
// transition on a clip, auto-overlapping it with its same-track predecessor
// (only when they were already touching) and remembering exactly how much
// it shifted so switching back to 'none' restores the original position.
function setClipTransition(track, clipId, type, duration) {
  const clips = track.clips.slice().sort((a, b) => a.startTime - b.startTime);
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;
  const prevShift = clip._transitionShiftApplied || 0;
  clip.startTime = +(clip.startTime + prevShift).toFixed(4);
  clip._transitionShiftApplied = 0;
  clip.animIn = { type: type || 'none', duration: duration || 0.6 };
  if (type && type !== 'none') {
    const idx = clips.indexOf(clip);
    const predecessor = idx > 0 ? clips[idx - 1] : null;
    if (predecessor) {
      const predEnd = predecessor.startTime + clipDuration(predecessor);
      if (Math.abs(clip.startTime - predEnd) < 0.75) {
        const d = Math.max(0.05, Math.min(duration || 0.6, clipDuration(clip) * 0.8, clipDuration(predecessor) * 0.8));
        const newStart = Math.max(0, predEnd - d);
        clip._transitionShiftApplied = +(clip.startTime - newStart).toFixed(4);
        clip.startTime = +newStart.toFixed(4);
        clip.animIn.duration = d;
      }
    }
  }
}

const TRANSITION_TYPES = [
  ['none', 'None', '∅'],
  ['fade', 'Fade', '◐'],
  ['wipe', 'Wipe', '▶'],
  ['iris', 'Iris', '◎'],
  ['dissolve', 'Dissolve', '░'],
  ['blinds', 'Blinds', '☷'],
  ['clock', 'Clock', '◔'],
  ['slide', 'Slide', '→'],
  ['zoom', 'Zoom', '⊕'],
];

const EFFECT_TYPES = [
  ['none', 'None', '∅'],
  ['blur', 'Blur', '◌'],
  ['pixelate', 'Pixelate', '▦'],
  ['bw', 'B & W', '◑'],
  ['invert', 'Invert', '◒'],
  ['mirror', 'Mirror', '⇄'],
  ['vflip', 'Flip', '⇅'],
  ['sepia', 'Sepia', '◓'],
  ['hueRotate', 'Hue', '◯'],
  ['vintage', 'Vintage', '▤'],
  ['crossProcess', 'Cross Process', '▥'],
  ['rgbSplit', 'RGB Split', '▧'],
  ['edgeDetect', 'Edge Detect', '▣'],
  ['emboss', 'Emboss', '▨'],
];

const ADJUSTMENT_FIELDS = [
  ['brightness', 'Brightness', -100, 100],
  ['exposure', 'Exposure', -100, 100],
  ['contrast', 'Contrast', -100, 100],
  ['saturation', 'Saturation', -100, 100],
  ['highlights', 'Highlights', -100, 100],
  ['shadows', 'Shadows', -100, 100],
  ['whites', 'Whites', -100, 100],
  ['blacks', 'Blacks', -100, 100],
  ['temperature', 'Temperature', -100, 100],
  ['tint', 'Tint', -100, 100],
  ['sharpen', 'Sharpen', 0, 100],
  ['clarity', 'Clarity', 0, 100],
  ['dehaze', 'Dehaze', 0, 100],
  ['grain', 'Grain', 0, 100],
  ['vignette', 'Vignette', 0, 100],
];

const MASK_SHAPES = [['none', 'None'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['diamond', 'Diamond'], ['triangle', 'Triangle'], ['star', 'Star']];
const BLEND_MODES = [['normal', 'Normal'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['difference', 'Difference'], ['addition', 'Addition']];

const api = {
  buildFilterGraph, setClipTransition, clipDuration, computeCanvasSize,
  TRANSITION_TYPES, EFFECT_TYPES, ADJUSTMENT_FIELDS, MASK_SHAPES, BLEND_MODES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.OpenClipsExportGraph = api;
