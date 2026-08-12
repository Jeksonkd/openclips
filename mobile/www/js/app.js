// OpenClips mobile - a scoped-down CapCut-style companion editor.
// State is intentionally much simpler than the desktop app: one linear
// sequence of clips (no multi-track compositing), trim per clip, an
// optional fade transition between adjacent clips, export via ffmpeg-kit.

const state = {
  clips: [], // {id, path, name, duration, width, height, inPoint, outPoint, thumbPath, transitionAfter: 'none'|'fade'}
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  activeVideoPath: null,
};

const FADE_DUR = 0.5;
const PX_PER_SEC = 44;

function uid() { return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function Native() { return window.Capacitor.Plugins.OpenClipsNative; }
function toFileSrc(path) { return window.Capacitor.convertFileSrc(path); }
function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function clipDuration(c) { return Math.max(0.05, c.outPoint - c.inPoint); }
function totalDuration() { return state.clips.reduce((sum, c) => sum + clipDuration(c), 0); }

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ---- screens ----
function showEditor() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
}

// ---- import ----
async function importClips() {
  let result;
  try {
    result = await Native().pickVideos();
  } catch (e) {
    showToast('Import failed: ' + e.message);
    return;
  }
  const picked = (result && result.clips) || [];
  if (picked.length === 0) return;
  for (const c of picked) {
    state.clips.push({
      id: uid(),
      path: c.path,
      name: c.name,
      duration: c.duration,
      width: c.width,
      height: c.height,
      inPoint: 0,
      outPoint: c.duration,
      thumbPath: null,
      transitionAfter: 'none',
    });
  }
  showEditor();
  renderTimeline();
  if (!state.selectedClipId && state.clips.length) selectClip(state.clips[0].id);
  seekGlobal(0);
  for (const c of picked) generateThumbFor(c.path);
}

async function generateThumbFor(path) {
  try {
    const res = await Native().generateThumbnail({ path, atSeconds: 0.1 });
    const clip = state.clips.find((c) => c.path === path);
    if (clip && res && res.path) {
      clip.thumbPath = res.path;
      renderTimeline();
    }
  } catch (e) { /* thumbnail is cosmetic only */ }
}

// ---- selection ----
function selectClip(id) {
  state.selectedClipId = id;
  renderTimeline();
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
    el.className = 'tl-clip' + (clip.id === state.selectedClipId ? ' selected' : '');
    el.style.width = Math.max(20, clipDuration(clip) * PX_PER_SEC) + 'px';
    if (clip.thumbPath) el.style.backgroundImage = `url("${toFileSrc(clip.thumbPath)}")`;
    el.dataset.clipId = clip.id;

    const name = document.createElement('div');
    name.className = 'tl-clip-name';
    name.textContent = clip.name;
    el.appendChild(name);

    const leftHandle = document.createElement('div');
    leftHandle.className = 'tl-handle left';
    const rightHandle = document.createElement('div');
    rightHandle.className = 'tl-handle right';
    el.appendChild(leftHandle);
    el.appendChild(rightHandle);

    el.addEventListener('click', (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      selectClip(clip.id);
      seekGlobal(clipStartTime(clip.id));
    });
    wireTrimHandle(leftHandle, clip, 'in');
    wireTrimHandle(rightHandle, clip, 'out');

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
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
  });
}

// ---- transition sheet ----
let transitionSheetClip = null;
function openTransitionSheet(clip) {
  transitionSheetClip = clip;
  document.querySelectorAll('.sheet-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === clip.transitionAfter);
  });
  document.getElementById('sheet-backdrop').classList.remove('hidden');
  document.getElementById('transition-sheet').classList.remove('hidden');
}
function closeTransitionSheet() {
  document.getElementById('sheet-backdrop').classList.add('hidden');
  document.getElementById('transition-sheet').classList.add('hidden');
  transitionSheetClip = null;
}

// ---- split / delete ----
function splitSelectedAtPlayhead() {
  const clip = findClip(state.selectedClipId);
  if (!clip) return;
  const localTime = clip.inPoint + (state.currentTime - clipStartTime(clip.id));
  if (localTime <= clip.inPoint + 0.05 || localTime >= clip.outPoint - 0.05) {
    showToast('Move the playhead inside the clip first');
    return;
  }
  const second = Object.assign({}, clip, { id: uid(), inPoint: localTime, transitionAfter: clip.transitionAfter });
  clip.outPoint = localTime;
  clip.transitionAfter = 'none';
  const idx = clipIndex(clip.id);
  state.clips.splice(idx + 1, 0, second);
  renderTimeline();
}

