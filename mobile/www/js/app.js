// OpenClips mobile - a scoped-down CapCut-style companion editor.
// State is intentionally much simpler than the desktop app: one linear
// sequence of clips (no multi-track compositing). Media clips can carry a
// simple effect and/or a static rect/ellipse mask; text clips are their own
// solid-color segments in the same sequence (not an overlay on top of
// video - see README for why). Persisted to localStorage on every change:
// Android can recreate the whole Activity (and wipe all JS state) when the
// system reclaims memory while a heavy external activity like the document
// picker is in front of it - that's the most likely explanation for
// "adding more media doesn't work after the first time", since the result
// would come back to a freshly-reloaded page with no memory of anything.

const state = {
  clips: [], // see makeMediaClip/makeTextClip below for shape
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  activeVideoPath: null,
};

const FADE_DUR = 0.5;
const PX_PER_SEC = 44;
const STORAGE_KEY = 'openclips_project_v1';
const EFFECT_CHOICES = [
  ['none', 'None', '∅'], ['blur', 'Blur', '◌'], ['bw', 'B & W', '◑'],
  ['invert', 'Invert', '◒'], ['sepia', 'Sepia', '◓'],
];

function uid() { return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function Native() { return window.Capacitor.Plugins.OpenClipsNative; }
function toFileSrc(path) { return window.Capacitor.convertFileSrc(path); }
function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function makeMediaClip(c) {
  return {
    id: uid(), kind: 'media',
    path: c.path, name: c.name, duration: c.duration, width: c.width, height: c.height,
    inPoint: 0, outPoint: c.duration,
    thumbPath: null, transitionAfter: 'none',
    volume: 0, opacity: 1,
    effect: { type: 'none', amount: 50 },
    mask: { type: 'none', posX: 0.5, posY: 0.5, sizeX: 0.3, sizeY: 0.3, invert: false },
  };
}
function makeTextClip(content, color) {
  return {
    id: uid(), kind: 'text', name: 'Text: ' + content.slice(0, 20),
    duration: 3, inPoint: 0, outPoint: 3, transitionAfter: 'none',
    text: { content, color: color || '#ffffff' },
  };
}

function clipDuration(c) { return Math.max(0.05, c.outPoint - c.inPoint); }
function totalDuration() { return state.clips.reduce((sum, c) => sum + clipDuration(c), 0); }

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---- persistence ----
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ clips: state.clips, selectedClipId: state.selectedClipId }));
  } catch (e) { /* storage full or unavailable - not fatal, just no restore */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.clips || data.clips.length === 0) return false;
    state.clips = data.clips;
    state.selectedClipId = data.selectedClipId || null;
    return true;
  } catch (e) { return false; }
}

// ---- screens ----
function showEditor() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
}

// ---- generic sheet helpers (each sheet owns its own option clicks - a
// single shared listener across all .sheet-option elements was the bug
// that made picking a Media/Text/Effect option also fire the Transition
// sheet's handler and vice versa) ----
function closeAllSheets() {
  document.getElementById('sheet-backdrop').classList.add('hidden');
  document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden'));
}
function openSheet(id) {
  document.getElementById('sheet-backdrop').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
}

// ---- import ----
async function importClips() {
  closeAllSheets();
  let result;
  try {
    result = await Native().pickVideos();
  } catch (e) {
    showToast('Import failed: ' + (e && e.message ? e.message : e));
    return;
  }
  const picked = (result && result.clips) || [];
  if (picked.length === 0) return;
  const newClips = picked.map(makeMediaClip);
  state.clips.push(...newClips);
  showEditor();
  renderTimeline();
  selectClip(newClips[0].id);
  seekGlobal(clipStartTime(newClips[0].id));
  persist();
  for (const c of newClips) generateThumbFor(c.path);
}

async function generateThumbFor(path) {
  try {
    const res = await Native().generateThumbnail({ path, atSeconds: 0.1 });
    const clip = state.clips.find((c) => c.kind === 'media' && c.path === path);
    if (clip && res && res.path) {
      clip.thumbPath = res.path;
      renderTimeline();
      persist();
    }
  } catch (e) { /* thumbnail is cosmetic only */ }
}

