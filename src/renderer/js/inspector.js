// Context-aware property panel. Rebuilds the active tab's contents whenever
// selection/tab changes; lightweight value-only refreshes are wired to
// `time:changed` so animated (keyframed) fields track the scrubbing playhead.

let activeTab = 'transform';
let selectedHslBand = 'red';
let selectedCurveChannel = 'luma';
const refreshers = [];

function localTimeFor(clip) { return project.timeline.currentTime - clip.startTime; }

function rerenderPreviewNow() {
  window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
}

function makeField(container, opts) {
  // opts: {label, min, max, step, animatable, property, getStatic, setStatic, clip, digits}
  const { label, min, max, step, animatable, property, getStatic, setStatic, clip } = opts;
  const digits = opts.digits ?? 1;
  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);

  let kfBtn = null;
  if (animatable) {
    kfBtn = document.createElement('button');
    kfBtn.className = 'kf-btn';
    kfBtn.textContent = '◆';
    kfBtn.title = 'Toggle keyframing for this property';
    row.appendChild(kfBtn);
  }

  const range = document.createElement('input');
  range.type = 'range'; range.min = min; range.max = max; range.step = step;
  const num = document.createElement('input');
  num.type = 'number'; num.min = min; num.max = max; num.step = step;
  row.appendChild(range);
  row.appendChild(num);
  container.appendChild(row);

  function currentValue() {
    if (animatable) return KF.sample(clip, property, localTimeFor(clip), getStatic());
    return getStatic();
  }
  function refresh() {
    const v = currentValue();
    range.value = v;
    num.value = Number(v.toFixed(digits));
    if (kfBtn) kfBtn.classList.toggle('active', KF.hasAny(clip, property));
  }
  function commit(v) {
    v = Math.max(min, Math.min(max, v));
    if (animatable && KF.hasAny(clip, property)) KF.add(clip, property, localTimeFor(clip), v);
    else setStatic(v);
    refresh();
    renderTimeline();
    rerenderPreviewNow();
    if (window.canvasOverlay) window.canvasOverlay.update();
  }
  range.addEventListener('input', () => commit(Number(range.value)));
  num.addEventListener('change', () => commit(Number(num.value)));
  if (kfBtn) {
    kfBtn.addEventListener('click', () => {
      if (KF.hasAny(clip, property)) {
        const v = currentValue();
        KF.removeAllForProperty(clip, property);
        setStatic(v);
      } else {
        KF.add(clip, property, localTimeFor(clip), currentValue());
      }
      refresh();
      renderTimeline();
    });
  }
  refresh();
  refreshers.push(refresh);
  return { row, refresh };
}

function sectionTitle(container, text) {
  const h = document.createElement('div');
  h.className = 'section-title';
  h.textContent = text;
  container.appendChild(h);
}

function buildTransformPane(container, clip) {
  sectionTitle(container, 'Position & Scale');
  makeField(container, { label: 'Position X', min: -1000, max: 1000, step: 1, animatable: true, property: 'positionX', clip, getStatic: () => clip.transform.positionX, setStatic: (v) => (clip.transform.positionX = v) });
  makeField(container, { label: 'Position Y', min: -1000, max: 1000, step: 1, animatable: true, property: 'positionY', clip, getStatic: () => clip.transform.positionY, setStatic: (v) => (clip.transform.positionY = v) });
  makeField(container, { label: 'Scale', min: 0.05, max: 5, step: 0.01, digits: 2, animatable: true, property: 'scale', clip, getStatic: () => clip.transform.scale, setStatic: (v) => (clip.transform.scale = v) });
  makeField(container, { label: 'Rotation', min: -180, max: 180, step: 1, animatable: true, property: 'rotation', clip, getStatic: () => clip.transform.rotation, setStatic: (v) => (clip.transform.rotation = v) });
}

const BLEND_MODE_CHOICES = ['normal', 'screen', 'multiply', 'overlay', 'darken', 'lighten', 'difference', 'addition'];

