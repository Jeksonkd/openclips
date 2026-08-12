// OpenClips mobile - CapCut-style multi-track companion editor.
// Multi-track model: state.tracks is an array of {id, name, muted, clips}.
// Track array index 0 is the BOTTOM/backmost layer; later tracks composite
// on top of earlier ones (both here and in exportGraph.js) - the timeline
// UI renders tracks in reverse array order so the visual stacking (top of
// the lane list = frontmost) matches standard NLE convention. Clips carry
// an explicit `startTime` (absolute, track-local composite time) instead of
// the old flat model's implicit sequential position, so clips can overlap
// (for transitions) or sit on different tracks (for overlays/text-over-
// video/picture-in-picture-ish use).
// The actual ffmpeg filter-graph construction lives in exportGraph.js (a
// separate, DOM-free module so it's Node-testable) - this file owns state,
// the timeline/preview UI, and wiring only.
//
// Persisted to localStorage on every change: Android can recreate the whole
// Activity (and wipe all JS state) when the system reclaims memory while a
// heavy external activity like the document picker is in front of it.

const G = window.OpenClipsExportGraph;

const state = {
  tracks: [],
  selectedClipId: null,
  activeTrackId: null,
  currentTime: 0,
  isPlaying: false,
  exportSettings: { quality: 'high', framerate: 30, bitrateKbps: null },
  fontPath: null,
};

const PX_PER_SEC = 44;
const LANE_HEIGHT = 60;
const LANE_GAP = 6;
const STORAGE_KEY = 'openclips_project_v2';

function uid() { return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function Native() { return window.Capacitor.Plugins.OpenClipsNative; }
function toFileSrc(path) { return window.Capacitor.convertFileSrc(path); }
function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function clipDuration(c) { return G.clipDuration(c); }

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---- tracks ----
function newTrack(name) {
  return { id: uid(), name: name || `Track ${state.tracks.length + 1}`, muted: false, clips: [] };
}
function ensureTracks() {
  if (state.tracks.length === 0) {
    const t = newTrack('Track 1');
    state.tracks.push(t);
    state.activeTrackId = t.id;
  }
  if (!state.tracks.find((t) => t.id === state.activeTrackId)) state.activeTrackId = state.tracks[0].id;
}
function activeTrack() { ensureTracks(); return state.tracks.find((t) => t.id === state.activeTrackId); }
function addTrack() {
  const t = newTrack();
  state.tracks.push(t);
  state.activeTrackId = t.id;
  renderTrackControls();
  renderTimeline();
  persist();
}
function removeTrack(id) {
  if (state.tracks.length <= 1) { showToast('Keep at least one track'); return; }
  const idx = state.tracks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const removedClipIds = new Set(state.tracks[idx].clips.map((c) => c.id));
  state.tracks.splice(idx, 1);
  if (state.selectedClipId && removedClipIds.has(state.selectedClipId)) state.selectedClipId = null;
  ensureTracks();
  syncPreviewLayers();
  renderTrackControls();
  renderTimeline();
  seekGlobal(state.currentTime);
  persist();
}
function toggleTrackMute(id) {
  const t = state.tracks.find((tr) => tr.id === id);
  if (!t) return;
  t.muted = !t.muted;
  renderTrackControls();
  syncPreviewLayers();
  seekGlobal(state.currentTime);
  persist();
}

function totalDuration() {
  let max = 0;
  for (const t of state.tracks) {
    for (const c of t.clips) max = Math.max(max, c.startTime + clipDuration(c));
  }
  return max;
}

function findClip(id) {
  for (const t of state.tracks) {
    const c = t.clips.find((cl) => cl.id === id);
    if (c) return c;
  }
  return null;
}
function findTrackOfClip(id) {
  return state.tracks.find((t) => t.clips.some((c) => c.id === id)) || null;
}

// ---- clip factories ----
function makeMediaClip(c, startTime) {
  const isImage = c.type === 'image';
  const duration = isImage ? 5 : c.duration;
  return {
    id: uid(), kind: 'media', type: isImage ? 'image' : 'video',
    path: c.path, name: c.name, duration, width: c.width, height: c.height,
    inPoint: 0, outPoint: duration, startTime,
    thumbPath: isImage ? c.path : null,
    volume: 0, opacity: 1, blendMode: 'normal',
    effect: { type: 'none', amount: 50 },
    adjustments: {},
    mask: { type: 'none', posX: 0.5, posY: 0.5, sizeX: 0.3, sizeY: 0.3, invert: false },
    chromaKey: { enabled: false, color: '#00ff00', density: 50, shadows: 50 },
    animIn: { type: 'none', duration: 0.6 },
  };
}
function makeTextClip(content, color, startTime) {
  return {
    id: uid(), kind: 'text', name: 'Text: ' + content.slice(0, 20),
    duration: 3, inPoint: 0, outPoint: 3, startTime,
    text: { content, color: color || '#ffffff' },
    animIn: { type: 'none', duration: 0.6 },
  };
}

// ---- persistence ----
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tracks: state.tracks, selectedClipId: state.selectedClipId, activeTrackId: state.activeTrackId,
      exportSettings: state.exportSettings,
    }));
  } catch (e) { /* storage full or unavailable - not fatal, just no restore */ }
}