// ---- selection ----
function selectClip(id) {
  state.selectedClipId = id;
  renderTimeline();
  persist();
}

function findClip(id) { return state.clips.find((c) => c.id === id); }
function clipIndex(id) { return state.clips.findIndex((c) => c.id === id); }

function clipStartTime(id) {
  let t = 0;
  for (const c of state.clips) {
    if (c.id === id) return t;
    t += clipDuration(c);
  }
  return t;
}

// ---- timeline rendering ----
function renderTimeline() {
  const track = document.getElementById('timeline-track');
  track.innerHTML = '';
  state.clips.forEach((clip, i) => {
    const el = document.createElement('div');
    const isText = clip.kind === 'text';
    el.className = 'tl-clip' + (isText ? ' text-clip' : '') + (clip.id === state.selectedClipId ? ' selected' : '');
    el.style.width = Math.max(20, clipDuration(clip) * PX_PER_SEC) + 'px';
    if (!isText && clip.thumbPath) el.style.backgroundImage = `url("${toFileSrc(clip.thumbPath)}")`;
    el.dataset.clipId = clip.id;

    if (isText) {
      const preview = document.createElement('div');
      preview.className = 'tl-clip-text-preview';
      preview.textContent = clip.text.content;
      el.appendChild(preview);
    } else {
      const name = document.createElement('div');
      name.className = 'tl-clip-name';
      name.textContent = clip.name;
      el.appendChild(name);
      if ((clip.effect && clip.effect.type !== 'none') || (clip.mask && clip.mask.type !== 'none')) {
        const badge = document.createElement('div');
        badge.className = 'tl-clip-badge';
        badge.textContent = '✦';
        el.appendChild(badge);
      }
    }

    let leftHandle = null, rightHandle = null;
    if (!isText) {
      leftHandle = document.createElement('div');
      leftHandle.className = 'tl-handle left';
      rightHandle = document.createElement('div');
      rightHandle.className = 'tl-handle right';
      el.appendChild(leftHandle);
      el.appendChild(rightHandle);
      wireTrimHandle(leftHandle, clip, 'in');
      wireTrimHandle(rightHandle, clip, 'out');
    }

    el.addEventListener('click', (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      selectClip(clip.id);
      seekGlobal(clipStartTime(clip.id));
      openPropsSheet(clip);
    });

    track.appendChild(el);

    if (i < state.clips.length - 1) {
      const btn = document.createElement('div');
      btn.className = 'tl-transition-btn' + (clip.transitionAfter !== 'none' ? ' active' : '');
      btn.textContent = clip.transitionAfter === 'fade' ? '◐' : '+';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTransitionSheet(clip);
      });
      track.appendChild(btn);
    }
  });
  document.getElementById('time-readout').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
}

function wireTrimHandle(handleEl, clip, side) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleEl.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const origIn = clip.inPoint;
    const origOut = clip.outPoint;
    const onMove = (ev) => {
      const dtSec = (ev.clientX - startX) / PX_PER_SEC;
      if (side === 'in') {
        clip.inPoint = Math.min(origOut - 0.1, Math.max(0, origIn + dtSec));
      } else {
        clip.outPoint = Math.max(origIn + 0.1, Math.min(clip.duration, origOut + dtSec));
      }
      renderTimeline();
    };
    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      seekGlobal(clipStartTime(clip.id) + (side === 'in' ? 0 : clipDuration(clip)));
      persist();
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
  });
}

// ---- transition sheet ----
let transitionSheetClip = null;
function openTransitionSheet(clip) {
  transitionSheetClip = clip;
  const sheet = document.getElementById('transition-sheet');
  sheet.querySelectorAll('.sheet-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === clip.transitionAfter);
  });
  openSheet('transition-sheet');
}

// ---- add sheet ----
function openAddSheet() { openSheet('add-sheet'); }

