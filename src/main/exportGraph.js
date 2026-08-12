const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ffmpegPath } = require('./ffmpegEngine');

let currentProc = null;

function esc(v) {
  // Escape a literal value for use inside an ffmpeg filter expression
  // (commas and colons are argument separators in the filtergraph string).
  return String(v).replace(/,/g, '\\,').replace(/:/g, '\\:');
}

// Build a piecewise-linear ffmpeg time expression from sorted keyframes.
// timeVar is the ffmpeg expression string standing in for "seconds since this
// chain's own PTS origin" (either "t" for a clip-local chain, or "(t-START)"
// for expressions evaluated on the global composite timeline).
function buildKeyframeExpr(keyframes, staticDefault, timeVar) {
  if (!keyframes || keyframes.length === 0) return String(staticDefault);
  const sorted = [...keyframes].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 1) return String(sorted[0].value);

  let expr = String(sorted[sorted.length - 1].value);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const dur = Math.max(1e-6, b.timestamp - a.timestamp);
    const p = `min(max((${timeVar}-${a.timestamp})/${dur}\\,0)\\,1)`;
    const seg = `(${a.value}+(${b.value - a.value})*${p})`;
    expr = `if(lt(${timeVar}\\,${b.timestamp})\\,${seg}\\,${expr})`;
  }
  expr = `if(lt(${timeVar}\\,${sorted[0].timestamp})\\,${sorted[0].value}\\,${expr})`;
  return expr;
}

function animCfg(clip, key) {
  const c = clip && clip[key];
  return (c && c.type) ? c : { type: 'none', duration: 0.5 };
}
function hasAnimType(clip, type) {
  return animCfg(clip, 'animIn').type === type || animCfg(clip, 'animOut').type === type;
}
// Mirrors preview.js's computeAnimAdjust, but as ffmpeg per-frame expression
// strings instead of numbers. LT is an ffmpeg expression standing in for
// clip-local time (0 at clip start) in whatever variable the surrounding
// filter uses (lowercase t for most filters, uppercase T for geq, or
// "(t-startTime)" when evaluated on the global overlay timeline). Returns
// null when the given effect type isn't used by either animIn or animOut, so
// callers can skip the per-frame expression path entirely when nothing to do.
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