function buildBlendMaskPane(container, clip) {
  sectionTitle(container, 'Opacity');
  makeField(container, { label: 'Opacity', min: 0, max: 1, step: 0.01, digits: 2, animatable: true, property: 'opacity', clip, getStatic: () => clip.transform.opacity, setStatic: (v) => (clip.transform.opacity = v) });

  sectionTitle(container, 'Blend Mode');
  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = 'Mode';
  row.appendChild(lab);
  const select = document.createElement('select');
  BLEND_MODE_CHOICES.forEach((m) => {
    const opt = document.createElement('option'); opt.value = m; opt.textContent = m[0].toUpperCase() + m.slice(1);
    if (clip.transform.blendMode === m) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => { clip.transform.blendMode = select.value; rerenderPreviewNow(); });
  row.appendChild(select);
  container.appendChild(row);

  const note = document.createElement('div');
  note.className = 'section-title';
  note.style.textTransform = 'none';
  note.style.opacity = '0.7';
  note.textContent = 'Non-"Normal" blend modes combined with keyframed position/scale fall back to Normal on export.';
  container.appendChild(note);

  // Masks (rect/ellipse crop) only apply to media clips - text/adjustment/
  // effect clips don't go through the per-pixel geq mask path in export.
  if (clip.kind !== 'media') return;
  clip.mask = clip.mask || { type: 'none', posX: 0.5, posY: 0.5, sizeX: 0.3, sizeY: 0.3, invert: false };
  const m = clip.mask;

  sectionTitle(container, 'Mask');
  const shapeRow = document.createElement('div');
  shapeRow.className = 'field-row';
  const shapeLabel = document.createElement('label');
  shapeLabel.textContent = 'Shape';
  shapeRow.appendChild(shapeLabel);
  const shapeSelect = document.createElement('select');
  [['none', 'None'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['diamond', 'Diamond'], ['triangle', 'Triangle'], ['star', 'Star']].forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if (m.type === v) opt.selected = true;
    shapeSelect.appendChild(opt);
  });
  shapeRow.appendChild(shapeSelect);
  container.appendChild(shapeRow);

  const posXField = makeField(container, { label: 'Position X', min: 0, max: 1, step: 0.01, digits: 2, animatable: true, property: 'mask_posX', clip, getStatic: () => m.posX, setStatic: (v) => { m.posX = v; } });
  const posYField = makeField(container, { label: 'Position Y', min: 0, max: 1, step: 0.01, digits: 2, animatable: true, property: 'mask_posY', clip, getStatic: () => m.posY, setStatic: (v) => { m.posY = v; } });
  const sizeXField = makeField(container, { label: 'Size X', min: 0.02, max: 1, step: 0.01, digits: 2, animatable: true, property: 'mask_sizeX', clip, getStatic: () => m.sizeX, setStatic: (v) => { m.sizeX = v; } });
  const sizeYField = makeField(container, { label: 'Size Y', min: 0.02, max: 1, step: 0.01, digits: 2, animatable: true, property: 'mask_sizeY', clip, getStatic: () => m.sizeY, setStatic: (v) => { m.sizeY = v; } });

  const invertRow = document.createElement('div');
  invertRow.className = 'field-row';
  const invertLabel = document.createElement('label');
  invertLabel.textContent = 'Invert';
  invertRow.appendChild(invertLabel);
  const invertCb = document.createElement('input');
  invertCb.type = 'checkbox';
  invertCb.checked = !!m.invert;
  invertRow.appendChild(invertCb);
  container.appendChild(invertRow);

  function syncMaskFieldsEnabled() {
    const on = m.type !== 'none';
    [posXField, posYField, sizeXField, sizeYField].forEach((f) => { f.row.style.opacity = on ? '1' : '0.45'; });
    invertRow.style.opacity = on ? '1' : '0.45';
  }
  shapeSelect.addEventListener('change', () => { m.type = shapeSelect.value; syncMaskFieldsEnabled(); rerenderPreviewNow(); });
  invertCb.addEventListener('change', () => { m.invert = invertCb.checked; rerenderPreviewNow(); });
  syncMaskFieldsEnabled();
}