// Migrates the old single-sequence localStorage format (state.clips) to the
// new tracks[] shape, so upgrading the app doesn't wipe an in-progress edit.
function migrateOldFormat(data) {
  const track = newTrack('Track 1');
  let t = 0;
  for (const oldClip of data.clips) {
    const dur = (oldClip.outPoint - oldClip.inPoint);
    const clip = Object.assign({}, oldClip, {
      startTime: t, opacity: oldClip.opacity == null ? 1 : oldClip.opacity,
      blendMode: 'normal', adjustments: oldClip.adjustments || {},
      animIn: { type: 'none', duration: 0.6 },
    });
    delete clip.transitionAfter;
    track.clips.push(clip);
    t += dur;
  }
  return [track];
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.tracks && data.tracks.length) {
        state.tracks = data.tracks;
        state.selectedClipId = data.selectedClipId || null;
        state.activeTrackId = data.activeTrackId || null;
        if (data.exportSettings) state.exportSettings = data.exportSettings;
        ensureTracks();
        return true;
      }
    }
    const oldRaw = localStorage.getItem('openclips_project_v1');
    if (oldRaw) {
      const data = JSON.parse(oldRaw);
      if (data.clips && data.clips.length) {
        state.tracks = migrateOldFormat(data);
        if (data.exportSettings) state.exportSettings = data.exportSettings;
        ensureTracks();
        persist();
        return true;
      }
    }
  } catch (e) { /* ignore, start fresh */ }
  return false;
}

// ---- screens ----
function showEditor() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
}

// ---- generic sheet helpers ----
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
    result = await Native().pickMedia();
  } catch (e) {
    showToast('Import failed: ' + (e && e.message ? e.message : e));
    return;
  }
  const picked = (result && result.clips) || [];
  if (picked.length === 0) return;
  const track = activeTrack();
  let t = track.clips.reduce((max, c) => Math.max(max, c.startTime + clipDuration(c)), 0);
  const newClips = [];
  for (const c of picked) {
    const clip = makeMediaClip(c, t);
    t += clipDuration(clip);
    track.clips.push(clip);
    newClips.push(clip);
  }
  showEditor();
  syncPreviewLayers();
  renderTimeline();
  selectClip(newClips[0].id);
  seekGlobal(newClips[0].startTime);
  persist();
  for (const c of newClips) {
    if (c.type === 'video') generateThumbFor(c.path, 'video');
  }
}

async function generateThumbFor(path, type) {
  try {
    const res = await Native().generateThumbnail({ path, atSeconds: 0.1, type });
    const clip = state.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'media' && c.path === path);
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
  const track = findTrackOfClip(id);
  if (track) state.activeTrackId = track.id;
  renderTimeline();
  renderTrackControls();
  persist();
}

