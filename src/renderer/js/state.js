// Central project state + pub/sub bus. Kept dependency-free (no framework)
// so the whole renderer runs as plain <script> tags.

let uidCounter = 1;
function uid(prefix) { return `${prefix}_${(uidCounter++).toString(36)}_${Date.now().toString(36)}`; }

function defaultAdjustments() {
  return {
    brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temperature: 0, tint: 0, saturation: 0, vibrance: 0,
    sharpen: 0, clarity: 0, dehaze: 0, vignette: 0, grain: 0,
    hsl: { red: [0,0,0], orange: [0,0,0], yellow: [0,0,0], green: [0,0,0], cyan: [0,0,0], blue: [0,0,0], purple: [0,0,0], magenta: [0,0,0] },
    curves: { luma: [[0,0],[255,255]], red: [[0,0],[255,255]], green: [[0,0],[255,255]], blue: [[0,0],[255,255]] },
    wheels: { shadows: [0,0], midtones: [0,0], highlights: [0,0] },
  };
}

function defaultTextProps() {
  return {
    content: 'Text', fontFamily: 'Sans', fontSize: 64, color: '#ffffff', align: 'center',
    bgEnabled: false, bgColor: '#000000', bgOpacity: 0.6,
  };
}

function makeClip(mediaId, opts) {
  return Object.assign({
    id: uid('clip'),
    kind: 'media', // 'media' | 'text' | 'adjustment'
    mediaId,
    startTime: 0,
    inPoint: 0,
    outPoint: 1,
    volume: 0,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    transform: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, blendMode: 'normal' },
    speed: { multiplier: 1, curve: null },
    adjustments: defaultAdjustments(),
    keyframes: [],
    // Declarative in/out animation presets (independent of the keyframe
    // system): {type: 'none'|'fade'|'slide'|'zoom', duration}. Also reused
    // by transitions - adding a transition sets animIn on the incoming clip
    // and animOut on the outgoing one, see ProjectState.applyTransition.
    animIn: { type: 'none', duration: 0.5 },
    animOut: { type: 'none', duration: 0.5 },
    // Set on the incoming clip when a transition links it to the previous
    // clip on the same track: {type, duration, withClipId}. Purely metadata
    // for the timeline UI/removal - the actual visual effect comes from
    // animIn/animOut + fadeIn/fadeOut above.
    transitionIn: null,
    // Only meaningful for kind:'effect' clips: {type: 'blur'|'pixelate'|
    // 'bw'|'invert'|'mirror', amount: 0-100}. effectTargets empty means the
    // effect applies to everything below it (like an adjustment layer);
    // non-empty restricts it to just those clip ids.
    effect: { type: 'blur', amount: 50 },
    effectTargets: [],
    // Static clip mask (media clips only): restricts visibility to a
    // rect/ellipse region. pos/size are fractions (0-1) of the clip's own
    // rendered frame, not canvas pixels.
    mask: { type: 'none', posX: 0.5, posY: 0.5, sizeX: 0.3, sizeY: 0.3, invert: false },
    // Green screen (Mask & Blend tab). density -> chromakey's "similarity"
    // (how wide a color range is keyed out), shadows -> "blend" (how
    // gradually that range's edge fades) - see exportGraph.js's
    // buildChromaKeyFilter for the exact mapping and why.
    chromaKey: { enabled: false, color: '#00ff00', density: 50, shadows: 50 },
  }, opts || {});
}

function makeTrack(name) {
  return { id: uid('track'), name, muted: false, clips: [] };
}

class ProjectState {
  constructor() {
    this.media = {}; // mediaId -> {id, path, name, type, duration, width, height, fps, hasAudio, hasVideo, thumbPath}
    this.timeline = {
      currentTime: 0,
      zoomLevel: 80, // px per second
      tracks: [1, 2, 3, 4, 5].map((n) => makeTrack(`Track ${n}`)),
    };
    this.canvas = { width: 1280, height: 720, fps: 30 };
    // quality maps to a CRF value; bitrateKbps null means "auto" (use the
    // quality/CRF setting instead of an explicit bitrate).
    this.exportSettings = { quality: 'high', framerate: 30, bitrateKbps: null };
    this.selectedClipId = null;
    this.isPlaying = false;
    this._listeners = {};
  }