const FONT_CHOICES = ['Sans', 'Serif', 'Monospace', 'Arial', 'Georgia', 'Verdana', 'Times New Roman', 'Impact', 'Comic Sans MS'];

function buildTextPane(container, clip) {
  clip.text = clip.text || { content: 'Text', fontFamily: 'Sans', fontSize: 64, color: '#ffffff', align: 'center' };
  const t = clip.text;

  sectionTitle(container, 'Content');
  const contentRow = document.createElement('div');
  contentRow.className = 'field-row';
  const textarea = document.createElement('textarea');
  textarea.value = t.content;
  textarea.rows = 3;
  textarea.style.flex = '1';
  textarea.style.resize = 'vertical';
  textarea.style.background = 'var(--bg-2)';
  textarea.style.color = 'var(--text-0)';
  textarea.style.border = '1px solid var(--line)';
  textarea.style.borderRadius = '4px';
  textarea.style.padding = '6px';
  textarea.addEventListener('input', () => { t.content = textarea.value; renderTimeline(); rerenderPreviewNow(); });
  contentRow.appendChild(textarea);
  container.appendChild(contentRow);

  sectionTitle(container, 'Font');
  const fontRow = document.createElement('div');
  fontRow.className = 'field-row';
  const fontLabel = document.createElement('label');
  fontLabel.textContent = 'Family';
  fontRow.appendChild(fontLabel);
  const fontSelect = document.createElement('select');
  FONT_CHOICES.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f;
    if (t.fontFamily === f) opt.selected = true;
    fontSelect.appendChild(opt);
  });
  fontSelect.addEventListener('change', () => { t.fontFamily = fontSelect.value; rerenderPreviewNow(); });
  fontRow.appendChild(fontSelect);
  container.appendChild(fontRow);

  makeField(container, { label: 'Size', min: 8, max: 400, step: 1, animatable: false, property: 'fontSize', clip, getStatic: () => t.fontSize, setStatic: (v) => { t.fontSize = v; } });

  const colorRow = document.createElement('div');
  colorRow.className = 'field-row';
  const colorLabel = document.createElement('label');
  colorLabel.textContent = 'Color';
  colorRow.appendChild(colorLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = t.color;
  colorInput.addEventListener('input', () => { t.color = colorInput.value; rerenderPreviewNow(); });
  colorRow.appendChild(colorInput);
  container.appendChild(colorRow);

  const alignRow = document.createElement('div');
  alignRow.className = 'field-row';
  const alignLabel = document.createElement('label');
  alignLabel.textContent = 'Align';
  alignRow.appendChild(alignLabel);
  const alignSelect = document.createElement('select');
  ['left', 'center', 'right'].forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a; opt.textContent = a[0].toUpperCase() + a.slice(1);
    if (t.align === a) opt.selected = true;
    alignSelect.appendChild(opt);
  });
  alignSelect.addEventListener('change', () => { t.align = alignSelect.value; rerenderPreviewNow(); });
  alignRow.appendChild(alignSelect);
  container.appendChild(alignRow);

  sectionTitle(container, 'Background');
  const bgToggleRow = document.createElement('div');
  bgToggleRow.className = 'field-row';
  const bgToggleLabel = document.createElement('label');
  bgToggleLabel.textContent = 'Enabled';
  bgToggleRow.appendChild(bgToggleLabel);
  const bgToggle = document.createElement('input');
  bgToggle.type = 'checkbox';
  bgToggle.checked = !!t.bgEnabled;
  bgToggleRow.appendChild(bgToggle);
  container.appendChild(bgToggleRow);

  const bgColorRow = document.createElement('div');
  bgColorRow.className = 'field-row';
  const bgColorLabel = document.createElement('label');
  bgColorLabel.textContent = 'Box Color';
  bgColorRow.appendChild(bgColorLabel);
  const bgColorInput = document.createElement('input');
  bgColorInput.type = 'color';
  bgColorInput.value = t.bgColor || '#000000';
  bgColorInput.addEventListener('input', () => { t.bgColor = bgColorInput.value; rerenderPreviewNow(); });
  bgColorRow.appendChild(bgColorInput);
  container.appendChild(bgColorRow);

  const bgOpacityField = makeField(container, {
    label: 'Box Opacity', min: 0, max: 1, step: 0.01, digits: 2, animatable: false, property: 'bgOpacity', clip,
    getStatic: () => (t.bgOpacity == null ? 0.6 : t.bgOpacity), setStatic: (v) => { t.bgOpacity = v; },
  });

  function syncBgFieldsEnabled() {
    const on = !!t.bgEnabled;
    bgColorInput.disabled = !on;
    bgOpacityField.row.style.opacity = on ? '1' : '0.45';
    bgColorRow.style.opacity = on ? '1' : '0.45';
  }
  bgToggle.addEventListener('change', () => { t.bgEnabled = bgToggle.checked; syncBgFieldsEnabled(); rerenderPreviewNow(); });
  syncBgFieldsEnabled();
}