// ---- track controls (chip row above the timeline) ----
function renderTrackControls() {
  ensureTracks();
  const row = document.getElementById('track-controls');
  row.innerHTML = '';
  // Reverse order: topmost-compositing track (last in the array) shown first/left.
  const ordered = state.tracks.slice().reverse();
  ordered.forEach((t) => {
    const chip = document.createElement('div');
    chip.className = 'track-chip' + (t.id === state.activeTrackId ? ' active' : '') + (t.muted ? ' muted' : '');
    const label = document.createElement('span');
    label.className = 'track-chip-label';
    label.textContent = t.name;
    chip.appendChild(label);
    chip.addEventListener('click', () => { state.activeTrackId = t.id; renderTrackControls(); });

    const muteBtn = document.createElement('button');
    muteBtn.className = 'track-chip-btn';
    muteBtn.textContent = t.muted ? '🔇' : '🔊';
    muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTrackMute(t.id); });
    chip.appendChild(muteBtn);

    if (state.tracks.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'track-chip-btn';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(t.id); });
      chip.appendChild(delBtn);
    }
    row.appendChild(chip);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'track-chip add-track-btn';
  addBtn.textContent = '+ Track';
  addBtn.addEventListener('click', addTrack);
  row.appendChild(addBtn);
}

// ---- timeline rendering ----
function laneHeightTotal() { return state.tracks.length * LANE_HEIGHT + (state.tracks.length - 1) * LANE_GAP; }

function renderTimeline() {
  ensureTracks();
  const container = document.getElementById('timeline-tracks');
  container.innerHTML = '';
  container.style.height = laneHeightTotal() + 'px';
  const widthPx = Math.max(200, totalDuration() * PX_PER_SEC + 100);
  container.style.width = widthPx + 'px';

  // Reverse order: last array entry (frontmost in compositing) drawn as the top lane.
  const ordered = state.tracks.slice().reverse();
  ordered.forEach((track, displayIdx) => {
    const lane = document.createElement('div');
    lane.className = 'tl-lane' + (track.id === state.activeTrackId ? ' active-lane' : '');
    lane.style.top = (displayIdx * (LANE_HEIGHT + LANE_GAP)) + 'px';
    lane.style.width = widthPx + 'px';
    lane.dataset.trackId = track.id;
    lane.addEventListener('pointerdown', (e) => {
      if (e.target === lane) { state.activeTrackId = track.id; renderTrackControls(); renderTimeline(); }
    });

    const sortedClips = track.clips.slice().sort((a, b) => a.startTime - b.startTime);
    sortedClips.forEach((clip) => {
      const el = document.createElement('div');
      const isText = clip.kind === 'text';
      el.className = 'tl-clip' + (isText ? ' text-clip' : '') + (clip.id === state.selectedClipId ? ' selected' : '');
      el.style.left = (clip.startTime * PX_PER_SEC) + 'px';
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
        if ((clip.effect && clip.effect.type !== 'none') || (clip.mask && clip.mask.type !== 'none') ||
            (clip.chromaKey && clip.chromaKey.enabled) || (clip.blendMode && clip.blendMode !== 'normal') ||
            hasAdjustments(clip)) {
          const badge = document.createElement('div');
          badge.className = 'tl-clip-badge';
          badge.textContent = '✦';
          el.appendChild(badge);
        }
      }

      let leftHandle = null, rightHandle = null;
      if (!isText && clip.type !== 'image') {
        leftHandle = document.createElement('div');
        leftHandle.className = 'tl-handle left';
        rightHandle = document.createElement('div');
        rightHandle.className = 'tl-handle right';
        el.appendChild(leftHandle);
        el.appendChild(rightHandle);
        wireTrimHandle(leftHandle, clip, 'in');
        wireTrimHandle(rightHandle, clip, 'out');
      }

      if (clip.animIn && clip.animIn.type !== 'none') {
        const tBadge = document.createElement('div');
        tBadge.className = 'tl-transition-flag';
        tBadge.textContent = '◐';
        el.appendChild(tBadge);
      }

      wireClipDrag(el, clip, leftHandle, rightHandle);
      lane.appendChild(el);

      // Sibling of the clip (not a child) - .tl-clip clips its own overflow
      // for thumbnail cropping, which would clip this button's negative
      // left offset if it were nested inside.
      const transitionBtn = document.createElement('div');
      transitionBtn.className = 'tl-transition-btn' + (clip.animIn && clip.animIn.type !== 'none' ? ' active' : '');
      transitionBtn.textContent = '+';
      transitionBtn.style.left = (clip.startTime * PX_PER_SEC - 11) + 'px';
      transitionBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      transitionBtn.addEventListener('click', (e) => { e.stopPropagation(); openTransitionSheet(clip); });
      lane.appendChild(transitionBtn);
    });

    container.appendChild(lane);
  });

  document.getElementById('time-readout').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
}

