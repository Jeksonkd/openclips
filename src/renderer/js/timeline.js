// Multi-track timeline: zoom/scroll, drag-drop from the asset bin, clip
// drag/trim, split, ripple delete, snapping, and a keyframe lane for the
// selected clip. Rendered as plain DOM (positioned absolutely inside each
// track lane) rather than canvas, since native drag/drop + resize handles
// are far simpler to wire up against real elements.

const TRACK_HEAD_W = 130;
const SNAP_PX = 8;
// Set right before a resize-triggered renderTimeline() so the freshly-built
// element for that clip can play a brief "settled" glow animation - the old
// dragged element gets destroyed by the rebuild, so the class has to be
// re-applied to its replacement rather than just toggled on el directly.
let justResizedClipId = null;

const waveformCache = new Map(); // mediaId -> Float32Array peaks (0..1, per bucket)
let audioCtxForPeaks = null;

async function getWaveformPeaks(media) {
  if (waveformCache.has(media.id)) return waveformCache.get(media.id);
  waveformCache.set(media.id, null); // mark in-flight
  try {
    audioCtxForPeaks ||= new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(window.engine.toMediaUrl(media.path));
    const buf = await res.arrayBuffer();
    const audioBuf = await audioCtxForPeaks.decodeAudioData(buf);
    const ch = audioBuf.getChannelData(0);
    const buckets = 1000;
    const peaks = new Float32Array(buckets);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step;
      for (let j = start; j < Math.min(ch.length, start + step); j++) max = Math.max(max, Math.abs(ch[j]));
      peaks[i] = max;
    }
    waveformCache.set(media.id, peaks);
    renderTimeline();
    return peaks;
  } catch (e) {
    waveformCache.set(media.id, new Float32Array(0));
    return waveformCache.get(media.id);
  }
}

function pxPerSec() { return project.timeline.zoomLevel; }
function timeToPx(t) { return t * pxPerSec(); }
function pxToTime(px) { return Math.max(0, px / pxPerSec()); }
// Unlike pxToTime, this does NOT clamp to 0 - it converts a relative mouse-
// movement delta (which is legitimately negative when dragging left/backwards)
// into a time delta. Using pxToTime for deltas was the bug that made
// dragging/trimming backwards a no-op: any negative dx got floored to 0.
function pxToTimeDelta(px) { return px / pxPerSec(); }

function trackTypeLabel(type) {
  return { video: 'Video', audio: 'Audio', overlay: 'Overlay', adjustment: 'Adjust' }[type] || type;
}

function renderRuler() {
  const ruler = document.getElementById('timeline-ruler');
  ruler.innerHTML = '';
  ruler.style.marginLeft = TRACK_HEAD_W + 'px';
  const duration = Math.max(30, project.projectDuration() + 15);
  const totalWidth = timeToPx(duration);
  ruler.style.width = totalWidth + 'px';

  let step = 1;
  const pps = pxPerSec();
  if (pps < 20) step = 10; else if (pps < 40) step = 5; else if (pps < 90) step = 2; else if (pps > 220) step = 0.5;

  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement('div');
    tick.className = 'timeline-ruler-tick';
    tick.style.left = timeToPx(t) + 'px';
    const mm = Math.floor(t / 60);
    const ss = (t % 60).toFixed(step < 1 ? 1 : 0).padStart(step < 1 ? 4 : 2, '0');
    tick.textContent = `${mm}:${ss}`;
    ruler.appendChild(tick);
  }
}

const EFFECT_LABELS = {
  blur: 'Blur', pixelate: 'Pixelate', bw: 'Black & White', invert: 'Invert', mirror: 'Mirror',
  vflip: 'Flip V', sepia: 'Sepia', hueRotate: 'Hue Shift', vintage: 'Vintage', crossProcess: 'Cross Process',
  rgbSplit: 'RGB Split', edgeDetect: 'Edge Detect', emboss: 'Emboss',
};

function clipPixelClass(clip, media) {
  if (clip.kind === 'text') return 'text';
  if (clip.kind === 'adjustment') return 'adjustment';
  if (clip.kind === 'effect') return 'effect';
  if (clip.kind === 'draw') return 'draw';
  return media && media.type === 'audio' ? 'audio' : 'video';
}