const ANIM_TYPE_CHOICES = [
  ['none', 'None'], ['fade', 'Fade / Mix'], ['slide', 'Slide'], ['zoom', 'Zoom'],
];

function buildAnimateSection(container, clip, key, title) {
  clip[key] = clip[key] || { type: 'none', duration: 0.5 };
  const cfg = clip[key];
  sectionTitle(container, title);

  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = 'Type';
  row.appendChild(lab);
  const select = document.createElement('select');
  ANIM_TYPE_CHOICES.forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if (cfg.type === v) opt.selected = true;
    select.appendChild(opt);
  });
  row.appendChild(select);
  container.appendChild(row);

  const durField = makeField(container, {
    label: 'Duration (s)', min: 0.1, max: 5, step: 0.1, digits: 1, animatable: false, property: `${key}_duration`, clip,
    getStatic: () => cfg.duration, setStatic: (v) => { cfg.duration = v; },
  });

  function syncEnabled() {
    const on = cfg.type !== 'none';
    durField.row.style.opacity = on ? '1' : '0.45';
  }
  select.addEventListener('change', () => {
    cfg.type = select.value;
    // Manual edits here break any transition link to a neighboring clip -
    // it becomes a plain standalone animation from this point on.
    if (clip.transitionIn) clip.transitionIn = null;
    syncEnabled();
    rerenderPreviewNow();
  });
  syncEnabled();
}

function buildAnimatePane(container, clip) {
  buildAnimateSection(container, clip, 'animIn', 'Animate In');
  buildAnimateSection(container, clip, 'animOut', 'Animate Out');
  const note = document.createElement('div');
  note.className = 'section-title';
  note.style.textTransform = 'none';
  note.style.opacity = '0.7';
  note.textContent = 'Transitions between adjacent clips (the + button on the timeline, between two clips) set these automatically.';
  container.appendChild(note);
}

const EFFECT_TYPE_CHOICES = [
  ['blur', 'Blur'], ['pixelate', 'Pixelate'], ['bw', 'Black & White'], ['invert', 'Invert Colors'], ['mirror', 'Mirror (Horizontal)'],
  ['vflip', 'Flip Vertical'], ['sepia', 'Sepia'], ['hueRotate', 'Hue Shift'], ['vintage', 'Vintage'], ['crossProcess', 'Cross Process'],
  ['rgbSplit', 'RGB Split'], ['edgeDetect', 'Edge Detect'], ['emboss', 'Emboss'],
];
const EFFECT_AMOUNT_IGNORED = new Set(['bw', 'invert', 'mirror', 'vflip', 'vintage', 'crossProcess', 'edgeDetect', 'emboss']);