function deleteSelected() {
  if (!state.selectedClipId) return;
  const idx = clipIndex(state.selectedClipId);
  if (idx === -1) return;
  state.clips.splice(idx, 1);
  state.selectedClipId = state.clips.length ? state.clips[Math.min(idx, state.clips.length - 1)].id : null;
  renderTimeline();
  seekGlobal(state.currentTime);
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
  if (found) {
    const { clip, localOffset } = found;
    const srcTime = clip.inPoint + Math.max(0, localOffset);
    if (state.activeVideoPath !== clip.path) {
      videoEl.src = toFileSrc(clip.path);
      state.activeVideoPath = clip.path;
    }
    if (Math.abs(videoEl.currentTime - srcTime) > 0.15) {
      try { videoEl.currentTime = srcTime; } catch (e) {}
    }
  }
  document.getElementById('timeline-scroll').scrollLeft = state.currentTime * PX_PER_SEC;
  document.getElementById('time-readout').textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
}

let rafId = null;
let wallStart = 0, timeStart = 0;
function play() {
  if (state.isPlaying || state.clips.length === 0) return;
  state.isPlaying = true;
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
  document.getElementById('btn-playpause').classList.remove('playing');
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  videoEl.pause();
}

// ---- export ----
function clampFadeDur(a, b) {
  return Math.max(0.05, Math.min(FADE_DUR, clipDuration(a) * 0.4, clipDuration(b) * 0.4));
}

function buildExportArgs(outputPath) {
  const clips = state.clips;
  const first = clips[0];
  const W = first.width && first.width > 0 ? first.width : 1080;
  const H = first.height && first.height > 0 ? first.height : 1920;

  const args = ['-y'];
  clips.forEach((c) => { args.push('-i', c.path); });

  const filterParts = [];
  const mapLabels = [];
  clips.forEach((c, i) => {
    const dur = clipDuration(c);
    let vChain = `[${i}:v]trim=start=${c.inPoint.toFixed(3)}:end=${c.outPoint.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30`;
    let aChain = `[${i}:a]atrim=start=${c.inPoint.toFixed(3)}:end=${c.outPoint.toFixed(3)},asetpts=PTS-STARTPTS`;

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

    filterParts.push(`${vChain}[v${i}]`);
    filterParts.push(`${aChain}[a${i}]`);
    mapLabels.push(`[v${i}][a${i}]`);
  });
  filterParts.push(`${mapLabels.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[outv]', '-map', '[outa]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(outputPath);
  return args;
}

async function exportProject() {
  if (state.clips.length === 0) return;
  const modal = document.getElementById('export-modal');
  const statusEl = document.getElementById('export-status');
  const fillEl = document.getElementById('export-progress-fill');
  const doneBtn = document.getElementById('export-done-btn');
  doneBtn.classList.add('hidden');
  statusEl.textContent = 'Exporting…';
  fillEl.style.width = '0%';
  modal.classList.remove('hidden');

  const totalMs = totalDuration() * 1000;
  const listenerHandle = await Native().addListener('exportProgress', (data) => {
    const pct = totalMs > 0 ? Math.min(100, (data.timeMs / totalMs) * 100) : 0;
    fillEl.style.width = pct.toFixed(1) + '%';
  });

  const paths = await Native().getPaths();
  const outputPath = `${paths.exportDir}openclips_export_${Date.now()}.mp4`;
  const args = buildExportArgs(outputPath);

  try {
    const result = await Native().exportVideo({ args });
    if (!result.success) {
      statusEl.textContent = 'Export failed.';
      console.error('ffmpeg log:', result.log);
      showToast('Export failed - see log');
      doneBtn.classList.remove('hidden');
      doneBtn.onclick = () => modal.classList.add('hidden');
      return;
    }
    statusEl.textContent = 'Saving to gallery…';
    const saved = await Native().saveToGallery({ path: outputPath, displayName: `OpenClips_${Date.now()}.mp4` });
    statusEl.textContent = 'Saved to Movies/OpenClips';
    fillEl.style.width = '100%';
    doneBtn.classList.remove('hidden');
    doneBtn.onclick = () => modal.classList.add('hidden');
  } catch (e) {
    statusEl.textContent = 'Export failed: ' + e.message;
    doneBtn.classList.remove('hidden');
    doneBtn.onclick = () => modal.classList.add('hidden');
  } finally {
    listenerHandle.remove();
  }
}

// ---- wiring ----
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-import-home').addEventListener('click', importClips);
  document.getElementById('tool-add').addEventListener('click', importClips);
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

  document.getElementById('sheet-backdrop').addEventListener('click', closeTransitionSheet);
  document.querySelectorAll('.sheet-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (transitionSheetClip) transitionSheetClip.transitionAfter = btn.dataset.type;
      closeTransitionSheet();
      renderTimeline();
    });
  });

  document.getElementById('timeline-scroll').addEventListener('scroll', (e) => {
    if (state.isPlaying) return;
  });

  renderTimeline();
});