function clipLabel(clip, media) {
  if (clip.kind === 'text') return `Text: ${(clip.text && clip.text.content) || ''}`.slice(0, 40);
  if (clip.kind === 'adjustment') return 'Adjustment Layer';
  if (clip.kind === 'draw') return `Drawing (${(clip.draw && clip.draw.strokes.length) || 0} strokes)`;
  if (clip.kind === 'effect') {
    const name = EFFECT_LABELS[(clip.effect && clip.effect.type) || 'blur'];
    const n = (clip.effectTargets && clip.effectTargets.length) || 0;
    return `${name} (${n ? `${n} clip${n > 1 ? 's' : ''}` : 'All'})`;
  }
  return media ? media.name : '(missing media)';
}

const KF_EASING_CHOICES = [['linear', 'None'], ['ease-in', 'Ease In'], ['ease-out', 'Ease Out'], ['bezier', 'Ease In-Out']];

function closeKeyframePopup() {
  const existing = document.querySelector('.kf-popup-menu');
  if (existing) existing.remove();
}

// Several properties can each have a keyframe at the same timestamp (e.g.
// positionX and positionY both keyframed together), so a dot represents
// every keyframe at that moment, not just one - the popup lists each with
// its own easing choice and delete button.
function openKeyframePopup(dotEl, clip, kfs) {
  closeKeyframePopup();
  const menu = document.createElement('div');
  menu.className = 'kf-popup-menu';
  const rect = dotEl.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.top - 8) + 'px';
  menu.style.transform = 'translateY(-100%)';

  kfs.forEach((kf) => {
    const row = document.createElement('div');
    row.className = 'kf-popup-row';

    const propLabel = document.createElement('div');
    propLabel.className = 'kf-popup-prop';
    propLabel.textContent = `${kf.property} @ ${kf.timestamp.toFixed(2)}s`;
    row.appendChild(propLabel);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'kf-popup-controls';
    const select = document.createElement('select');
    KF_EASING_CHOICES.forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = label;
      if ((kf.easing || 'linear') === v) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      kf.easing = select.value;
      if (window.previewEngine) window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
    });
    controlsRow.appendChild(select);

    const delBtn = document.createElement('button');
    delBtn.className = 'kf-popup-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete this keyframe';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      KF.removeNear(clip, kf.property, kf.timestamp, 0.001);
      closeKeyframePopup();
      renderTimeline();
      if (window.renderInspector) window.renderInspector();
      if (window.previewEngine) window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
    });
    controlsRow.appendChild(delBtn);

    row.appendChild(controlsRow);
    menu.appendChild(row);
  });

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('mousedown', function onDocClick(e) {
      if (!menu.contains(e.target)) {
        closeKeyframePopup();
        document.removeEventListener('mousedown', onDocClick);
      }
    });
  }, 0);
}

function appendKeyframeLane(el, clip) {
  const existing = el.querySelector('.clip-kf-lane');
  if (existing) existing.remove();
  const kfLane = document.createElement('div');
  kfLane.className = 'clip-kf-lane';
  const byTime = new Map();
  for (const kf of clip.keyframes) {
    const key = kf.timestamp.toFixed(3);
    if (!byTime.has(key)) byTime.set(key, []);
    byTime.get(key).push(kf);
  }
  for (const kfs of byTime.values()) {
    const dot = document.createElement('div');
    dot.className = 'clip-kf-dot';
    dot.style.left = timeToPx(kfs[0].timestamp) + 'px';
    dot.title = kfs.map((k) => `${k.property} @ ${k.timestamp.toFixed(2)}s (click to edit)`).join(', ');
    dot.addEventListener('mousedown', (e) => e.stopPropagation());
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      openKeyframePopup(dot, clip, kfs);
    });
    kfLane.appendChild(dot);
  }
  el.appendChild(kfLane);
}

// Selection only needs a class toggle + the keyframe lane on the newly
// selected clip - NOT a full renderTimeline() rebuild. This matters a lot in
// practice: the clip mousedown handler calls selectClip() to select-on-drag,
// and if that rebuilt the DOM, the element the drag closure is holding onto
// would be destroyed mid-drag - so the clip wouldn't visibly move until the
// next full render (on mouseup), i.e. it would appear to "teleport" instead
// of dragging smoothly.
function updateSelectionVisuals() {
  document.querySelectorAll('.clip').forEach((el) => {
    const isSelected = el.dataset.clipId === project.selectedClipId;
    el.classList.toggle('selected', isSelected);
    const existingLane = el.querySelector('.clip-kf-lane');
    if (isSelected) {
      const found = project.findClip(el.dataset.clipId);
      if (found) appendKeyframeLane(el, found.clip);
    } else if (existingLane) {
      existingLane.remove();
    }
  });
}