function buildEffectPane(container, clip) {
  clip.effect = clip.effect || { type: 'blur', amount: 50 };
  clip.effectTargets = clip.effectTargets || [];

  sectionTitle(container, 'Effect');
  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = 'Type';
  row.appendChild(lab);
  const select = document.createElement('select');
  EFFECT_TYPE_CHOICES.forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if (clip.effect.type === v) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => { clip.effect.type = select.value; renderTimeline(); renderInspector(); rerenderPreviewNow(); });
  row.appendChild(select);
  container.appendChild(row);

  const amountField = makeField(container, {
    label: 'Amount', min: 0, max: 100, step: 1, animatable: false, property: 'effect_amount', clip,
    getStatic: () => clip.effect.amount, setStatic: (v) => { clip.effect.amount = v; },
  });
  const amountIgnored = EFFECT_AMOUNT_IGNORED.has(clip.effect.type);
  amountField.row.style.opacity = amountIgnored ? '0.45' : '1';
  const amountNote = document.createElement('div');
  amountNote.className = 'section-title';
  amountNote.style.textTransform = 'none';
  amountNote.style.opacity = '0.7';
  amountNote.textContent = amountIgnored
    ? 'This effect has no adjustable strength.'
    : 'Amount controls strength: blur radius, pixel block size, sepia mix, hue rotation degrees, or RGB split distance.';
  container.appendChild(amountNote);

  sectionTitle(container, 'Apply To');
  const scopeRow = document.createElement('div');
  scopeRow.className = 'field-row';
  const scopeLabel = document.createElement('label');
  scopeLabel.textContent = 'Scope';
  scopeRow.appendChild(scopeLabel);
  const scopeSelect = document.createElement('select');
  [['all', 'All Clips Below'], ['specific', 'Specific Clips']].forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if ((clip.effectTargets.length > 0) === (v === 'specific')) opt.selected = true;
    scopeSelect.appendChild(opt);
  });
  scopeRow.appendChild(scopeSelect);
  container.appendChild(scopeRow);

  const targetsList = document.createElement('div');
  targetsList.className = 'effect-targets-list';
  container.appendChild(targetsList);

  function renderTargets() {
    targetsList.innerHTML = '';
    const show = scopeSelect.value === 'specific';
    targetsList.style.display = show ? 'block' : 'none';
    if (!show) return;
    const mediaClips = [];
    project.timeline.tracks.forEach((t) => t.clips.forEach((c) => { if (c.kind === 'media' && c.id !== clip.id) mediaClips.push(c); }));
    if (mediaClips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'section-title';
      empty.style.textTransform = 'none';
      empty.style.opacity = '0.6';
      empty.textContent = 'No media clips in the project yet.';
      targetsList.appendChild(empty);
      return;
    }
    mediaClips.forEach((c) => {
      const media = project.media[c.mediaId];
      const targetRow = document.createElement('label');
      targetRow.className = 'effect-target-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = clip.effectTargets.includes(c.id);
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!clip.effectTargets.includes(c.id)) clip.effectTargets.push(c.id); }
        else { clip.effectTargets = clip.effectTargets.filter((id) => id !== c.id); }
        renderTimeline();
        rerenderPreviewNow();
      });
      targetRow.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = `${media ? media.name : c.id} @ ${c.startTime.toFixed(1)}s`;
      targetRow.appendChild(span);
      targetsList.appendChild(targetRow);
    });
  }
  scopeSelect.addEventListener('change', () => {
    if (scopeSelect.value === 'all') clip.effectTargets = [];
    renderTargets();
    renderTimeline();
    rerenderPreviewNow();
  });
  renderTargets();
}

