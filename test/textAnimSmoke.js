// Numerically-checkable text animation test: a single text clip with a fade
// animOut over a plain black background, so a pixel sample inside a letter's
// stroke directly reads back the effective alpha (white=255 fully opaque,
// dimmer toward 0 as it fades).
const { runExport } = require('../src/main/exportGraph');

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
  }, overrides);
}

const textClip = clip({
  kind: 'text', mediaId: null, startTime: 1, inPoint: 0, outPoint: 3.5,
  transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
  text: { content: 'WWWWWWWW', fontFamily: 'Sans', fontSize: 80, color: '#ffffff', align: 'center', bgEnabled: false },
  animOut: { type: 'fade', duration: 1.0 },
});

const project = {
  media: {},
  timeline: { currentTime: 0, zoomLevel: 80, tracks: [{ id: 't1', name: 'Track 1', muted: false, clips: [textClip] }] },
  canvas: { width: 640, height: 360, fps: 30 },
};

const outPath = '/tmp/cc-test/text_anim_smoke.mp4';
console.log('textClip global span: [1, 4.5), fade-out window global: [3.5, 4.5)');
runExport(project, outPath, (p) => process.stdout.write(`\rprogress: ${p.percent.toFixed(1)}%   `))
  .then(() => { console.log('\nExport finished:', outPath); })
  .catch((err) => { console.error('\nExport FAILED:', err.message); process.exit(1); });