function hasAdjustments(clip) {
  const a = clip.adjustments;
  if (!a) return false;
  return Object.keys(a).some((k) => a[k]);
}

function wireTrimHandle(handleEl, clip, side) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleEl.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const origIn = clip.inPoint;
    const origOut = clip.outPoint;
    const origStart = clip.startTime;
    const onMove = (ev) => {
      const dtSec = (ev.clientX - startX) / PX_PER_SEC;
      if (side === 'in') {
        clip.inPoint = Math.min(origOut - 0.1, Math.max(0, origIn + dtSec));
        clip.startTime = origStart + (clip.inPoint - origIn);
      } else {
        clip.outPoint = Math.max(origIn + 0.1, Math.min(clip.duration, origOut + dtSec));
      }
      renderTimeline();
    };
    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      seekGlobal(clip.startTime);
      persist();
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
  });
}

// Dragging a clip's body moves it: horizontally changes startTime (free
// positioning - clips are allowed to overlap, the later one on the same
// track wins the overlap, same as export), vertically past a lane boundary
// re-parents it onto that track. A short move (tap/jitter) still counts as
// select+seek; only a real drag past a small threshold moves anything.
function wireClipDrag(el, clip, leftHandle, rightHandle) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target === leftHandle || e.target === rightHandle) return;
    if (e.target.classList && e.target.classList.contains('tl-transition-btn')) return;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origStart = clip.startTime;
    const origTrackId = findTrackOfClip(clip.id).id;
    let dragging = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 10) return;
      dragging = true;
      el.classList.add('dragging');
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const onUp = (ev) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.style.transform = '';
      el.classList.remove('dragging');
      if (dragging) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        clip.startTime = Math.max(0, +(origStart + dx / PX_PER_SEC).toFixed(3));

        const laneShift = Math.round(dy / (LANE_HEIGHT + LANE_GAP));
        if (laneShift !== 0) {
          // Lanes are displayed in reverse array order, so moving DOWN on
          // screen means an earlier (lower z) track and vice versa.
          const orderedIds = state.tracks.slice().reverse().map((t) => t.id);
          const curDisplayIdx = orderedIds.indexOf(origTrackId);
          const newDisplayIdx = Math.max(0, Math.min(orderedIds.length - 1, curDisplayIdx + laneShift));
          const newTrackId = orderedIds[newDisplayIdx];
          if (newTrackId !== origTrackId) {
            const oldTrack = state.tracks.find((t) => t.id === origTrackId);
            const newTrack = state.tracks.find((t) => t.id === newTrackId);
            oldTrack.clips.splice(oldTrack.clips.indexOf(clip), 1);
            newTrack.clips.push(clip);
            state.activeTrackId = newTrackId;
          }
        }
        renderTimeline();
        renderTrackControls();
        seekGlobal(state.currentTime);
        persist();
      } else {
        selectClip(clip.id);
        seekGlobal(clip.startTime);
        openPropsSheet(clip);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
}