// Per-pixel geq alpha masks for the transition types that genuinely need
// spatial masking rather than a plain scalar ramp - these are the ones a
// user couldn't reproduce by hand with ordinary position/scale/opacity
// keyframes. X/Y/W/H are geq's own builtins (current pixel + current frame
// size), so this needs no canvas-dimension plumbing from the caller.
function maskExprFor(type, pExpr) {
  if (type === 'wipe') return `if(lt(X\\,W*(${pExpr}))\\,1\\,0)`;
  if (type === 'iris') return `if(lt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2)\\,pow(hypot(W\\,H)/2*(${pExpr})\\,2))\\,1\\,0)`;
  // Classic shader pseudo-random hash (sin of a linear combo of the
  // coordinates, scaled and fractional-ed) rather than a linear/modular
  // block pattern - the latter reads as regular diagonal stripes instead of
  // the scattered "noise" a dissolve is supposed to look like.
  if (type === 'dissolve') return `if(lt(abs(mod(sin(X*12.9898+Y*78.233)*43758.5453\\,1))\\,(${pExpr}))\\,1\\,0)`;
  if (type === 'blinds') {
    const stripes = 8;
    return `if(lt(mod(X\\,W/${stripes})\\,(W/${stripes})*(${pExpr}))\\,1\\,0)`;
  }
  if (type === 'clock') {
    // Angle convention matches the on-canvas rotate handle (canvasOverlay.js):
    // atan2(dx,-dy) puts 0 at 12 o'clock, increasing clockwise.
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

// Static (non-animated) clip mask - rect/ellipse crop of a clip's own frame,
// media clips only. Unlike the transition masks above this has no time
// component, just a fixed shape from clip.mask. Reuses the same geq
// per-pixel alpha mechanism, multiplying in alongside opacity/transition
// masks in the same expression.
// Mask position/size are keyframeable (Mask & Blend tab), same as opacity -
// buildKeyframeExpr against 'T' when animated, otherwise a plain number.
function maskPropExpr(clip, property, staticDefault) {
  return isAnimated(clip, property)
    ? buildKeyframeExpr(kfFor(clip, property), staticDefault, 'T')
    : String(staticDefault);
}

function staticMaskExpr(clip) {
  const m = clip.mask;
  if (!m || !m.type || m.type === 'none') return null;
  const cx = `W*(${maskPropExpr(clip, 'mask_posX', m.posX == null ? 0.5 : m.posX)})`;
  const cy = `H*(${maskPropExpr(clip, 'mask_posY', m.posY == null ? 0.5 : m.posY)})`;
  const rx = `W*(${maskPropExpr(clip, 'mask_sizeX', Math.max(0.01, m.sizeX == null ? 0.3 : m.sizeX))})`;
  const ry = `H*(${maskPropExpr(clip, 'mask_sizeY', Math.max(0.01, m.sizeY == null ? 0.3 : m.sizeY))})`;
  let inside;
  if (m.type === 'ellipse') {
    inside = `if(lt(((X-(${cx}))*(X-(${cx})))/((${rx})*(${rx}))+((Y-(${cy}))*(Y-(${cy})))/((${ry})*(${ry}))\\,1)\\,1\\,0)`;
  } else if (m.type === 'diamond') {
    // Rhombus: L1 (taxicab) distance in normalized space <= 1.
    inside = `if(lt(abs(X-(${cx}))/(${rx})+abs(Y-(${cy}))/(${ry})\\,1)\\,1\\,0)`;
  } else if (m.type === 'triangle') {
    // Isoceles triangle, apex at top: at height Y the left/right edges are
    // linear ramps from the apex out to the base corners, so "inside" is
    // just a width-at-this-height check plus staying above the base.
    const halfWidthAtY = `(${rx})*((Y-(${cy})+(${ry}))/(2*(${ry})))`;
    inside = `if(lt(Y\\,(${cy})+(${ry}))\\,if(lt(abs(X-(${cx}))\\,${halfWidthAtY})\\,1\\,0)\\,0)`;
  } else if (m.type === 'star') {
    // 5-lobed star via polar radius modulation: threshold(theta) oscillates
    // between an inner and outer radius every 2*PI/5 - a closed-form
    // approximation of a 5-point star rather than an exact polygon, which
    // would need a much longer expression to test against 10 edges.
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

// clip.kind:'effect' filter chain. Uses iw/ih (ffmpeg's "current input
// width/height" builtins) instead of literal numbers so the exact same
// chain works whether it's gated onto the full composite (adjustment-layer
// style, "All Clips Below") or spliced into one specific target clip's own
// chain (where the frame is that clip's own post-scale size).
// convolution's per-plane matrix values (0m/1m/2m/3m for R/G/B/A once the
// chain is already in rgba) need single-quoting since they contain spaces,
// matching how curves=all='...' is already quoted elsewhere in this file.
function convolutionFilter(kernel) {
  const k = kernel.join(' ');
  return `convolution=0m='${k}':1m='${k}':2m='${k}':3m='0 0 0 0 1 0 0 0 0'`;
}

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
      // Chained scale-down/scale-up (the usual pixelation trick) doesn't
      // work here: ffmpeg's scale filter has no timeline/enable support at
      // all in this build, so it can't be time-gated. pixelize is a
      // dedicated filter for exactly this and does support enable.
      const block = Math.max(2, Math.round(2 + (amt / 100) * 46));
      chain.push(`pixelize=w=${block}:h=${block}`);
      break;
    }
    case 'bw':
      chain.push('eq=saturation=0');
      break;
    case 'invert':
      chain.push('negate');
      break;
    case 'mirror':
      chain.push('hflip');
      break;
    case 'vflip':
      chain.push('vflip');
      break;
    case 'sepia': {
      // Amount blends between identity and the classic sepia matrix rather
      // than being all-or-nothing.
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
    case 'vintage':
      chain.push('curves=preset=vintage');
      break;
    case 'crossProcess':
      chain.push('curves=preset=cross_process');
      break;
    case 'rgbSplit': {
      const shift = Math.round((amt / 100) * 20);
      chain.push(`rgbashift=rh=${-shift}:bh=${shift}`);
      break;
    }
    case 'edgeDetect':
      chain.push(convolutionFilter([-1, -1, -1, -1, 8, -1, -1, -1, -1]));
      break;
    case 'emboss':
      chain.push(convolutionFilter([-2, -1, 0, -1, 1, 1, 0, 1, 2]));
      break;
  }
  return chain;
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

// A bare filter with no options of its own (negate, hflip) needs `=enable=`
// for its first option, not `:enable=` - `:` only works to ADD an option
// after one that's already there (e.g. eq=saturation=0:enable=...).
function gateFilter(f, enableExpr) {
  const sep = f.includes('=') ? ':' : '=';
  return `${f}${sep}enable='${enableExpr}'`;
}

function kfFor(clip, property) {
  return (clip.keyframes || []).filter((k) => k.property === property);
}

function isAnimated(clip, property) {
  return kfFor(clip, property).length > 0;
}

function clipDisplayDuration(clip) {
  const mult = (clip.speed && clip.speed.multiplier) || 1;
  return Math.max(0, (clip.outPoint - clip.inPoint) / mult);
}

function db2lin(db) {
  return Math.pow(10, db / 20);
}

// ---- video adjustment filter chain (works on a clip-local stream, t in [0, displayDuration)) ----
function buildAdjustmentFilters(clip) {
  const adj = clip.adjustments || {};
  const chain = [];

  const brightness = (adj.brightness || 0) / 200; // eq brightness in [-1,1]
  const exposureMul = Math.pow(2, (adj.exposure || 0) / 100);
  const contrast = 1 + (adj.contrast || 0) / 100;
  const saturation = 1 + ((adj.saturation || 0) + (adj.vibrance || 0) * 0.6) / 100;

  if (brightness || contrast !== 1 || saturation !== 1) {
    chain.push(`eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${Math.max(0, saturation).toFixed(4)}`);
  }
  if (exposureMul !== 1) {
    chain.push(`colorchannelmixer=rr=${exposureMul.toFixed(4)}:gg=${exposureMul.toFixed(4)}:bb=${exposureMul.toFixed(4)}`);
  }

  // Highlights / shadows / whites / blacks approximated as a tone curve
  // through five control points (shadow, 1/3, mid, 2/3, highlight, white).
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return clamp(v, 0, 1); }

// ---- text clips, rendered via libass ("subtitles" filter) since this ffmpeg
// build has no drawtext. One .ass file covers every text clip in the
// project; text always composites above every media/adjustment clip. ----
function assTimestamp(seconds) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.min(99, Math.round((seconds - Math.floor(seconds)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function escAssText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r\n|\r|\n/g, '\\N');
}
function hexToAssColor(hex) {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length < 6) hex = 'ffffff';
  const r = hex.slice(0, 2), g = hex.slice(2, 4), b = hex.slice(4, 6);
  return `&H${(b + g + r).toUpperCase()}&`;
}
function hexToAssColorWithAlpha(hex, opacity) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length < 6) hex = '000000';
  const r = hex.slice(0, 2), g = hex.slice(2, 4), b = hex.slice(4, 6);
  const alphaHex = Math.round((1 - clamp01(opacity == null ? 1 : opacity)) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `&H${alphaHex}${(b + g + r).toUpperCase()}&`;
}
function assAlignFromAlign(align) {
  if (align === 'left') return 4;
  if (align === 'right') return 6;
  return 5;
}

function buildAssFile(textClips, W, H) {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];

  // BorderStyle (plain vs opaque-box) can only be set per named [V4+ Styles]
  // entry, not via an inline override tag, so each text clip gets its own
  // style - libass fills the box using OutlineColour (not BackColour) when
  // BorderStyle=3, confirmed empirically since that's undocumented behavior.
  const styleNames = textClips.map((clip, i) => {
    const t = clip.text || {};
    const an = assAlignFromAlign(t.align);
    const name = `S${i}`;
    if (t.bgEnabled) {
      const fontSizeForPad = Math.max(4, Math.round((t.fontSize || 64) * (clip.transform.scale || 1)));
      const pad = Math.max(2, Math.round(fontSizeForPad * 0.18));
      const boxColor = hexToAssColorWithAlpha(t.bgColor, t.bgOpacity == null ? 0.6 : t.bgOpacity);
      lines.push(`Style: ${name},Sans,64,&H00FFFFFF,&H000000FF,${boxColor},&H00000000,0,0,0,0,100,100,0,0,3,${pad},0,${an},10,10,10,1`);
    } else {
      lines.push(`Style: ${name},Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,${an},10,10,10,1`);
    }
    return name;
  });

  lines.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  textClips.forEach((clip, i) => {
    const t = clip.text || {};
    const dur = clipDisplayDuration(clip);
    const posX = W / 2 + (clip.transform.positionX || 0);
    const posY = H / 2 + (clip.transform.positionY || 0);
    const fontSize = Math.max(4, Math.round((t.fontSize || 64) * (clip.transform.scale || 1)));
    const color = hexToAssColor(t.color);
    const opacity = clip.transform.opacity == null ? 1 : clip.transform.opacity;
    const alphaHex = Math.round((1 - clamp01(opacity)) * 255).toString(16).padStart(2, '0').toUpperCase();
    const rot = -(clip.transform.rotation || 0);
    const an = assAlignFromAlign(t.align);
    const fontName = (t.fontFamily || 'Sans').replace(/[\\{}]/g, '');

    // Text animIn/animOut translated to native ASS override tags rather than
    // per-frame ffmpeg expressions (libass renders this file once, not
    // per-clip filter chains). \move replaces \pos outright, so only one of
    // the two directions can drive position - animIn wins if both are slide.
    const inCfg = animCfg(clip, 'animIn');
    const outCfg = animCfg(clip, 'animOut');
    const inD = Math.max(0.01, Math.min(inCfg.duration || 0.5, dur));
    const outD = Math.max(0.01, Math.min(outCfg.duration || 0.5, dur));

    let posTag = `\\pos(${posX.toFixed(1)},${posY.toFixed(1)})`;
    if (inCfg.type === 'slide') {
      posTag = `\\move(${(posX + W).toFixed(1)},${posY.toFixed(1)},${posX.toFixed(1)},${posY.toFixed(1)},0,${Math.round(inD * 1000)})`;
    } else if (outCfg.type === 'slide') {
      const outStartMs = Math.round((dur - outD) * 1000);
      posTag = `\\move(${posX.toFixed(1)},${posY.toFixed(1)},${(posX - W).toFixed(1)},${posY.toFixed(1)},${outStartMs},${Math.round(dur * 1000)})`;
    }

    let fadTag = '';
    const fadInMs = inCfg.type === 'fade' ? Math.round(inD * 1000) : 0;
    const fadOutMs = outCfg.type === 'fade' ? Math.round(outD * 1000) : 0;
    if (fadInMs || fadOutMs) fadTag = `\\fad(${fadInMs},${fadOutMs})`;

    let zoomTag = '';
    if (inCfg.type === 'zoom') zoomTag += `\\fscx70\\fscy70\\t(0,${Math.round(inD * 1000)},\\fscx100\\fscy100)`;
    if (outCfg.type === 'zoom') zoomTag += `\\t(${Math.round((dur - outD) * 1000)},${Math.round(dur * 1000)},\\fscx70\\fscy70)`;

    // \1a (primary-only alpha) rather than the blanket \alpha, so a faded
    // clip doesn't also fade the box - the box's own opacity is baked into
    // its style's OutlineColour above and should stay independent.
    const override = `{${posTag}\\an${an}\\fn${fontName}\\fs${fontSize}\\1c${color}\\1a&H${alphaHex}&\\frz${rot.toFixed(1)}${fadTag}${zoomTag}}`;
    lines.push(`Dialogue: 0,${assTimestamp(clip.startTime)},${assTimestamp(clip.startTime + dur)},${styleNames[i]},,0,0,0,,${override}${escAssText(t.content)}`);
  });

  const assPath = path.join(os.tmpdir(), `openclips-export-${Date.now()}-${Math.random().toString(36).slice(2)}.ass`);
  fs.writeFileSync(assPath, lines.join('\n'), 'utf-8');
  return assPath;
}

function buildFilterGraph(project, outputPath) {
  const media = project.media || {};
  const tracks = project.timeline.tracks || [];
  const W = (project.canvas && project.canvas.width) || 1920;
  const H = (project.canvas && project.canvas.height) || 1080;
  const FPS = (project.canvas && project.canvas.fps) || 30;

  let totalDuration = 0.01;
  for (const track of tracks) {
    for (const clip of track.clips || []) {
      totalDuration = Math.max(totalDuration, clip.startTime + clipDisplayDuration(clip));
    }
  }

  const inputs = [];
  const inputIndexByKey = new Map();
  // Timeline trim handles now let a clip's outPoint run past the source's
  // real duration (image = no cap; video/audio = loops). A shared input
  // stays keyed by media id so multiple normal-length clips reuse one
  // decode, but a still image or a looping clip each need their own
  // dedicated input (-loop/-stream_loop is a property of the whole input,
  // not per-clip) so they don't affect other clips using the same file.
  function resolveInput(mediaItem, clip) {
    const isImage = mediaItem.type === 'image';
    const looping = !isImage && clip.outPoint > mediaItem.duration + 0.01;
    const key = (isImage || looping) ? `${mediaItem.id}:${clip.id}` : mediaItem.id;
    if (inputIndexByKey.has(key)) return inputIndexByKey.get(key);
    const idx = inputs.length;
    if (isImage) {
      inputs.push({ args: ['-loop', '1', '-framerate', String(FPS), '-t', clipDisplayDuration(clip).toFixed(3), '-i', mediaItem.path] });
    } else if (looping) {
      inputs.push({ args: ['-stream_loop', '-1', '-i', mediaItem.path] });
    } else {
      inputs.push({ args: ['-i', mediaItem.path] });
    }
    inputIndexByKey.set(key, idx);
    return idx;
  }

  const filterLines = [];
  let vLabelCounter = 0;
  let aLabelCounter = 0;

  filterLines.push(`nullsrc=size=${W}x${H}:rate=${FPS}:duration=${totalDuration.toFixed(3)},format=rgba[base0]`);
  let composite = 'base0';
  let compositeStage = 0;

  const audioLabels = [];
  const textClips = [];

  // Effect clips scoped to specific target clips are spliced into those
  // target clips' own per-clip chain (below), not applied at the effect
  // clip's own position in the track loop, so build that lookup up front.
  const targetedEffectsByClipId = new Map();
  for (const track of tracks) {
    for (const clip of track.clips || []) {
      if (clip.kind === 'effect' && clip.effectTargets && clip.effectTargets.length > 0) {
        for (const tid of clip.effectTargets) {
          if (!targetedEffectsByClipId.has(tid)) targetedEffectsByClipId.set(tid, []);
          targetedEffectsByClipId.get(tid).push(clip);
        }
      }
    }
  }

  for (const track of tracks) {
    for (const clip of track.clips || []) {
      if (clip.kind === 'text') {
        if (!track.muted) textClips.push(clip);
        continue;
      }

      if (clip.kind === 'adjustment') {
        const filters = buildAdjustmentFilters(clip);
        if (filters.length === 0) continue;
        const gated = filters.map((f) => gateFilter(f, `between(t\\,${clip.startTime}\\,${clip.startTime + clipDisplayDuration(clip)})`));
        const next = `stage${++compositeStage}`;
        filterLines.push(`[${composite}]${gated.join(',')}[${next}]`);
        composite = next;
        continue;
      }

      if (clip.kind === 'effect') {
        // Targeted (effectTargets non-empty) contributes nothing here - it's
        // picked up below when its target clip builds its own chain. Only a
        // global effect (no targets) acts like an adjustment layer.
        if (clip.effectTargets && clip.effectTargets.length > 0) continue;
        const filters = buildEffectFilters(clip);
        if (filters.length === 0) continue;
        const gated = filters.map((f) => gateFilter(f, `between(t\\,${clip.startTime}\\,${clip.startTime + clipDisplayDuration(clip)})`));
        const next = `stage${++compositeStage}`;
        filterLines.push(`[${composite}]${gated.join(',')}[${next}]`);
        composite = next;
        continue;
      }

      // clip.kind === 'media': contributes video and/or audio, whichever the file has.
      const m = media[clip.mediaId];
      if (!m || track.muted) continue;

      if (m.hasAudio) {
        const audioIdx = resolveInput(m, clip);
        const label = buildAudioClipChain(clip, m, audioIdx, filterLines, () => aLabelCounter++);
        if (label) audioLabels.push(label);
      }

      const isImage = m.type === 'image';
      if (!m.hasVideo && !isImage) continue;

      const idx = resolveInput(m, clip);
      const dur = clipDisplayDuration(clip);
      const mult = (clip.speed && clip.speed.multiplier) || 1;
      const vlabel = `v${vLabelCounter++}`;

      const chain = [];
      if (isImage) {
        chain.push(`trim=duration=${dur.toFixed(3)}`);
      } else {
        chain.push(`trim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)}`);
        chain.push(`setpts=(PTS-STARTPTS)/${mult}`);
      }
      chain.push('format=rgba');

      // scale (supports keyframed scale via eval=frame expression in local clip time)
      const baseW = m.width || W;
      const baseH = m.height || H;
      const scaleAnimExpr = animScaleFactorExpr(clip, dur, 't');
      if (isAnimated(clip, 'scale') || scaleAnimExpr) {
        const baseExpr = isAnimated(clip, 'scale')
          ? buildKeyframeExpr(kfFor(clip, 'scale'), clip.transform.scale, 't')
          : String(clip.transform.scale || 1);
        const expr = scaleAnimExpr ? `(${baseExpr})*(${scaleAnimExpr})` : baseExpr;
        chain.push(`scale=w='${baseW}*(${expr})':h='${baseH}*(${expr})':eval=frame`);
      } else {
        const s = clip.transform.scale || 1;
        chain.push(`scale=${Math.max(2, Math.round(baseW * s))}:${Math.max(2, Math.round(baseH * s))}`);
      }

      // rotation. ow/oh use a fixed hypot(iw,ih) bounding box (not rotw/roth of
      // the angle) because ffmpeg requires a constant frame size per stream —
      // rotw/roth would resize every frame when the angle is animated.
      if (isAnimated(clip, 'rotation') || clip.transform.rotation) {
        const expr = isAnimated(clip, 'rotation')
          ? buildKeyframeExpr(kfFor(clip, 'rotation'), clip.transform.rotation, 't')
          : String(clip.transform.rotation || 0);
        chain.push(`rotate=a='(${expr})*PI/180':ow=hypot(iw\\,ih):oh=hypot(iw\\,ih):c=none`);
        chain.push('format=rgba');
      }

      // color adjustments
      chain.push(...buildAdjustmentFilters(clip));

      // effect clips scoped to this specific clip (blur/pixelate/etc.),
      // gated to the overlap between the effect clip's window and this
      // clip's own - converted to this chain's local time since that's what
      // `enable` sees here (this chain hasn't been shifted to global time
      // yet, see the setpts shift below).
      const targetedFx = targetedEffectsByClipId.get(clip.id) || [];
      for (const fxClip of targetedFx) {
        const fxFilters = buildEffectFilters(fxClip);
        if (fxFilters.length === 0) continue;
        const fxDur = clipDisplayDuration(fxClip);
        const localStart = Math.max(0, fxClip.startTime - clip.startTime);
        const localEnd = Math.min(dur, fxClip.startTime + fxDur - clip.startTime);
        if (localEnd <= localStart) continue;
        chain.push(...fxFilters.map((f) => gateFilter(f, `between(t\\,${localStart.toFixed(3)}\\,${localEnd.toFixed(3)})`)));
      }

      // opacity (alpha multiply) and transition masks (wipe/iris/dissolve).
      // colorchannelmixer's aa only accepts a constant, so animated opacity
      // goes through geq instead (note: geq's time variable is uppercase T,
      // unlike every other filter's lowercase t).
      const opacityAnimExpr = animOpacityFactorExpr(clip, dur, 'T');
      const maskAnimExpr = animMaskFactorExpr(clip, dur, 'T');
      const staticMaskExprVal = staticMaskExpr(clip);
      if (isAnimated(clip, 'opacity') || opacityAnimExpr || maskAnimExpr || staticMaskExprVal) {
        // format=rgba is required immediately before geq: eq/colortemperature/
        // vignette can silently drop the alpha plane, and geq then negotiates
        // an alpha-less output format and ignores the `a=` expression entirely.
        const baseExpr = isAnimated(clip, 'opacity')
          ? buildKeyframeExpr(kfFor(clip, 'opacity'), clip.transform.opacity, 'T')
          : String(clip.transform.opacity == null ? 1 : clip.transform.opacity);
        let expr = baseExpr;
        if (opacityAnimExpr) expr = `(${expr})*(${opacityAnimExpr})`;
        if (maskAnimExpr) expr = `(${expr})*(${maskAnimExpr})`;
        if (staticMaskExprVal) expr = `(${expr})*(${staticMaskExprVal})`;
        chain.push('format=rgba');
        chain.push(`geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='alpha(X\\,Y)*(${expr})'`);
      } else if (clip.transform.opacity !== 1 && clip.transform.opacity !== undefined) {
        chain.push(`colorchannelmixer=aa=${clip.transform.opacity}`);
      }

      // Every filter above (scale/rotate/opacity) reads its own t/T from this
      // chain's PTS, which setpts reset to start at 0 - i.e. clip-local time,
      // matching how their expressions are written. But overlay pairs frames
      // between this stream and the running composite by matching PTS against
      // the composite's GLOBAL timeline, so without this shift, overlay would
      // pick whichever of this stream's frames happens to carry a PTS equal to
      // the current global time - e.g. for a clip starting at t=3, overlay
      // would grab this stream's OWN 3-second mark (already 3s into its local
      // animations) the instant it first becomes visible, instead of its
      // local t=0 frame. Shifting PTS forward by startTime now (after all the
      // local-time-based effects are already baked in) fixes that pairing for
      // any clip that doesn't start at t=0.
      chain.push(`setpts=PTS+${clip.startTime.toFixed(3)}/TB`);

      filterLines.push(`[${idx}:v]${chain.join(',')}[${vlabel}]`);

      // position -> overlay onto running composite (global timeline time)
      const startExpr = `(t-${clip.startTime})`;
      const baseXExpr = isAnimated(clip, 'positionX')
        ? buildKeyframeExpr(kfFor(clip, 'positionX'), clip.transform.positionX, startExpr)
        : String(clip.transform.positionX || 0);
      const yExpr = isAnimated(clip, 'positionY')
        ? buildKeyframeExpr(kfFor(clip, 'positionY'), clip.transform.positionY, startExpr)
        : String(clip.transform.positionY || 0);
      const offXExpr = animOffsetXExpr(clip, dur, startExpr, W);
      const xExpr = offXExpr ? `(${baseXExpr})+(${offXExpr})` : baseXExpr;

      const x = `(main_w-w)/2+(${xExpr})`;
      const y = `(main_h-h)/2+(${yExpr})`;
      const enable = `between(t\\,${clip.startTime}\\,${(clip.startTime + dur).toFixed(3)})`;
      const blend = (clip.transform.blendMode || 'normal');
      const next = `stage${++compositeStage}`;

      if (blend === 'normal' || isAnimated(clip, 'positionX') || isAnimated(clip, 'positionY') || isAnimated(clip, 'scale') || hasAnimType(clip, 'slide') || hasAnimType(clip, 'zoom')) {
        filterLines.push(`[${composite}][${vlabel}]overlay=x='${x}':y='${y}':enable='${enable}':eval=frame[${next}]`);
      } else {
        // Static-geometry blend modes: localize the blend to the clip's own
        // footprint so non-"normal" modes don't darken/lighten the whole frame.
        const w = Math.round((m.width || W) * (clip.transform.scale || 1));
        const h = Math.round((m.height || H) * (clip.transform.scale || 1));
        const cx = Math.round((W - w) / 2 + (clip.transform.positionX || 0));
        const cy = Math.round((H - h) / 2 + (clip.transform.positionY || 0));
        const cropLabel = `crop${vLabelCounter}`;
        const blendLabel = `blend${vLabelCounter}`;
        filterLines.push(`[${composite}]crop=${w}:${h}:${cx}:${cy}[${cropLabel}]`);
        filterLines.push(`[${cropLabel}][${vlabel}]blend=all_mode=${ffmpegBlendMode(blend)}:enable='${enable}'[${blendLabel}]`);
        filterLines.push(`[${composite}][${blendLabel}]overlay=x=${cx}:y=${cy}:enable='${enable}'[${next}]`);
      }
      composite = next;
    }
  }

  if (textClips.length > 0) {
    const assPath = buildAssFile(textClips, W, H);
    const next = `stage${++compositeStage}`;
    // format=yuv420p right before subtitles (not just after, at the very end)
    // is required: libass's own animated tags (\fad, \move, \t - i.e. text
    // animIn/animOut) silently stop animating and just render at their final
    // static state when fed an RGBA-format frame, even though static text
    // (position, the box background) renders fine either way - confirmed
    // empirically by isolating an identical .ass file against an RGBA vs a
    // plain-format source.
    filterLines.push(`[${composite}]format=yuv420p,subtitles=filename=${assPath.replace(/:/g, '\\:').replace(/'/g, "\\\\'")}[${next}]`);
    composite = next;
  }

  filterLines.push(`[${composite}]format=yuv420p,fps=${FPS}[outv]`);

  let audioMap = null;
  if (audioLabels.length > 0) {
    filterLines.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[outa]`);
    audioMap = 'outa';
  } else {
    filterLines.push(`anullsrc=channel_layout=stereo:sample_rate=48000[outa]`);
    audioMap = 'outa';
  }

  const args = [];
  for (const inp of inputs) args.push(...inp.args);
  args.push('-filter_complex', filterLines.join(';'));
  args.push('-map', '[outv]', '-map', `[${audioMap}]`);
  args.push('-t', totalDuration.toFixed(3));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-y', outputPath);

  return { args, totalDuration };
}

function ffmpegBlendMode(mode) {
  const map = {
    normal: 'normal', screen: 'screen', multiply: 'multiply', overlay: 'overlay',
    darken: 'darken', lighten: 'lighten', difference: 'difference', addition: 'addition',
  };
  return map[mode] || 'normal';
}

function buildAudioClipChain(clip, mediaItem, idx, filterLines, nextId) {
  const dur = clipDisplayDuration(clip);
  const mult = (clip.speed && clip.speed.multiplier) || 1;
  const chain = [`atrim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];

  let remaining = mult;
  const tempoStops = [];
  while (remaining > 2.0) { tempoStops.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5 && remaining > 0) { tempoStops.push(0.5); remaining /= 0.5; }
  if (Math.abs(remaining - 1) > 1e-3) tempoStops.push(remaining);
  for (const t of tempoStops) chain.push(`atempo=${t.toFixed(4)}`);

  if (isAnimated(clip, 'volume')) {
    const expr = buildKeyframeExpr(kfFor(clip, 'volume'), clip.volume || 0, 't');
    chain.push(`volume=volume='pow(10\\,(${expr})/20)':eval=frame`);
  } else if (clip.volume) {
    chain.push(`volume=${db2lin(clip.volume).toFixed(4)}`);
  }

  const pan = clamp(clip.pan || 0, -1, 1);
  if (pan !== 0) {
    const gainL = pan <= 0 ? 1 : 1 - pan;
    const gainR = pan >= 0 ? 1 : 1 + pan;
    chain.push(`pan=stereo|c0=${gainL.toFixed(3)}*c0|c1=${gainR.toFixed(3)}*c1`);
  }

  if (clip.fadeIn) chain.push(`afade=t=in:st=0:d=${clip.fadeIn.toFixed(3)}`);
  if (clip.fadeOut) chain.push(`afade=t=out:st=${Math.max(0, dur - clip.fadeOut).toFixed(3)}:d=${clip.fadeOut.toFixed(3)}`);

  const delayMs = Math.round(clip.startTime * 1000);
  chain.push(`adelay=${delayMs}|${delayMs}`);

  const label = `a${nextId()}`;
  filterLines.push(`[${idx}:a]${chain.join(',')}[${label}]`);
  return label;
}

function runExport(project, outputPath, onProgress) {
  const { args, totalDuration } = buildFilterGraph(project, outputPath);
  return new Promise((resolve, reject) => {
    currentProc = spawn(ffmpegPath, args);
    let stderrBuf = '';
    currentProc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(d.toString());
      if (m) {
        const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress({ seconds, totalDuration, percent: Math.min(100, (seconds / totalDuration) * 100) });
      }
    });
    currentProc.on('close', (code) => {
      currentProc = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderrBuf.slice(-4000)}`));
    });
    currentProc.on('error', (err) => {
      currentProc = null;
      reject(err);
    });
  });
}

function cancelExport() {
  if (currentProc) currentProc.kill('SIGKILL');
  currentProc = null;
}

module.exports = { runExport, cancelExport, buildFilterGraph };
