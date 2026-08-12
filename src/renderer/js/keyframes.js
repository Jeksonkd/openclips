// Keyframe engine: add/remove/sample. A Clip owns a flat `keyframes` array
// (schema: {timestamp, property, value, easing}); timestamp is seconds
// relative to the clip's own start (post-speed timeline seconds), matching
// how the export filter-graph builder interprets it.

const Easing = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  bezier: (t) => t * t * (3 - 2 * t), // smoothstep approximation of a custom bezier
};

const KF = {
  listFor(clip, property) {
    return clip.keyframes.filter((k) => k.property === property).sort((a, b) => a.timestamp - b.timestamp);
  },

  hasAny(clip, property) {
    return clip.keyframes.some((k) => k.property === property);
  },

  add(clip, property, timestamp, value, easing) {
    timestamp = Math.max(0, timestamp);
    const existing = clip.keyframes.find((k) => k.property === property && Math.abs(k.timestamp - timestamp) < 0.008);
    if (existing) { existing.value = value; return existing; }
    const kf = { timestamp, property, value, easing: easing || 'linear' };
    clip.keyframes.push(kf);
    return kf;
  },

  removeNear(clip, property, timestamp, tolerance) {
    tolerance = tolerance ?? 0.05;
    clip.keyframes = clip.keyframes.filter((k) => !(k.property === property && Math.abs(k.timestamp - timestamp) <= tolerance));
  },

  removeAllForProperty(clip, property) {
    clip.keyframes = clip.keyframes.filter((k) => k.property !== property);
  },

  // Sample the animated value of `property` at local clip time `t` (seconds).
  // `staticValue` is used when the property has no keyframes at all.
  sample(clip, property, t, staticValue) {
    const list = KF.listFor(clip, property);
    if (list.length === 0) return staticValue;
    if (list.length === 1) return list[0].value;
    if (t <= list[0].timestamp) return list[0].value;
    if (t >= list[list.length - 1].timestamp) return list[list.length - 1].value;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (t >= a.timestamp && t <= b.timestamp) {
        const span = Math.max(1e-6, b.timestamp - a.timestamp);
        const p = Easing[a.easing || 'linear']((t - a.timestamp) / span);
        return a.value + (b.value - a.value) * p;
      }
    }
    return staticValue;
  },
};

window.KF = KF;