// ---- text sheet ----
function openTextSheet() {
  document.getElementById('text-input').value = '';
  document.getElementById('text-color-input').value = '#ffffff';
  openSheet('text-sheet');
}
function submitTextSheet() {
  const content = document.getElementById('text-input').value.trim();
  if (!content) { showToast('Type something first'); return; }
  const color = document.getElementById('text-color-input').value;
  const clip = makeTextClip(content, color);
  state.clips.push(clip);
  closeAllSheets();
  showEditor();
  renderTimeline();
  selectClip(clip.id);
  seekGlobal(clipStartTime(clip.id));
  persist();
}

// ---- effect sheet (from Add, or from the properties panel) ----
let effectSheetTarget = null; // clip the effect sheet applies to
function openEffectSheet(clip) {
  if (!clip) { showToast('Select a clip first'); return; }
  effectSheetTarget = clip;
  const container = document.getElementById('effect-options');
  container.innerHTML = '';
  EFFECT_CHOICES.forEach(([type, label, icon]) => {
    const btn = document.createElement('button');
    btn.className = 'sheet-option' + (clip.effect.type === type ? ' active' : '');
    btn.innerHTML = `<span class="sheet-option-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      clip.effect.type = type;
      closeAllSheets();
      renderTimeline();
      persist();
      showToast(`${label} applied`);
    });
    container.appendChild(btn);
  });
  openSheet('effect-sheet');
}

// ---- properties sheet (tap a clip -> Adjust / Effect / Mask & Blend) ----
let propsClip = null;
let propsActiveTab = 'adjust';
function openPropsSheet(clip) {
  if (clip.kind === 'text') return; // effects/masks/adjust apply to media only for now
  propsClip = clip;
  renderPropsTabs();
  renderPropsBody();
  openSheet('props-sheet');
}
function renderPropsTabs() {
  document.querySelectorAll('.props-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === propsActiveTab);
  });
}
function fieldRow(label, inputEl) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  row.appendChild(inputEl);
  return row;
}
function renderPropsBody() {
  const body = document.getElementById('props-body');
  body.innerHTML = '';
  if (!propsClip) return;
  const clip = propsClip;

  if (propsActiveTab === 'adjust') {
    const volRange = document.createElement('input');
    volRange.type = 'range'; volRange.min = -30; volRange.max = 12; volRange.step = 1; volRange.value = clip.volume;
    volRange.addEventListener('input', () => { clip.volume = Number(volRange.value); persist(); });
    body.appendChild(fieldRow(`Volume (${clip.volume}dB)`, volRange));

    const opRange = document.createElement('input');
    opRange.type = 'range'; opRange.min = 0; opRange.max = 1; opRange.step = 0.05; opRange.value = clip.opacity;
    opRange.addEventListener('input', () => { clip.opacity = Number(opRange.value); persist(); });
    body.appendChild(fieldRow('Brightness', opRange));

  } else if (propsActiveTab === 'effect') {
    const title = document.createElement('div');
    title.className = 'props-section-title';
    title.textContent = 'Effect';
    body.appendChild(title);
    const select = document.createElement('select');
    EFFECT_CHOICES.forEach(([type, label]) => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = label;
      if (clip.effect.type === type) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => { clip.effect.type = select.value; renderTimeline(); persist(); });
    body.appendChild(fieldRow('Type', select));

    const amtRange = document.createElement('input');
    amtRange.type = 'range'; amtRange.min = 0; amtRange.max = 100; amtRange.step = 1; amtRange.value = clip.effect.amount;
    amtRange.addEventListener('input', () => { clip.effect.amount = Number(amtRange.value); persist(); });
    body.appendChild(fieldRow('Amount', amtRange));

  } else if (propsActiveTab === 'mask') {
    const title = document.createElement('div');
    title.className = 'props-section-title';
    title.textContent = 'Blend & Mask';
    body.appendChild(title);

    const shapeSelect = document.createElement('select');
    [['none', 'None'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse']].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = label;
      if (clip.mask.type === v) opt.selected = true;
      shapeSelect.appendChild(opt);
    });
    shapeSelect.addEventListener('change', () => { clip.mask.type = shapeSelect.value; renderTimeline(); persist(); renderPropsBody(); });
    body.appendChild(fieldRow('Shape', shapeSelect));

    if (clip.mask.type !== 'none') {
      const mk = (label, prop, min, max, step) => {
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = clip.mask[prop];
        inp.addEventListener('input', () => { clip.mask[prop] = Number(inp.value); persist(); });
        body.appendChild(fieldRow(label, inp));
      };
      mk('Position X', 'posX', 0, 1, 0.01);
      mk('Position Y', 'posY', 0, 1, 0.01);
      mk('Size X', 'sizeX', 0.05, 1, 0.01);
      mk('Size Y', 'sizeY', 0.05, 1, 0.01);

      const invertCb = document.createElement('input');
      invertCb.type = 'checkbox'; invertCb.checked = !!clip.mask.invert;
      invertCb.addEventListener('change', () => { clip.mask.invert = invertCb.checked; persist(); });
      body.appendChild(fieldRow('Invert', invertCb));
    }
  }
}

// ---- split / delete ----
function splitSelectedAtPlayhead() {
  const clip = findClip(state.selectedClipId);
  if (!clip || clip.kind !== 'media') { showToast('Select a media clip first'); return; }
  const localTime = clip.inPoint + (state.currentTime - clipStartTime(clip.id));
  if (localTime <= clip.inPoint + 0.05 || localTime >= clip.outPoint - 0.05) {
    showToast('Move the playhead inside the clip first');
    return;
  }
  const second = Object.assign({}, clip, {
    id: uid(), inPoint: localTime, transitionAfter: clip.transitionAfter,
    effect: Object.assign({}, clip.effect), mask: Object.assign({}, clip.mask),
  });
  clip.outPoint = localTime;
  clip.transitionAfter = 'none';
  const idx = clipIndex(clip.id);
  state.clips.splice(idx + 1, 0, second);
  renderTimeline();
  persist();
}

function deleteSelected() {
  if (!state.selectedClipId) return;
  const idx = clipIndex(state.selectedClipId);
  if (idx === -1) return;
  state.clips.splice(idx, 1);
  state.selectedClipId = state.clips.length ? state.clips[Math.min(idx, state.clips.length - 1)].id : null;
  renderTimeline();
  seekGlobal(state.currentTime);
  persist();
  if (state.clips.length === 0) {
    document.getElementById('home-screen').classList.remove('hidden');
    document.getElementById('editor-screen').classList.add('hidden');
  }
}

// ---- playback ----
const videoEl = document.getElementById('preview-video');

function clipAtGlobalTime(t) {
  let acc = 0;
  for (const c of state.clips) {
    const d = clipDuration(c);
    if (t < acc + d || c === state.clips[state.clips.length - 1]) return { clip: c, localOffset: t - acc };
    acc += d;
  }
  return null;
}

function seekGlobal(t) {
  state.currentTime = Math.max(0, Math.min(totalDuration(), t));
  const found = clipAtGlobalTime(state.currentTime);
  document.getElementById('no-clip-hint').classList.toggle('hidden', !!found);
  if (found && found.clip.kind === 'media') {
    const { clip, localOffset } = found;
    const srcTime = clip.inPoint + Math.max(0, localOffset);
    videoEl.classList.remove('hidden');
    if (state.activeVideoPath !== clip.path) {
      videoEl.src = toFileSrc(clip.path);
      state.activeVideoPath = clip.path;
    }
    if (Math.abs(videoEl.currentTime - srcTime) > 0.15) {
      try { videoEl.currentTime = srcTime; } catch (e) {}
    }
  } else {
    // Text segment: nothing to play back visually here in the lightweight
    // preview (export renders its real solid-color+text look) - just pause
    // whatever video was showing so it doesn't keep playing underneath.
    if (!videoEl.paused) videoEl.pause();
  }
  document.getElementById('timeline-scroll').scrollLeft = state.currentTime * PX_PER_SEC;
  document.getElementById('time-readout').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
}

let rafId = null;
let wallStart = 0, timeStart = 0;
function play() {
  if (state.isPlaying || state.clips.length === 0) return;
  state.isPlaying = true;
  document.getElementById('btn-playpause').textContent = '⏸';
  document.getElementById('btn-playpause').classList.add('playing');
  wallStart = performance.now();
  timeStart = state.currentTime;
  videoEl.play().catch(() => {});
  const loop = () => {
    if (!state.isPlaying) return;
    const elapsed = (performance.now() - wallStart) / 1000;
    let t = timeStart + elapsed;
    const dur = totalDuration();
    if (t >= dur) { t = dur; pause(); }
    seekGlobal(t);
    if (state.isPlaying) rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function pause() {
  state.isPlaying = false;
  document.getElementById('btn-playpause').textContent = '▶';
  document.getElementById('btn-playpause').classList.remove('playing');
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  videoEl.pause();
}

// ---- export ----
function clampFadeDur(a, b) {
  return Math.max(0.05, Math.min(FADE_DUR, clipDuration(a) * 0.4, clipDuration(b) * 0.4));
}

// Effects/masks apply within a single already-isolated clip segment (no
// other layer under it in this linear-sequence model), so unlike the
// desktop app there's no need for enable/timeline-gating here - simpler.
function effectFilterFor(effect) {
  const amt = effect.amount == null ? 50 : effect.amount;
  switch (effect.type) {
    case 'blur': return `gblur=sigma=${((amt / 100) * 12).toFixed(2)}`;
    case 'bw': return 'eq=saturation=0';
    case 'invert': return 'negate';
    case 'sepia': {
      const t = amt / 100;
      const mix = (id, sep) => (id + (sep - id) * t).toFixed(4);
      return `colorchannelmixer=rr=${mix(1, 0.393)}:rg=${mix(0, 0.769)}:rb=${mix(0, 0.189)}:` +
        `gr=${mix(0, 0.349)}:gg=${mix(1, 0.686)}:gb=${mix(0, 0.168)}:` +
        `br=${mix(0, 0.272)}:bg=${mix(0, 0.534)}:bb=${mix(1, 0.131)}`;
    }
    default: return null;
  }
}

// Mask multiplies RGB by 0/1 directly (no alpha channel involved) since
// there's nothing underneath a clip to reveal in this single-track model -
// "outside the mask" reads as black, which is the correct/only sensible
// behavior here (a vignette/spotlight effect, not a compositing cutout).
function maskFilterFor(mask) {
  const cx = `W*${(mask.posX == null ? 0.5 : mask.posX).toFixed(4)}`;
  const cy = `H*${(mask.posY == null ? 0.5 : mask.posY).toFixed(4)}`;
  const rx = `W*${Math.max(0.02, mask.sizeX == null ? 0.3 : mask.sizeX).toFixed(4)}`;
  const ry = `H*${Math.max(0.02, mask.sizeY == null ? 0.3 : mask.sizeY).toFixed(4)}`;
  let inside;
  if (mask.type === 'ellipse') {
    inside = `if(lt(((X-(${cx}))*(X-(${cx})))/((${rx})*(${rx}))+((Y-(${cy}))*(Y-(${cy})))/((${ry})*(${ry}))\\,1)\\,1\\,0)`;
  } else {
    inside = `if(lt(abs(X-(${cx}))\\,${rx})\\,if(lt(abs(Y-(${cy}))\\,${ry})\\,1\\,0)\\,0)`;
  }
  const expr = mask.invert ? `(1-(${inside}))` : inside;
  return `geq=r='r(X\\,Y)*(${expr})':g='g(X\\,Y)*(${expr})':b='b(X\\,Y)*(${expr})'`;
}

// libx264/yuv420p need even dimensions, and processing at full source
// resolution (often 4K on a modern phone) is a plausible cause of the
// reported export crash - very likely an out-of-memory kill, which no
// amount of try/catch on the JS or Java side can prevent. Capping the
// working resolution keeps memory pressure sane on mid-range hardware.
function computeCanvasSize(clips) {
  const firstMedia = clips.find((c) => c.kind === 'media' && c.width && c.height);
  let W = (firstMedia && firstMedia.width) || 1080;
  let H = (firstMedia && firstMedia.height) || 1920;
  const MAX_DIM = 1280;
  const largest = Math.max(W, H);
  const scale = largest > MAX_DIM ? MAX_DIM / largest : 1;
  W = Math.max(2, Math.round((W * scale) / 2) * 2);
  H = Math.max(2, Math.round((H * scale) / 2) * 2);
  return { W, H };
}

function escDrawtext(s) {
  // Order matters: escape literal backslashes first so the escapes added
  // below for : and , don't themselves get re-escaped. ' is swapped for a
  // typographic quote rather than escaped, since drawtext's text='...' has
  // no clean way to embed a literal single quote.
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, '’')
    .replace(/\r\n|\r|\n/g, ' ');
}

function buildExportArgs(outputPath) {
  const clips = state.clips;
  const { W, H } = computeCanvasSize(clips);

  const args = ['-y'];
  const filterParts = [];
  const mapLabels = [];
  let inputIdx = 0;

  clips.forEach((c, i) => {
    const dur = clipDuration(c);
    let vLabel = `v${i}`, aLabel = `a${i}`;

    if (c.kind === 'text') {
      args.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${dur.toFixed(3)}:r=30`);
      const colorIdx = inputIdx++;
      args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
      const silenceIdx = inputIdx++;
      const txt = escDrawtext(c.text.content);
      const color = (c.text.color || '#ffffff').replace('#', '0x');
      const fontSize = Math.round(H * 0.06);
      let vChain = `[${colorIdx}:v]drawtext=fontfile=/system/fonts/Roboto-Regular.ttf:text='${txt}':` +
        `fontcolor=${color}:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p,setsar=1,fps=30`;
      filterParts.push(`${vChain}[${vLabel}]`);
      filterParts.push(`[${silenceIdx}:a]anull[${aLabel}]`);
    } else {
      args.push('-i', c.path);
      const idx = inputIdx++;
      let vChain = `[${idx}:v]trim=start=${c.inPoint.toFixed(3)}:end=${c.outPoint.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30`;
      let aChain = `[${idx}:a]atrim=start=${c.inPoint.toFixed(3)}:end=${c.outPoint.toFixed(3)},asetpts=PTS-STARTPTS`;

      const effectFilter = c.effect && effectFilterFor(c.effect);
      if (effectFilter) vChain += ',' + effectFilter;
      if (c.mask && c.mask.type && c.mask.type !== 'none') vChain += ',' + maskFilterFor(c.mask);
      if (c.opacity != null && c.opacity < 0.999) {
        const op = Math.max(0, Math.min(1, c.opacity));
        vChain += `,colorchannelmixer=rr=${op}:gg=${op}:bb=${op}`;
      }
      if (c.volume) aChain += `,volume=${Math.pow(10, c.volume / 20).toFixed(4)}`;

      const prev = clips[i - 1];
      const next = clips[i + 1];
      if (prev && prev.transitionAfter === 'fade') {
        const d = clampFadeDur(prev, c);
        vChain += `,fade=t=in:st=0:d=${d.toFixed(3)}`;
        aChain += `,afade=t=in:st=0:d=${d.toFixed(3)}`;
      }
      if (next && c.transitionAfter === 'fade') {
        const d = clampFadeDur(c, next);
        const st = Math.max(0, dur - d);
        vChain += `,fade=t=out:st=${st.toFixed(3)}:d=${d.toFixed(3)}`;
        aChain += `,afade=t=out:st=${st.toFixed(3)}:d=${d.toFixed(3)}`;
      }

      filterParts.push(`${vChain}[${vLabel}]`);
      filterParts.push(`${aChain}[${aLabel}]`);
    }
    mapLabels.push(`[${vLabel}][${aLabel}]`);
  });
  filterParts.push(`${mapLabels.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[outv]', '-map', '[outa]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k');
  args.push(outputPath);
  return args;
}

function validateClipsForExport() {
  if (state.clips.length === 0) return 'Add at least one clip first';
  for (const c of state.clips) {
    if (c.kind === 'media') {
      if (!c.path) return 'A clip is missing its source file';
      if (!(c.outPoint > c.inPoint)) return 'A clip has an invalid trim range';
    } else if (c.kind === 'text' && !c.text.content) {
      return 'A text clip is empty';
    }
  }
  return null;
}

async function exportProject() {
  const problem = validateClipsForExport();
  if (problem) { showToast(problem); return; }

  const modal = document.getElementById('export-modal');
  const statusEl = document.getElementById('export-status');
  const fillEl = document.getElementById('export-progress-fill');
  const doneBtn = document.getElementById('export-done-btn');
  doneBtn.classList.add('hidden');
  statusEl.textContent = 'Exporting…';
  fillEl.style.width = '0%';
  modal.classList.remove('hidden');

  function finish(msg) {
    statusEl.textContent = msg;
    doneBtn.classList.remove('hidden');
    doneBtn.onclick = () => modal.classList.add('hidden');
  }

  let listenerHandle = null;
  try {
    const totalMs = totalDuration() * 1000;
    listenerHandle = await Native().addListener('exportProgress', (data) => {
      const pct = totalMs > 0 ? Math.min(100, (data.timeMs / totalMs) * 100) : 0;
      fillEl.style.width = pct.toFixed(1) + '%';
    });

    const paths = await Native().getPaths();
    const outputPath = `${paths.exportDir}openclips_export_${Date.now()}.mp4`;

    let args;
    try {
      args = buildExportArgs(outputPath);
    } catch (e) {
      finish('Could not build the export - ' + (e && e.message ? e.message : e));
      return;
    }

    const result = await Native().exportVideo({ args });
    if (!result || !result.success) {
      console.error('ffmpeg log:', result && result.log);
      finish('Export failed - try removing recent effects/masks and retry');
      return;
    }
    statusEl.textContent = 'Saving to gallery…';
    await Native().saveToGallery({ path: outputPath, displayName: `OpenClips_${Date.now()}.mp4` });
    fillEl.style.width = '100%';
    finish('Saved to Movies/OpenClips');
  } catch (e) {
    finish('Export failed: ' + (e && e.message ? e.message : e));
  } finally {
    if (listenerHandle) listenerHandle.remove();
  }
}

// ---- wiring ----
window.addEventListener('DOMContentLoaded', () => {
  if (restore()) {
    showEditor();
    renderTimeline();
    seekGlobal(0);
  }

  document.getElementById('btn-import-home').addEventListener('click', importClips);
  document.getElementById('tool-add').addEventListener('click', openAddSheet);
  document.getElementById('tool-split').addEventListener('click', splitSelectedAtPlayhead);
  document.getElementById('tool-delete').addEventListener('click', deleteSelected);
  document.getElementById('tool-transition').addEventListener('click', () => {
    const idx = clipIndex(state.selectedClipId);
    if (idx === -1 || idx >= state.clips.length - 1) { showToast('Select a clip that has another clip after it'); return; }
    openTransitionSheet(state.clips[idx]);
  });
  document.getElementById('tool-export').addEventListener('click', exportProject);

  document.getElementById('btn-playpause').addEventListener('click', () => {
    if (state.isPlaying) pause(); else play();
  });

  document.getElementById('sheet-backdrop').addEventListener('click', closeAllSheets);

  // Add sheet
  document.querySelectorAll('#add-sheet .sheet-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.add;
      if (kind === 'media') importClips();
      else if (kind === 'text') openTextSheet();
      else if (kind === 'effect') { closeAllSheets(); openEffectSheet(findClip(state.selectedClipId)); }
    });
  });

  // Transition sheet
  document.querySelectorAll('#transition-sheet .sheet-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (transitionSheetClip) transitionSheetClip.transitionAfter = btn.dataset.type;
      closeAllSheets();
      renderTimeline();
      persist();
    });
  });

  // Text sheet
  document.getElementById('text-sheet-add').addEventListener('click', submitTextSheet);

  // Properties sheet tabs
  document.querySelectorAll('.props-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      propsActiveTab = btn.dataset.tab;
      renderPropsTabs();
      renderPropsBody();
    });
  });

  renderTimeline();
});