function buildClipEl(clip, track) {
  const media = clip.kind === 'media' ? project.media[clip.mediaId] : null;
  const dur = project.clipDisplayDuration(clip);
  const el = document.createElement('div');
  el.className = 'clip animated ' + clipPixelClass(clip, media);
  if (clip.id === project.selectedClipId) el.classList.add('selected');
  if (clip.id === justResizedClipId) { el.classList.add('resize-pop'); justResizedClipId = null; }
  el.style.left = timeToPx(clip.startTime) + 'px';
  el.style.width = Math.max(4, timeToPx(dur)) + 'px';
  el.dataset.clipId = clip.id;
  el.dataset.trackId = track.id;

  const label = document.createElement('div');
  label.className = 'clip-label';
  label.textContent = clipLabel(clip, media);
  el.appendChild(label);

  if (clip.kind === 'media' && media && media.type !== 'audio' && media.thumbPath) {
    const strip = document.createElement('div');
    strip.className = 'clip-thumb-strip';
    strip.style.backgroundImage = `url("${window.engine.toMediaUrl(media.thumbPath)}")`;
    strip.style.backgroundSize = 'auto 100%';
    el.appendChild(strip);
  }

  if (clip.kind === 'media' && media && media.type === 'audio') {
    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'clip-waveform';
    el.appendChild(waveCanvas);
    const peaks = waveformCache.get(media.id);
    if (peaks === undefined) getWaveformPeaks(media);
    else if (peaks && peaks.length) drawWaveform(waveCanvas, peaks, media, clip);
  }

  if (clip.id === project.selectedClipId) appendKeyframeLane(el, clip);

  const leftHandle = document.createElement('div');
  leftHandle.className = 'clip-handle left';
  const rightHandle = document.createElement('div');
  rightHandle.className = 'clip-handle right';
  el.appendChild(leftHandle);
  el.appendChild(rightHandle);

  attachClipInteractions(el, leftHandle, rightHandle);
  return el;
}

function drawWaveform(canvas, peaks, media, clip) {
  requestAnimationFrame(() => {
    const w = canvas.clientWidth || Math.max(4, timeToPx(project.clipDisplayDuration(clip)));
    const h = 48;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const startFrac = clip.inPoint / media.duration;
    const endFrac = clip.outPoint / media.duration;
    for (let x = 0; x < w; x++) {
      const frac = startFrac + (endFrac - startFrac) * (x / w);
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)));
      const v = peaks[idx] || 0;
      const barH = Math.max(1, v * h * 0.9);
      ctx.fillRect(x, (h - barH) / 2, 1, barH);
    }
  });
}

// Only types that genuinely need per-pixel/spatial-mask math (not just plain
// position/scale/opacity keyframes) belong here - fade is the one exception,
// kept because it's the universal baseline. Slide/zoom were dropped since
// they're just a position/scale ramp, i.e. already buildable by hand with
// ordinary keyframes on a clip's Transform tab.
const TRANSITION_TYPES = [
  { type: 'fade', label: 'Fade / Mix', icon: '◐' },
  { type: 'wipe', label: 'Wipe', icon: '◧' },
  { type: 'iris', label: 'Iris', icon: '◯' },
  { type: 'dissolve', label: 'Dissolve', icon: '▦' },
  { type: 'blinds', label: 'Blinds', icon: '▤' },
  { type: 'clock', label: 'Clock Wipe', icon: '◔' },
];
const DEFAULT_TRANSITION_DURATION = 0.6;

function transitionIcon(type) {
  const found = TRANSITION_TYPES.find((t) => t.type === type);
  return found ? found.icon : '+';
}

function closeTransitionMenu() {
  const existing = document.querySelector('.transition-picker-menu');
  if (existing) existing.remove();
}