// ---- transition sheet (the clip's own entry transition - the "+" badge) ----
let transitionSheetClip = null;
function openTransitionSheet(clip) {
  transitionSheetClip = clip;
  const container = document.getElementById('transition-options');
  container.innerHTML = '';
  const currentType = (clip.animIn && clip.animIn.type) || 'none';
  G.TRANSITION_TYPES.forEach(([type, label, icon]) => {
    const btn = document.createElement('button');
    btn.className = 'sheet-option' + (currentType === type ? ' active' : '');
    btn.innerHTML = `<span class="sheet-option-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      const track = findTrackOfClip(clip.id);
      const dur = Number(document.getElementById('transition-duration').value) || 0.6;
      G.setClipTransition(track, clip.id, type, dur);
      closeAllSheets();
      renderTimeline();
      seekGlobal(state.currentTime);
      persist();
    });
    container.appendChild(btn);
  });
  const durRange = document.getElementById('transition-duration');
  durRange.value = (clip.animIn && clip.animIn.duration) || 0.6;
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
  const track = activeTrack();
  const startTime = track.clips.reduce((max, c) => Math.max(max, c.startTime + clipDuration(c)), state.currentTime);
  const clip = makeTextClip(content, color, startTime);
  track.clips.push(clip);
  closeAllSheets();
  showEditor();
  syncPreviewLayers();
  renderTimeline();
  selectClip(clip.id);
  seekGlobal(clip.startTime);
  persist();
}

// ---- effect sheet (from Add, or from the properties panel) ----
function openEffectSheet(clip) {
  if (!clip) { showToast('Select a clip first'); return; }
  const container = document.getElementById('effect-options');
  container.innerHTML = '';
  G.EFFECT_TYPES.forEach(([type, label, icon]) => {
    const btn = document.createElement('button');
    btn.className = 'sheet-option' + (clip.effect.type === type ? ' active' : '');
    btn.innerHTML = `<span class="sheet-option-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      clip.effect.type = type;
      closeAllSheets();
      renderTimeline();
      persist();
      seekGlobal(state.currentTime);
      showToast(`${label} applied`);
    });
    container.appendChild(btn);
  });
  openSheet('effect-sheet');
}

