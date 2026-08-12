// Headless smoke test for the export filter-graph builder: constructs a
// synthetic project (matching the renderer's unified single-track-type
// schema: any track can hold 'media' | 'text' | 'adjustment' clips) and runs
// it through the real ffmpeg export pipeline, independent of the Electron UI
// (which can't be driven from this sandbox).
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
    kind: 'media',
    mediaId: null,
    startTime: 0,
    inPoint: 0,
    outPoint: 1,
    volume: 0,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
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
  }, overrides);
}

// clipA also carries its own audio (mA has audio) - no separate audio clip needed anymore.
const clipA = clip({
  mediaId: 'mA', startTime: 0, inPoint: 0, outPoint: 4,
  volume: -6, fadeIn: 0.5, fadeOut: 0.5,
  adjustments: Object.assign({}, clip().adjustments, { contrast: 20, saturation: 15, vignette: 40, temperature: 15 }),
});
clipA.keyframes.push(
  { timestamp: 0, property: 'opacity', value: 0, easing: 'linear' },
  { timestamp: 0.5, property: 'opacity', value: 1, easing: 'linear' },
);

const clipB = clip({
  mediaId: 'mB', startTime: 4, inPoint: 0, outPoint: 4,
  volume: -3, pan: -0.4,
  speed: { multiplier: 1.5 },
});
clipB.keyframes.push({ timestamp: 0, property: 'volume', value: -20 }, { timestamp: 1, property: 'volume', value: -3 });

const logoClip = clip({
  mediaId: 'mLogo', startTime: 1, inPoint: 0, outPoint: 3,
  transform: { positionX: 180, positionY: -100, scale: 0.5, rotation: 10, opacity: 0.85, blendMode: 'screen' },
});
logoClip.keyframes.push(
  { timestamp: 0, property: 'positionX', value: -180 },
  { timestamp: 2, property: 'positionX', value: 180 },
  { timestamp: 0, property: 'rotation', value: 0 },
  { timestamp: 2, property: 'rotation', value: 45 },
);

const adjustClip = clip({ kind: 'adjustment', mediaId: null, startTime: 2, inPoint: 0, outPoint: 3 });
adjustClip.adjustments.blacks = -15;
adjustClip.adjustments.hsl.cyan = [10, 30, 0];

const textClip = clip({
  kind: 'text', mediaId: null, startTime: 0.5, inPoint: 0, outPoint: 5.5,
  transform: { positionX: 0, positionY: 130, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
  text: { content: 'OpenCut Demo', fontFamily: 'Sans', fontSize: 40, color: '#ffdd33', align: 'center', bgEnabled: true, bgColor: '#1a1a4d', bgOpacity: 0.7 },
});

const project = {
  media,
  timeline: {
    currentTime: 0,
    zoomLevel: 80,
    tracks: [
      // Single generic track type now: any clip kind can live on any track.
      { id: 't1', name: 'Track 1', muted: false, clips: [clipA, clipB] },
      { id: 't2', name: 'Track 2', muted: false, clips: [logoClip, adjustClip, textClip] },
    ],
  },
  canvas: { width: 640, height: 360, fps: 30 },
};

const outPath = '/tmp/cc-test/export_smoke.mp4';
console.log('Running export...');
runExport(project, outPath, (p) => process.stdout.write(`\rprogress: ${p.percent.toFixed(1)}%   `))
  .then(() => { console.log('\nExport finished:', outPath); })
  .catch((err) => { console.error('\nExport FAILED:', err.message); process.exit(1); });
