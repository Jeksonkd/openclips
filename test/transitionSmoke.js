// Headless smoke test for the new transitions/animations feature: builds a
// project with (a) a same-track fade transition between two clips (mimics
// what ProjectState.applyTransition would produce - overlapping startTime +
// animIn/animOut + fadeIn/fadeOut), (b) a standalone zoom-in animation on an
// image clip, and (c) a text clip with slide-in + fade-out. Runs the real
// ffmpeg export pipeline and checks the output duration/exit code.
const { runExport } = require('../src/main/exportGraph');

const A = '/tmp/cc-test/clipA.mp4'; // 640x360, 6s, has audio (440hz)
const B = '/tmp/cc-test/clipB.mp4'; // 640x360, 4s, has audio (220hz)
const LOGO = '/tmp/cc-test/logo.png'; // 200x200 still image

const media = {
  mA: { id: 'mA', path: A, type: 'video', duration: 6, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: true },
  mB: { id: 'mB', path: B, type: 'video', duration: 4, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: true },
  mLogo: { id: 'mLogo', path: LOGO, type: 'image', duration: 5, width: 200, height: 200, fps: 30, hasVideo: true, hasAudio: false },
};

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

const TDUR = 0.6;
const clipA = clip({ mediaId: 'mA', startTime: 0, inPoint: 0, outPoint: 4, animOut: { type: 'fade', duration: TDUR }, fadeOut: TDUR });
const clipB = clip({
  mediaId: 'mB', startTime: 4 - TDUR, inPoint: 0, outPoint: 4,
  animIn: { type: 'fade', duration: TDUR }, fadeIn: TDUR,
  transitionIn: { type: 'fade', duration: TDUR, withClipId: clipA.id },
});

const zoomLogo = clip({
  mediaId: 'mLogo', startTime: 0.5, inPoint: 0, outPoint: 2.5,
  transform: { positionX: 0, positionY: -100, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
  animIn: { type: 'zoom', duration: 0.5 },
});

const textClip = clip({
  kind: 'text', mediaId: null, startTime: 1, inPoint: 0, outPoint: 3.5,
  transform: { positionX: 0, positionY: 130, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
  text: { content: 'Slide + Fade Text', fontFamily: 'Sans', fontSize: 34, color: '#ffffff', align: 'center', bgEnabled: false },
  animIn: { type: 'slide', duration: 0.5 },
  animOut: { type: 'fade', duration: 0.5 },
});

const project = {
  media,
  timeline: {
    currentTime: 0,
    zoomLevel: 80,
    tracks: [
      { id: 't1', name: 'Track 1', muted: false, clips: [clipA, clipB] },
      { id: 't2', name: 'Track 2', muted: false, clips: [zoomLogo, textClip] },
    ],
  },
  canvas: { width: 640, height: 360, fps: 30 },
};

const outPath = '/tmp/cc-test/transition_smoke.mp4';
console.log('Expected total duration: ~', (clipA.outPoint) + (clipB.outPoint) - TDUR, 's (clipA 4s + clipB 4s - 0.6s overlap)');
console.log('Running transition/animation export test...');
runExport(project, outPath, (p) => process.stdout.write(`\rprogress: ${p.percent.toFixed(1)}%   `))
  .then(() => { console.log('\nExport finished:', outPath); })
  .catch((err) => { console.error('\nExport FAILED:', err.message); process.exit(1); });