// ---- export settings sheet ----
function openSettingsSheet() {
  document.getElementById('settings-quality').value = state.exportSettings.quality;
  document.getElementById('settings-framerate').value = String(state.exportSettings.framerate);
  document.getElementById('settings-bitrate').value = state.exportSettings.bitrateKbps ? String(state.exportSettings.bitrateKbps) : 'auto';
  openSheet('settings-sheet');
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
function sectionTitle(text) {
  const title = document.createElement('div');
  title.className = 'props-section-title';
  title.textContent = text;
  return title;
}
function renderPropsBody() {
  const body = document.getElementById('props-body');
  body.innerHTML = '';
  if (!propsClip) return;
  const clip = propsClip;

  if (propsActiveTab === 'adjust') {
    const volRange = document.createElement('input');
    volRange.type = 'range'; volRange.min = -30; volRange.max = 12; volRange.step = 1; volRange.value = clip.volume;
    volRange.addEventListener('input', () => { clip.volume = Number(volRange.value); persist(); applyLivePreviewAudio(); });
    body.appendChild(fieldRow(`Volume (${clip.volume}dB)`, volRange));

    const opRange = document.createElement('input');
    opRange.type = 'range'; opRange.min = 0; opRange.max = 1; opRange.step = 0.05; opRange.value = clip.opacity == null ? 1 : clip.opacity;
    opRange.addEventListener('input', () => { clip.opacity = Number(opRange.value); persist(); seekGlobal(state.currentTime); });
    body.appendChild(fieldRow('Opacity', opRange));

    body.appendChild(sectionTitle('Adjust'));
    clip.adjustments = clip.adjustments || {};
    G.ADJUSTMENT_FIELDS.forEach(([key, label, min, max]) => {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = min; inp.max = max; inp.step = 1; inp.value = clip.adjustments[key] || 0;
      inp.addEventListener('input', () => { clip.adjustments[key] = Number(inp.value); persist(); renderTimeline(); });
      body.appendChild(fieldRow(label, inp));
    });

  } else if (propsActiveTab === 'effect') {
    body.appendChild(sectionTitle('Effect'));
    const select = document.createElement('select');
    G.EFFECT_TYPES.forEach(([type, label]) => {
      const opt = document.createElement('option');
      opt.value = type; opt.textContent = label;
      if (clip.effect.type === type) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => { clip.effect.type = select.value; renderTimeline(); persist(); seekGlobal(state.currentTime); });
    body.appendChild(fieldRow('Type', select));

    const amtRange = document.createElement('input');
    amtRange.type = 'range'; amtRange.min = 0; amtRange.max = 100; amtRange.step = 1; amtRange.value = clip.effect.amount;
    amtRange.addEventListener('input', () => { clip.effect.amount = Number(amtRange.value); persist(); });
    body.appendChild(fieldRow('Amount', amtRange));

  } else if (propsActiveTab === 'mask') {
    body.appendChild(sectionTitle('Green Screen'));

    clip.chromaKey = clip.chromaKey || { enabled: false, color: '#00ff00', density: 50, shadows: 50 };
    const ck = clip.chromaKey;

    const ckToggle = document.createElement('input');
    ckToggle.type = 'checkbox'; ckToggle.checked = !!ck.enabled;
    ckToggle.addEventListener('change', () => { ck.enabled = ckToggle.checked; persist(); renderPropsBody(); seekGlobal(state.currentTime); });
    body.appendChild(fieldRow('Enabled', ckToggle));

    if (ck.enabled) {
      const colorInput = document.createElement('input');
      colorInput.type = 'color'; colorInput.value = ck.color || '#00ff00';
      colorInput.addEventListener('input', () => { ck.color = colorInput.value; persist(); });
      body.appendChild(fieldRow('Key Color', colorInput));

      const densityInput = document.createElement('input');
      densityInput.type = 'range'; densityInput.min = 0; densityInput.max = 100; densityInput.step = 1; densityInput.value = ck.density;
      densityInput.addEventListener('input', () => { ck.density = Number(densityInput.value); persist(); });
      body.appendChild(fieldRow('Density', densityInput));

      const shadowsInput = document.createElement('input');
      shadowsInput.type = 'range'; shadowsInput.min = 0; shadowsInput.max = 100; shadowsInput.step = 1; shadowsInput.value = ck.shadows;
      shadowsInput.addEventListener('input', () => { ck.shadows = Number(shadowsInput.value); persist(); });
      body.appendChild(fieldRow('Shadows', shadowsInput));
    }

    body.appendChild(sectionTitle('Mask'));

    const shapeSelect = document.createElement('select');
    G.MASK_SHAPES.forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = label;
      if (clip.mask.type === v) opt.selected = true;
      shapeSelect.appendChild(opt);
    });
    shapeSelect.addEventListener('change', () => { clip.mask.type = shapeSelect.value; renderTimeline(); persist(); renderPropsBody(); seekGlobal(state.currentTime); });
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

    body.appendChild(sectionTitle('Blend'));
    const blendSelect = document.createElement('select');
    G.BLEND_MODES.forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = label;
      if ((clip.blendMode || 'normal') === v) opt.selected = true;
      blendSelect.appendChild(opt);
    });
    blendSelect.addEventListener('change', () => { clip.blendMode = blendSelect.value; persist(); renderTimeline(); seekGlobal(state.currentTime); });
    body.appendChild(fieldRow('Blend Mode', blendSelect));
  }
}

// ---- split / delete ----
function splitSelectedAtPlayhead() {
  const clip = findClip(state.selectedClipId);
  if (!clip || clip.kind !== 'media') { showToast('Select a media clip first'); return; }
  const track = findTrackOfClip(clip.id);
  const localTime = clip.inPoint + (state.currentTime - clip.startTime);
  if (localTime <= clip.inPoint + 0.05 || localTime >= clip.outPoint - 0.05) {
    showToast('Move the playhead inside the clip first');
    return;
  }
  const second = Object.assign({}, clip, {
    id: uid(), inPoint: localTime, startTime: clip.startTime + (localTime - clip.inPoint),
    effect: Object.assign({}, clip.effect), mask: Object.assign({}, clip.mask),
    chromaKey: Object.assign({}, clip.chromaKey), adjustments: Object.assign({}, clip.adjustments),
    animIn: { type: 'none', duration: 0.6 },
  });
  clip.outPoint = localTime;
  track.clips.push(second);
  renderTimeline();
  seekGlobal(state.currentTime);
  persist();
}