  on(evt, fn) { (this._listeners[evt] ||= []).push(fn); return () => this.off(evt, fn); }
  off(evt, fn) { this._listeners[evt] = (this._listeners[evt] || []).filter((f) => f !== fn); }
  emit(evt, payload) { (this._listeners[evt] || []).slice().forEach((f) => f(payload)); }

  addMedia(item) { this.media[item.id] = item; this.emit('media:changed'); }

  findTrack(trackId) { return this.timeline.tracks.find((t) => t.id === trackId); }

  findClip(clipId) {
    for (const track of this.timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  selectedClip() { return this.selectedClipId ? this.findClip(this.selectedClipId) : null; }

  addTrack(name) {
    const track = makeTrack(name || `Track ${this.timeline.tracks.length + 1}`);
    this.timeline.tracks.push(track);
    this.emit('tracks:changed');
    return track;
  }

  addAdjustmentClip(trackId, startTime, duration) {
    const track = this.findTrack(trackId);
    if (!track) return null;
    const clip = makeClip(null, { kind: 'adjustment', startTime, inPoint: 0, outPoint: duration || 5 });
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
    return clip;
  }

  addTextClip(trackId, startTime, duration) {
    const track = this.findTrack(trackId);
    if (!track) return null;
    const clip = makeClip(null, { kind: 'text', startTime, inPoint: 0, outPoint: duration || 5, text: defaultTextProps() });
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
    return clip;
  }

  addEffectClip(trackId, startTime, duration) {
    const track = this.findTrack(trackId);
    if (!track) return null;
    const clip = makeClip(null, { kind: 'effect', startTime, inPoint: 0, outPoint: duration || 3 });
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
    return clip;
  }

  addClipToTrack(trackId, mediaId, startTime) {
    const track = this.findTrack(trackId);
    const media = this.media[mediaId];
    if (!track || !media) return null;
    const clip = makeClip(mediaId, {
      startTime,
      inPoint: 0,
      outPoint: media.type === 'image' ? 5 : media.duration,
    });
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
    return clip;
  }

  // Reparents a clip onto a different track (drag-to-retarget on the
  // timeline), preserving its startTime/timing.
  moveClipToTrack(clipId, targetTrackId) {
    const found = this.findClip(clipId);
    if (!found) return;
    const { clip, track } = found;
    if (track.id === targetTrackId) return;
    const newTrack = this.findTrack(targetTrackId);
    if (!newTrack) return;
    track.clips = track.clips.filter((c) => c.id !== clipId);
    newTrack.clips.push(clip);
    newTrack.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
  }

  clipDisplayDuration(clip) {
    const mult = (clip.speed && clip.speed.multiplier) || 1;
    return Math.max(0.0417, (clip.outPoint - clip.inPoint) / mult);
  }

  projectDuration() {
    let max = 0;
    for (const track of this.timeline.tracks) {
      for (const clip of track.clips) max = Math.max(max, clip.startTime + this.clipDisplayDuration(clip));
    }
    return max;
  }

  splitClipAt(clipId, absoluteTime) {
    const found = this.findClip(clipId);
    if (!found) return;
    const { clip, track } = found;
    const dur = this.clipDisplayDuration(clip);
    const localTime = absoluteTime - clip.startTime;
    if (localTime <= 0.02 || localTime >= dur - 0.02) return;
    const mult = (clip.speed && clip.speed.multiplier) || 1;
    const splitSourceOffset = localTime * mult;

    const second = JSON.parse(JSON.stringify(clip));
    second.id = uid('clip');
    second.startTime = clip.startTime + localTime;
    second.inPoint = clip.inPoint + splitSourceOffset;
    second.keyframes = clip.keyframes
      .filter((k) => k.timestamp >= localTime)
      .map((k) => ({ ...k, timestamp: k.timestamp - localTime }));

    clip.outPoint = clip.inPoint + splitSourceOffset;
    clip.keyframes = clip.keyframes.filter((k) => k.timestamp <= localTime);

    track.clips.push(second);
    track.clips.sort((a, b) => a.startTime - b.startTime);
    this.emit('tracks:changed');
  }

  // Links `nextClip` to `prevClip` with a transition: shifts nextClip (and
  // everything after it on the same track) `duration` seconds earlier so it
  // overlaps prevClip's tail, and sets animOut/animIn on the pair so the
  // shared compositor (preview + export) renders the actual blend - a
  // transition is just an auto-applied clip animation plus a timeline shift.
  applyTransition(trackId, prevClipId, nextClipId, type, duration) {
    const track = this.findTrack(trackId);
    if (!track) return;
    const prev = track.clips.find((c) => c.id === prevClipId);
    const next = track.clips.find((c) => c.id === nextClipId);
    if (!prev || !next) return;
    const prevDur = this.clipDisplayDuration(prev);
    const nextDur = this.clipDisplayDuration(next);
    const d = Math.max(0.1, Math.min(duration, prevDur * 0.9, nextDur * 0.9));
    const cutPoint = prev.startTime + prevDur;
    const desiredNextStart = cutPoint - d;
    const delta = next.startTime - desiredNextStart;

    track.clips.sort((a, b) => a.startTime - b.startTime);
    const idx = track.clips.indexOf(next);
    for (let i = idx; i < track.clips.length; i++) track.clips[i].startTime -= delta;

    next.animIn = { type, duration: d };
    next.transitionIn = { type, duration: d, withClipId: prev.id };
    // fade is a plain scalar opacity ramp, so applying it to both sides
    // still blends cleanly (alpha compositing has no "holes"). wipe/iris/
    // dissolve/blinds/clock are hard per-pixel masks though - applying the
    // same mask to BOTH clips would leave any pixel where neither mask has
    // "arrived yet" showing bare black background instead of either clip.
    // So for those, only the incoming clip carries the mask; the outgoing
    // one stays fully opaque and just gets progressively covered by it.
    const MASK_TRANSITION_TYPES = ['wipe', 'iris', 'dissolve', 'blinds', 'clock'];
    prev.animOut = MASK_TRANSITION_TYPES.includes(type)
      ? { type: 'none', duration: 0.5 }
      : { type, duration: d };
    next.fadeIn = Math.max(next.fadeIn || 0, d);
    prev.fadeOut = Math.max(prev.fadeOut || 0, d);
    this.emit('tracks:changed');
  }

  removeTransition(nextClipId) {
    const found = this.findClip(nextClipId);
    if (!found) return;
    const { clip: next, track } = found;
    const info = next.transitionIn;
    if (!info) return;
    const prev = track.clips.find((c) => c.id === info.withClipId);
    const d = info.duration;

    track.clips.sort((a, b) => a.startTime - b.startTime);
    const idx = track.clips.indexOf(next);
    for (let i = idx; i < track.clips.length; i++) track.clips[i].startTime += d;

    next.transitionIn = null;
    next.animIn = { type: 'none', duration: 0.5 };
    next.fadeIn = 0;
    if (prev) {
      prev.animOut = { type: 'none', duration: 0.5 };
      prev.fadeOut = 0;
    }
    this.emit('tracks:changed');
  }

  deleteClip(clipId, ripple) {
    const found = this.findClip(clipId);
    if (!found) return;
    const { clip, track } = found;
    const dur = this.clipDisplayDuration(clip);
    track.clips = track.clips.filter((c) => c.id !== clipId);
    if (ripple) {
      for (const c of track.clips) {
        if (c.startTime > clip.startTime) c.startTime -= dur;
      }
    }
    if (this.selectedClipId === clipId) this.selectedClipId = null;
    this.emit('tracks:changed');
    this.emit('selection:changed');
  }

  toJSON() {
    return {
      media: this.media,
      timeline: this.timeline,
      canvas: this.canvas,
      exportSettings: this.exportSettings,
    };
  }

  loadFromJSON(data) {
    this.media = data.media || {};
    this.timeline = data.timeline || { currentTime: 0, zoomLevel: 80, tracks: [] };
    this.canvas = data.canvas || { width: 1280, height: 720, fps: 30 };
    this.exportSettings = data.exportSettings || { quality: 'high', framerate: 30, bitrateKbps: null };
    this.selectedClipId = null;
    this.emit('media:changed');
    this.emit('tracks:changed');
    this.emit('selection:changed');
  }
}

const project = new ProjectState();
window.project = project;
window.uid = uid;
window.defaultAdjustments = defaultAdjustments;