function buildSpeedPane(container, clip) {
  sectionTitle(container, 'Playback Speed');
  makeField(container, { label: 'Multiplier', min: 0.1, max: 20, step: 0.05, digits: 2, animatable: false, property: 'speed', clip, getStatic: () => clip.speed.multiplier, setStatic: (v) => { clip.speed.multiplier = v; project.emit('tracks:changed'); } });
  const note = document.createElement('div');
  note.className = 'section-title';
  note.style.textTransform = 'none';
  note.style.opacity = '0.7';
  note.textContent = 'Bezier speed ramping (curve field) is stored per-clip but not yet interpolated by the preview/export engine in this build — constant multiplier is used.';
  container.appendChild(note);
}

function buildAudioPane(container, clip) {
  sectionTitle(container, 'Level');
  makeField(container, { label: 'Volume (dB)', min: -60, max: 12, step: 0.5, animatable: true, property: 'volume', clip, getStatic: () => clip.volume, setStatic: (v) => (clip.volume = v) });
  makeField(container, { label: 'Pan', min: -1, max: 1, step: 0.05, digits: 2, animatable: false, property: 'pan', clip, getStatic: () => clip.pan, setStatic: (v) => (clip.pan = v) });

  sectionTitle(container, 'Fades');
  makeField(container, { label: 'Fade In (s)', min: 0, max: 15, step: 0.1, animatable: false, property: 'fadeIn', clip, getStatic: () => clip.fadeIn, setStatic: (v) => (clip.fadeIn = v) });
  makeField(container, { label: 'Fade Out (s)', min: 0, max: 15, step: 0.1, animatable: false, property: 'fadeOut', clip, getStatic: () => clip.fadeOut, setStatic: (v) => (clip.fadeOut = v) });
}

function buildAdjustPane(container, clip) {
  const a = clip.adjustments;
  sectionTitle(container, 'Light & Exposure');
  [['Brightness', 'brightness'], ['Exposure', 'exposure'], ['Contrast', 'contrast'], ['Highlights', 'highlights'], ['Shadows', 'shadows'], ['Whites', 'whites'], ['Blacks', 'blacks']].forEach(([label, key]) => {
    makeField(container, { label, min: -100, max: 100, step: 1, animatable: false, property: key, clip, getStatic: () => a[key], setStatic: (v) => (a[key] = v) });
  });

  sectionTitle(container, 'Color & Tone');
  [['Temperature', 'temperature'], ['Tint', 'tint'], ['Saturation', 'saturation'], ['Vibrance', 'vibrance']].forEach(([label, key]) => {
    makeField(container, { label, min: -100, max: 100, step: 1, animatable: false, property: key, clip, getStatic: () => a[key], setStatic: (v) => (a[key] = v) });
  });
  makeField(container, { label: 'Vignette', min: 0, max: 100, step: 1, animatable: false, property: 'vignette', clip, getStatic: () => a.vignette, setStatic: (v) => (a.vignette = v) });

  sectionTitle(container, 'Detail & Texture');
  [['Sharpen', 'sharpen'], ['Clarity', 'clarity'], ['Dehaze', 'dehaze'], ['Film Grain', 'grain']].forEach(([label, key]) => {
    makeField(container, { label, min: 0, max: 100, step: 1, animatable: false, property: key, clip, getStatic: () => a[key], setStatic: (v) => (a[key] = v) });
  });
}

const HSL_BANDS = [
  ['red', '#e05a4e'], ['orange', '#e08a3c'], ['yellow', '#dccb3c'], ['green', '#5ec25f'],
  ['cyan', '#3cc4c0'], ['blue', '#4a7fe0'], ['purple', '#8a5fe0'], ['magenta', '#d15fc0'],
];

