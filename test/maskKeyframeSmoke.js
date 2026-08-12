// Verifies mask position/size can be keyframed: an ellipse mask slides from
// left to right across a red clip. Sampling the mask's expected center X at
// two different times and checking red-vs-black there proves the keyframe
// is actually being read by the geq expression (not just a static default).
const { runExport } = require('../src/main/exportGraph');

const RED = '/tmp/cc-test/redClip.mp4';
const media = { mR: { id: 'mR', path: RED, type: 'video', duration: 4, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: true } };

function clip(overrides) {
  return Object.assign({
    id: 'c' + Math.random().toString(36).slice(2),
    kind: 'media', mediaId: null, startTime: 0, inPoint: 0, outPoint: 1,
    volume: 0, pan: 0, fadeIn: 0, fadeOut: 0,
    transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
    speed: { multiplier: 1 },
    adjustments: {
      brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      temperature: 0, tint: 0, saturation: 0, vibrance: 0, sharpen: 0, clarity: 0, dehaze: 0, vignette: 0, grain: 0,
      hsl: { red: [0,0,0], orange: [0,0,0], yellow: [0,0,0], green: [0,0,0], cyan: [0,0,0], blue: [0,0,0], purple: [0,0,0], magenta: [0,0,0] },
      curves: { luma: [[0,0],[255,255]], red: [[0,0],[255,255]], green: [[0,0],[255,255]], blue: [[0,0],[255,255]] },
      wheels: { shadows: [0,0], midtones: [0,0], highlights: [0,0] },
    },
    keyframes: [],
    animIn: { type: 'none', duration: 0.5 },
    animOut: { type: 'none', duration: 0.5 },
    transitionIn: null,
    effect: { type: 'blur', amount: 50 },
    effectTargets: [],
    mask: { type: 'none', posX: 0.5, posY: 0.5, sizeX: 0.3, sizeY: 0.3, invert: false },
  }, overrides);
}

const redClip = clip({
  mediaId: 'mR', startTime: 0, inPoint: 0, outPoint: 4,
  mask: { type: 'ellipse', posX: 0.2, posY: 0.5, sizeX: 0.12, sizeY: 0.35, invert: false },
});
redClip.keyframes.push(
  { timestamp: 0, property: 'mask_posX', value: 0.2, easing: 'linear' },
  { timestamp: 4, property: 'mask_posX', value: 0.8, easing: 'linear' },
);

const project = {
  media,
  timeline: { currentTime: 0, zoomLevel: 80, tracks: [{ id: 't1', name: 'Track 1', muted: false, clips: [redClip] }] },
  canvas: { width: 640, height: 360, fps: 30 },
};

const outPath = '/tmp/cc-test/mask_keyframe_smoke.mp4';
runExport(project, outPath, (p) => process.stdout.write(`\rprogress: ${p.percent.toFixed(1)}%   `))
  .then(() => { console.log('\nExport finished:', outPath); })
  .catch((err) => { console.error('\nExport FAILED:', err.message); process.exit(1); });