function deleteSelected() {
  if (!state.selectedClipId) return;
  const track = findTrackOfClip(state.selectedClipId);
  if (!track) return;
  const idx = track.clips.findIndex((c) => c.id === state.selectedClipId);
  if (idx === -1) return;
  track.clips.splice(idx, 1);
  state.selectedClipId = null;
  renderTimeline();
  seekGlobal(state.currentTime);
  persist();
  if (state.tracks.every((t) => t.clips.length === 0)) {
    document.getElementById('home-screen').classList.remove('hidden');
    document.getElementById('editor-screen').classList.add('hidden');
  }
}

// ---- preview: one layered DOM element set per track, stacked by z-order ----
function cssBlendMode(mode) {
  const map = {
    normal: 'normal', screen: 'screen', multiply: 'multiply', overlay: 'overlay',
    darken: 'darken', lighten: 'lighten', difference: 'difference', addition: 'plus-lighter',
  };
  return map[mode] || 'normal';
}

function syncPreviewLayers() {
  ensureTracks();
  const wrap = document.getElementById('preview-layers');
  // Rebuild layer pool to match tracks (cheap enough - only happens on
  // track add/remove/import, not per frame).
  wrap.innerHTML = '';
  state._layers = {};
  state.tracks.forEach((track) => {
    const layer = document.createElement('div');
    layer.className = 'preview-layer';
    const video = document.createElement('video');
    video.className = 'hidden'; video.playsinline = true;
    const img = document.createElement('img');
    img.className = 'hidden';
    const text = document.createElement('div');
    text.className = 'hidden preview-text';
    layer.appendChild(video); layer.appendChild(img); layer.appendChild(text);
    wrap.appendChild(layer);
    state._layers[track.id] = { layer, video, img, text, activeVideoPath: null };
  });
}

function clipAtTrackTime(track, t) {
  let found = null;
  for (const c of track.clips) {
    const d = clipDuration(c);
    if (t >= c.startTime && t < c.startTime + d) {
      if (!found || c.startTime >= found.startTime) found = c;
    }
  }
  return found;
}

function applyLivePreviewAudio() {
  for (const track of state.tracks) {
    const L = state._layers[track.id];
    if (!L) continue;
    const clip = clipAtTrackTime(track, state.currentTime);
    if (clip && clip.kind === 'media' && clip.type === 'video') {
      const linear = Math.pow(10, (clip.volume || 0) / 20);
      L.video.volume = Math.max(0, Math.min(1, track.muted ? 0 : linear));
    }
  }
}

function seekGlobal(t) {
  ensureTracks();
  state.currentTime = Math.max(0, Math.min(Math.max(totalDuration(), 0.01), t));
  let anyClip = false;

  state.tracks.forEach((track) => {
    const L = state._layers[track.id];
    if (!L) return;
    const clip = track.muted ? null : clipAtTrackTime(track, state.currentTime);
    L.layer.style.mixBlendMode = clip ? cssBlendMode(clip.blendMode) : 'normal';
    L.layer.style.opacity = clip && clip.opacity != null ? clip.opacity : 1;

    if (clip) anyClip = true;

    if (clip && clip.kind === 'media' && clip.type === 'video') {
      const localOffset = state.currentTime - clip.startTime;
      const srcTime = clip.inPoint + Math.max(0, localOffset);
      L.video.classList.remove('hidden'); L.img.classList.add('hidden'); L.text.classList.add('hidden');
      if (L.activeVideoPath !== clip.path) { L.video.src = toFileSrc(clip.path); L.activeVideoPath = clip.path; }
      if (Math.abs(L.video.currentTime - srcTime) > 0.15) {
        try { L.video.currentTime = srcTime; } catch (e) {}
      }
    } else if (clip && clip.kind === 'media' && clip.type === 'image') {
      L.video.classList.add('hidden'); if (!L.video.paused) L.video.pause();
      L.img.classList.remove('hidden'); L.text.classList.add('hidden');
      L.img.src = toFileSrc(clip.path);
    } else if (clip && clip.kind === 'text') {
      L.video.classList.add('hidden'); if (!L.video.paused) L.video.pause();
      L.img.classList.add('hidden'); L.text.classList.remove('hidden');
      L.text.textContent = clip.text.content;
      L.text.style.color = clip.text.color || '#ffffff';
    } else {
      L.video.classList.add('hidden'); if (!L.video.paused) L.video.pause();
      L.img.classList.add('hidden'); L.text.classList.add('hidden');
    }
  });

  document.getElementById('no-clip-hint').classList.toggle('hidden', anyClip);
  applyLivePreviewAudio();

  state._programmaticScroll = true;
  document.getElementById('timeline-scroll').scrollLeft = state.currentTime * PX_PER_SEC;
  document.getElementById('time-readout').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
}