function buildAdvancedPane(container, clip) {
  const a = clip.adjustments;

  sectionTitle(container, 'HSL — 8 Channel');
  const grid = document.createElement('div');
  grid.className = 'hsl-grid';
  HSL_BANDS.forEach(([name, color]) => {
    const sw = document.createElement('div');
    sw.className = 'hsl-swatch';
    sw.style.background = color;
    sw.textContent = name[0].toUpperCase();
    if (name === selectedHslBand) sw.classList.add('active');
    sw.addEventListener('click', () => { selectedHslBand = name; renderInspector(); });
    grid.appendChild(sw);
  });
  container.appendChild(grid);

  const band = a.hsl[selectedHslBand];
  makeField(container, { label: 'Hue', min: -100, max: 100, step: 1, animatable: false, property: 'hsl_h', clip, getStatic: () => band[0], setStatic: (v) => (band[0] = v) });
  makeField(container, { label: 'Saturation', min: -100, max: 100, step: 1, animatable: false, property: 'hsl_s', clip, getStatic: () => band[1], setStatic: (v) => (band[1] = v) });
  makeField(container, { label: 'Luminance', min: -100, max: 100, step: 1, animatable: false, property: 'hsl_l', clip, getStatic: () => band[2], setStatic: (v) => (band[2] = v) });

  sectionTitle(container, 'RGB Curves');
  const chanRow = document.createElement('div');
  chanRow.className = 'curve-channels';
  ['luma', 'red', 'green', 'blue'].forEach((ch) => {
    const btn = document.createElement('button');
    btn.textContent = ch[0].toUpperCase() + ch.slice(1);
    if (ch === selectedCurveChannel) btn.classList.add('active-' + ch);
    btn.addEventListener('click', () => { selectedCurveChannel = ch; renderInspector(); });
    chanRow.appendChild(btn);
  });
  container.appendChild(chanRow);
  const curveCanvas = document.createElement('canvas');
  curveCanvas.className = 'curve-canvas';
  curveCanvas.width = 260; curveCanvas.height = 140;
  container.appendChild(curveCanvas);
  setupCurveEditor(curveCanvas, a.curves[selectedCurveChannel], () => rerenderPreviewNow());

  sectionTitle(container, 'Color Wheels');
  const wheelRow = document.createElement('div');
  wheelRow.className = 'wheel-row';
  [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']].forEach(([key, label]) => {
    const wrap = document.createElement('div');
    wrap.className = 'wheel';
    const pad = document.createElement('div');
    pad.className = 'wheel-pad';
    pad.style.background = 'radial-gradient(circle, #444 0%, #222 70%)';
    const dot = document.createElement('div');
    dot.className = 'wheel-dot';
    pad.appendChild(dot);
    wrap.appendChild(pad);
    const lbl = document.createElement('div');
    lbl.className = 'wheel-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wheelRow.appendChild(wrap);
    setupWheel(pad, dot, a.wheels[key], () => rerenderPreviewNow());
  });
  container.appendChild(wheelRow);
}

function setupWheel(pad, dot, valueArr, onChange) {
  function place() {
    const r = 38;
    dot.style.left = `${50 + valueArr[0] * 50}%`;
    dot.style.top = `${50 + valueArr[1] * 50}%`;
  }
  function setFromEvent(e) {
    const rect = pad.getBoundingClientRect();
    let x = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    let y = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    const mag = Math.hypot(x, y);
    if (mag > 1) { x /= mag; y /= mag; }
    valueArr[0] = x; valueArr[1] = y;
    place();
    onChange();
  }
  pad.addEventListener('mousedown', (e) => {
    setFromEvent(e);
    function onMove(ev) { setFromEvent(ev); }
    function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  place();
}

function setupCurveEditor(canvas, points, onChange) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = 6;

  function toCanvas(pt) { return [pad + (pt[0] / 255) * (W - 2 * pad), (H - pad) - (pt[1] / 255) * (H - 2 * pad)]; }
  function toValue(cx, cy) {
    const x = Math.max(0, Math.min(255, ((cx - pad) / (W - 2 * pad)) * 255));
    const y = Math.max(0, Math.min(255, (((H - pad) - cy) / (H - 2 * pad)) * 255));
    return [x, y];
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#3a3d43';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - 2 * pad);
      const x = pad + (i / 4) * (W - 2 * pad);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, H - pad); ctx.stroke();
    }
    ctx.strokeStyle = '#54575d';
    ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, pad); ctx.stroke();

    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    sorted.forEach((pt, i) => { const [x, y] = toCanvas(pt); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();

    ctx.fillStyle = '#e8e9eb';
    sorted.forEach((pt) => { const [x, y] = toCanvas(pt); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); });
  }

  let dragIdx = -1;
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top) * (H / rect.height);
    let found = -1;
    points.forEach((pt, i) => {
      const [x, y] = toCanvas(pt);
      if (Math.hypot(x - cx, y - cy) < 8) found = i;
    });
    if (e.detail === 2 && found > 0 && found < points.length - 1) {
      points.splice(found, 1);
      draw(); onChange();
      return;
    }
    if (found === -1) {
      points.push(toValue(cx, cy));
      points.sort((a, b) => a[0] - b[0]);
      found = points.findIndex((p) => p[0] === toValue(cx, cy)[0]);
    }
    dragIdx = found;
    function onMove(ev) {
      const r2 = canvas.getBoundingClientRect();
      const mx = (ev.clientX - r2.left) * (W / r2.width);
      const my = (ev.clientY - r2.top) * (H / r2.height);
      const v = toValue(mx, my);
      if (dragIdx === 0) v[0] = 0;
      if (dragIdx === points.length - 1) v[0] = 255;
      points[dragIdx] = v;
      draw();
      onChange();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    draw();
  });

  draw();
}