// Small floating picker anchored under the clicked marker button - lists the
// transition types plus a Remove option when one is already applied.
function openTransitionPicker(anchorBtn, track, prev, next, currentType) {
  closeTransitionMenu();
  const menu = document.createElement('div');
  menu.className = 'transition-picker-menu';
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';

  TRANSITION_TYPES.forEach((tt) => {
    const item = document.createElement('button');
    item.className = 'transition-picker-item' + (currentType === tt.type ? ' active' : '');
    item.textContent = `${tt.icon} ${tt.label}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      project.applyTransition(track.id, prev.id, next.id, tt.type, DEFAULT_TRANSITION_DURATION);
      closeTransitionMenu();
    });
    menu.appendChild(item);
  });

  if (currentType) {
    const removeItem = document.createElement('button');
    removeItem.className = 'transition-picker-item remove';
    removeItem.textContent = '✕ Remove Transition';
    removeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      project.removeTransition(next.id);
      closeTransitionMenu();
    });
    menu.appendChild(removeItem);
  }

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('mousedown', function onDocClick(e) {
      if (!menu.contains(e.target)) {
        closeTransitionMenu();
        document.removeEventListener('mousedown', onDocClick);
      }
    });
  }, 0);
}

// Renders a small "+"/icon marker at the boundary between every pair of
// adjacent clips on a track (or the overlap zone of an already-linked pair),
// clicking it opens the transition-type picker.
function renderTransitionMarkers(lane, track) {
  const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i];
    const next = sorted[i + 1];
    // Transitions (wipe/iris/dissolve masks, mask-free fade) only make sense
    // between actual media clips - text uses a separate ASS render path that
    // doesn't support the mask mechanism, and adjustment/effect clips aren't
    // "cut between" in the first place.
    if (prev.kind !== 'media' || next.kind !== 'media') continue;
    const prevEnd = prev.startTime + project.clipDisplayDuration(prev);
    const gap = next.startTime - prevEnd;
    const hasTransition = !!(next.transitionIn && next.transitionIn.withClipId === prev.id);
    if (!hasTransition && Math.abs(gap) > 0.05) continue;

    const centerTime = (prevEnd + next.startTime) / 2;
    const btn = document.createElement('div');
    btn.className = 'transition-marker' + (hasTransition ? ' active' : '');
    btn.style.left = timeToPx(centerTime) + 'px';
    btn.textContent = hasTransition ? transitionIcon(next.transitionIn.type) : '+';
    btn.title = hasTransition
      ? `Transition: ${next.transitionIn.type} (${next.transitionIn.duration.toFixed(2)}s) — click to change`
      : 'Add transition';
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTransitionPicker(btn, track, prev, next, hasTransition ? next.transitionIn.type : null);
    });
    lane.appendChild(btn);
  }
}

function collectSnapPoints(excludeClipId) {
  const points = [0, project.timeline.currentTime];
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      points.push(clip.startTime);
      points.push(clip.startTime + project.clipDisplayDuration(clip));
    }
  }
  return points;
}

function snapTime(t, excludeClipId) {
  const points = collectSnapPoints(excludeClipId);
  const tolerance = SNAP_PX / pxPerSec();
  for (const p of points) {
    if (Math.abs(p - t) <= tolerance) return p;
  }
  return t;
}

function attachClipInteractions(el, leftHandle, rightHandle) {
  el.addEventListener('mousedown', (e) => {
    if (e.target === leftHandle || e.target === rightHandle) return;
    e.stopPropagation();
    selectClip(el.dataset.clipId);
    const clipId = el.dataset.clipId;
    const startX = e.clientX;
    const found = project.findClip(clipId);
    if (!found) return;
    const origStart = found.clip.startTime;
    const origTrackId = found.track.id;
    let targetTrackId = origTrackId;
    let moved = false;
    el.classList.add('dragging');

    // Which track row the pointer is currently over, so a clip can be
    // dropped onto a different track - clamped to the first/last row if
    // dragged above/below the whole track list rather than losing the drag.
    function trackIdAtY(clientY) {
      const container = document.getElementById('timeline-tracks');
      const rows = Array.from(container.children);
      if (rows.length === 0) return origTrackId;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientY >= rect.top && clientY < rect.bottom) {
          const lane = row.querySelector('.track-lane');
          return lane ? lane.dataset.trackId : origTrackId;
        }
      }
      const firstRect = rows[0].getBoundingClientRect();
      if (clientY < firstRect.top) return rows[0].querySelector('.track-lane').dataset.trackId;
      return rows[rows.length - 1].querySelector('.track-lane').dataset.trackId;
    }

    function onMove(ev) {
      moved = true;
      const dx = ev.clientX - startX;
      let newStart = Math.max(0, origStart + pxToTimeDelta(dx));
      newStart = snapTime(newStart, clipId);
      found.clip.startTime = newStart;
      el.style.left = timeToPx(newStart) + 'px';

      const overTrackId = trackIdAtY(ev.clientY);
      if (overTrackId && overTrackId !== targetTrackId) {
        targetTrackId = overTrackId;
        const newLane = document.querySelector(`.track-lane[data-track-id="${targetTrackId}"]`);
        if (newLane) newLane.appendChild(el);
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('dragging');
      if (moved) {
        if (targetTrackId !== origTrackId) {
          project.moveClipToTrack(clipId, targetTrackId);
        } else {
          found.track.clips.sort((a, b) => a.startTime - b.startTime);
          project.emit('tracks:changed');
        }
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  leftHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const clipId = el.dataset.clipId;
    const startX = e.clientX;
    const found = project.findClip(clipId);
    if (!found) return;
    const { clip } = found;
    const mult = (clip.speed && clip.speed.multiplier) || 1;
    const origIn = clip.inPoint;
    const origStart = clip.startTime;
    el.classList.add('dragging', 'resizing');

    function onMove(ev) {
      const dxTime = pxToTimeDelta(ev.clientX - startX);
      const maxDelta = project.clipDisplayDuration(clip) * mult - 0.05;
      const deltaSourceTime = Math.max(-origIn, Math.min(maxDelta, dxTime * mult));
      clip.inPoint = origIn + deltaSourceTime;
      clip.startTime = origStart + deltaSourceTime / mult;
      el.style.left = timeToPx(clip.startTime) + 'px';
      el.style.width = Math.max(4, timeToPx(project.clipDisplayDuration(clip))) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('dragging', 'resizing');
      justResizedClipId = clipId;
      renderTimeline();
      project.emit('tracks:changed');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  rightHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const clipId = el.dataset.clipId;
    const startX = e.clientX;
    const found = project.findClip(clipId);
    if (!found) return;
    const { clip } = found;
    const mult = (clip.speed && clip.speed.multiplier) || 1;
    const origOut = clip.outPoint;
    // No cap at the source's real duration: images have no natural length
    // limit to begin with, and dragging a video/audio clip past its own
    // duration now loops the source instead of being blocked.
    const maxOut = origOut + 9999;
    el.classList.add('dragging', 'resizing');

    function onMove(ev) {
      const dxTime = pxToTimeDelta(ev.clientX - startX);
      let newOut = origOut + dxTime * mult;
      newOut = Math.max(clip.inPoint + 0.05, Math.min(maxOut, newOut));
      clip.outPoint = newOut;
      el.style.width = Math.max(4, timeToPx(project.clipDisplayDuration(clip))) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('dragging', 'resizing');
      justResizedClipId = clipId;
      renderTimeline();
      project.emit('tracks:changed');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function targetTrackForNewClip() {
  if (project.timeline.tracks.length === 0) return project.addTrack();
  return project.timeline.tracks[project.timeline.tracks.length - 1];
}

function setKeyframeAllTransform() {
  const found = project.selectedClip();
  if (!found) return;
  const { clip } = found;
  const localTime = project.timeline.currentTime - clip.startTime;
  const dur = project.clipDisplayDuration(clip);
  if (localTime < 0 || localTime > dur) return;
  const staticValues = {
    positionX: clip.transform.positionX, positionY: clip.transform.positionY,
    scale: clip.transform.scale, rotation: clip.transform.rotation, opacity: clip.transform.opacity,
  };
  Object.keys(staticValues).forEach((prop) => {
    const current = KF.sample(clip, prop, localTime, staticValues[prop]);
    KF.add(clip, prop, localTime, current);
  });
  renderTimeline();
  if (window.renderInspector) window.renderInspector();
}

function selectClip(clipId) {
  project.selectedClipId = clipId;
  project.emit('selection:changed');
}

function renderTracks() {
  const container = document.getElementById('timeline-tracks');
  container.innerHTML = '';
  project.timeline.tracks.forEach((track) => {
    const row = document.createElement('div');
    row.className = 'track-row';

    const head = document.createElement('div');
    head.className = 'track-head';
    const label = document.createElement('span');
    label.textContent = track.name;
    label.style.flex = '1';
    head.appendChild(label);

    const muteBtn = document.createElement('button');
    muteBtn.textContent = track.muted ? '🔇' : '🔊';
    muteBtn.title = 'Mute/unmute this track';
    muteBtn.addEventListener('click', () => { track.muted = !track.muted; project.emit('tracks:changed'); });
    head.appendChild(muteBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      project.timeline.tracks = project.timeline.tracks.filter((t) => t.id !== track.id);
      project.emit('tracks:changed');
    });
    head.appendChild(delBtn);

    row.appendChild(head);

    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.trackId = track.id;
    lane.style.minWidth = timeToPx(Math.max(30, project.projectDuration() + 15)) + 'px';

    track.clips.forEach((clip) => lane.appendChild(buildClipEl(clip, track)));
    renderTransitionMarkers(lane, track);

    lane.addEventListener('mousedown', (e) => {
      if (e.target === lane) {
        const rect = lane.getBoundingClientRect();
        window.previewEngine.seek(pxToTime(e.clientX - rect.left));
        project.selectedClipId = null;
        project.emit('selection:changed');
      }
    });

    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop-hover'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop-hover'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('drop-hover');
      const mediaId = e.dataTransfer.getData('application/x-openclips-media');
      if (!mediaId) return;
      const draggedMedia = project.media[mediaId];
      if (!draggedMedia) return;
      const rect = lane.getBoundingClientRect();
      let startTime = pxToTime(e.clientX - rect.left);
      startTime = snapTime(startTime, null);
      const clip = project.addClipToTrack(track.id, mediaId, startTime);
      if (clip) selectClip(clip.id);
    });

    row.appendChild(lane);
    container.appendChild(row);
  });
}

function updatePlayhead() {
  const ph = document.getElementById('timeline-playhead');
  ph.style.left = TRACK_HEAD_W + timeToPx(project.timeline.currentTime) + 'px';
  const dur = project.projectDuration();
  const t = project.timeline.currentTime;
  document.getElementById('time-readout').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  const scrub = document.getElementById('scrub');
  if (!scrub._dragging) scrub.value = dur > 0 ? Math.round((t / dur) * 1000) : 0;
}

function fmtTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function renderTimeline() {
  renderRuler();
  renderTracks();
  updatePlayhead();
}

function setupTimeline() {
  project.on('tracks:changed', renderTimeline);
  project.on('selection:changed', updateSelectionVisuals);
  project.on('time:changed', updatePlayhead);

  document.getElementById('tl-zoom').addEventListener('input', (e) => {
    project.timeline.zoomLevel = Number(e.target.value);
    renderTimeline();
  });

  document.getElementById('tl-split').addEventListener('click', () => {
    if (project.selectedClipId) {
      project.splitClipAt(project.selectedClipId, project.timeline.currentTime);
    }
  });
  document.getElementById('tl-delete').addEventListener('click', () => {
    if (project.selectedClipId) project.deleteClip(project.selectedClipId, true);
  });
  document.getElementById('tl-add-track').addEventListener('click', () => {
    project.addTrack();
  });
  document.getElementById('tl-add-text').addEventListener('click', () => {
    const track = targetTrackForNewClip();
    const clip = project.addTextClip(track.id, project.timeline.currentTime, 5);
    if (clip) selectClip(clip.id);
  });
  document.getElementById('tl-add-adjustment').addEventListener('click', () => {
    const track = targetTrackForNewClip();
    const clip = project.addAdjustmentClip(track.id, project.timeline.currentTime, 5);
    if (clip) selectClip(clip.id);
  });
  document.getElementById('tl-add-effect').addEventListener('click', () => {
    const track = targetTrackForNewClip();
    const clip = project.addEffectClip(track.id, project.timeline.currentTime, 3);
    if (clip) selectClip(clip.id);
  });
  document.getElementById('tl-set-keyframe').addEventListener('click', setKeyframeAllTransform);

  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) window.History.redo(); else window.History.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      window.History.redo();
      return;
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && project.selectedClipId) {
      project.deleteClip(project.selectedClipId, true);
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (project.isPlaying) window.previewEngine.pause(); else window.previewEngine.play();
    } else if (e.key === 's' && project.selectedClipId) {
      project.splitClipAt(project.selectedClipId, project.timeline.currentTime);
    }
  });

  renderTimeline();
}

window.setupTimeline = setupTimeline;
window.renderTimeline = renderTimeline;
window.selectClip = selectClip;
window.fmtTime = fmtTime;
window.targetTrackForNewClip = targetTrackForNewClip;