let rafId = null;
let wallStart = 0, timeStart = 0;
function play() {
  ensureTracks();
  if (state.isPlaying || state.tracks.every((t) => t.clips.length === 0)) return;
  state.isPlaying = true;
  document.getElementById('btn-playpause').textContent = '⏸';
  document.getElementById('btn-playpause').classList.add('playing');
  wallStart = performance.now();
  timeStart = state.currentTime;
  Object.values(state._layers).forEach((L) => { if (!L.video.classList.contains('hidden')) L.video.play().catch(() => {}); });
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
  Object.values(state._layers || {}).forEach((L) => L.video.pause());
}

function wireTimelineScrub() {
  const scrollEl = document.getElementById('timeline-scroll');
  scrollEl.addEventListener('scroll', () => {
    if (state._programmaticScroll) { state._programmaticScroll = false; return; }
    if (state.isPlaying) pause();
    const t = scrollEl.scrollLeft / PX_PER_SEC;
    seekGlobal(t);
  });
}

// ---- export ----
function validateClipsForExport() {
  const allClips = state.tracks.flatMap((t) => t.clips);
  if (allClips.length === 0) return 'Add at least one clip first';
  for (const c of allClips) {
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
      args = G.buildFilterGraph(state, outputPath).args;
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
  syncPreviewLayers();
  if (restore()) {
    showEditor();
    syncPreviewLayers();
    renderTrackControls();
    renderTimeline();
    seekGlobal(0);
  }

  Native().getSystemFontPath().then((res) => { if (res && res.path) state.fontPath = res.path; }).catch(() => {});

  document.getElementById('btn-import-home').addEventListener('click', importClips);
  document.getElementById('tool-add').addEventListener('click', openAddSheet);
  document.getElementById('tool-split').addEventListener('click', splitSelectedAtPlayhead);
  document.getElementById('tool-delete').addEventListener('click', deleteSelected);
  document.getElementById('tool-transition').addEventListener('click', () => {
    const clip = findClip(state.selectedClipId);
    if (!clip) { showToast('Select a clip first'); return; }
    openTransitionSheet(clip);
  });
  document.getElementById('tool-settings').addEventListener('click', openSettingsSheet);
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

  // Transition sheet duration slider
  document.getElementById('transition-duration').addEventListener('change', (e) => {
    if (!transitionSheetClip) return;
    const track = findTrackOfClip(transitionSheetClip.id);
    const type = (transitionSheetClip.animIn && transitionSheetClip.animIn.type) || 'none';
    if (type === 'none') return;
    G.setClipTransition(track, transitionSheetClip.id, type, Number(e.target.value));
    renderTimeline();
    seekGlobal(state.currentTime);
    persist();
  });

  // Text sheet
  document.getElementById('text-sheet-add').addEventListener('click', submitTextSheet);

  // Settings sheet
  document.getElementById('settings-quality').addEventListener('change', (e) => { state.exportSettings.quality = e.target.value; persist(); });
  document.getElementById('settings-framerate').addEventListener('change', (e) => { state.exportSettings.framerate = Number(e.target.value); persist(); });
  document.getElementById('settings-bitrate').addEventListener('change', (e) => {
    state.exportSettings.bitrateKbps = e.target.value === 'auto' ? null : Number(e.target.value);
    persist();
  });
  document.getElementById('settings-done-btn').addEventListener('click', closeAllSheets);

  // Properties sheet tabs
  document.querySelectorAll('.props-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      propsActiveTab = btn.dataset.tab;
      renderPropsTabs();
      renderPropsBody();
    });
  });

  wireTimelineScrub();
  renderTrackControls();
  renderTimeline();
});