function tabsForClip(clip) {
  if (clip.kind === 'text') return ['transform', 'animate', 'blend', 'text'];
  if (clip.kind === 'adjustment') return ['adjust', 'advanced'];
  if (clip.kind === 'effect') return ['effect'];
  const media = project.media[clip.mediaId];
  if (media && media.type === 'audio') return ['audio'];
  const tabs = ['transform', 'blend', 'speed', 'adjust', 'advanced'];
  if (media && media.hasAudio) tabs.splice(3, 0, 'audio');
  return tabs;
}

function renderInspector() {
  const empty = document.getElementById('inspector-empty');
  const body = document.getElementById('inspector-body');
  const found = project.selectedClip();
  refreshers.length = 0;

  if (!found) {
    empty.style.display = 'block';
    body.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  body.style.display = 'flex';
  const { clip } = found;

  const applicable = tabsForClip(clip);
  if (!applicable.includes(activeTab)) activeTab = applicable[0];

  document.querySelectorAll('#inspector-tabs .tab').forEach((btn) => {
    const show = applicable.includes(btn.dataset.tab);
    btn.style.display = show ? '' : 'none';
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });

  const panes = document.getElementById('inspector-panes');
  panes.innerHTML = '';
  const pane = document.createElement('div');
  pane.className = 'tab-pane active';
  panes.appendChild(pane);

  if (activeTab === 'transform') buildTransformPane(pane, clip);
  else if (activeTab === 'animate') buildAnimatePane(pane, clip);
  else if (activeTab === 'effect') buildEffectPane(pane, clip);
  else if (activeTab === 'blend') buildBlendMaskPane(pane, clip);
  else if (activeTab === 'text') buildTextPane(pane, clip);
  else if (activeTab === 'speed') buildSpeedPane(pane, clip);
  else if (activeTab === 'audio') buildAudioPane(pane, clip);
  else if (activeTab === 'adjust') buildAdjustPane(pane, clip);
  else if (activeTab === 'advanced') buildAdvancedPane(pane, clip);
}

function refreshInspectorValues() {
  refreshers.forEach((fn) => fn());
}

function setupInspector() {
  document.getElementById('inspector-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    renderInspector();
  });
  project.on('selection:changed', renderInspector);
  project.on('tracks:changed', () => { if (project.selectedClip()) renderInspector(); else renderInspector(); });
  project.on('time:changed', refreshInspectorValues);
  renderInspector();
}

window.setupInspector = setupInspector;
window.renderInspector = renderInspector;
window.refreshInspectorValues = refreshInspectorValues;
