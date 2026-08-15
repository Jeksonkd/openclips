// Freehand drawing tool: a toggleable pen mode over the preview canvas.
// While active, dragging on the canvas records a stroke (in project.canvas
// pixel space) into the current draw clip, creating one automatically on
// the first stroke if none is selected. Rendering of the strokes themselves
// (both live and at export time) lives in drawEngine.js - this file only
// owns capturing pointer input and the color/width mini-toolbar.

let drawModeActive = false;
let currentStrokeColor = '#ff3b3b';
let currentStrokeWidth = 8;
let activeStroke = null;

function canvasPointFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / project.canvas.width;
  const scaleY = rect.height / project.canvas.height;
  return {
    x: Math.max(0, Math.min(project.canvas.width, (e.clientX - rect.left) / scaleX)),
    y: Math.max(0, Math.min(project.canvas.height, (e.clientY - rect.top) / scaleY)),
  };
}

// The draw clip strokes go into: the selected clip if it's a draw clip
// whose time range covers the playhead, else a freshly created one there.
function currentDrawClip() {
  const found = project.selectedClip();
  if (found && found.clip.kind === 'draw') {
    const dur = project.clipDisplayDuration(found.clip);
    const local = project.timeline.currentTime - found.clip.startTime;
    if (local >= -0.001 && local <= dur + 0.001) return found.clip;
  }
  const track = window.targetTrackForNewClip();
  const clip = project.addDrawClip(track.id, project.timeline.currentTime, 4);
  if (clip) {
    clip.draw.defaultColor = currentStrokeColor;
    clip.draw.defaultWidth = currentStrokeWidth;
    window.selectClip(clip.id);
  }
  return clip;
}

function setDrawMode(on) {
  drawModeActive = on;
  const canvas = document.getElementById('preview-canvas');
  canvas.classList.toggle('draw-mode', on);
  const btn = document.getElementById('tl-draw-toggle');
  if (btn) btn.classList.toggle('toggled', on);
  const mini = document.getElementById('draw-mini-toolbar');
  if (mini) mini.classList.toggle('hidden', !on);
}

function setupDrawTool() {
  const canvas = document.getElementById('preview-canvas');

  canvas.addEventListener('mousedown', (e) => {
    if (!drawModeActive) return;
    // Let the transform box's own handles/drag win when the pointer is over
    // them - this listener is on the canvas element itself, which sits
    // beneath the overlay box, so a direct hit here always means "empty
    // canvas area" and is safe to start a stroke from.
    e.stopPropagation();
    e.preventDefault();
    const clip = currentDrawClip();
    if (!clip) return;
    const pt = canvasPointFromEvent(e, canvas);
    activeStroke = { points: [pt], color: currentStrokeColor, width: currentStrokeWidth };
    clip.draw.strokes.push(activeStroke);
    window.previewEngine.renderFrame(project.timeline.currentTime, false);

    const onMove = (ev) => {
      const p = canvasPointFromEvent(ev, canvas);
      const last = activeStroke.points[activeStroke.points.length - 1];
      // Distance-filter points so a slow drag doesn't bloat the stroke with
      // near-duplicate points (also keeps the export PNG re-render cheap).
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) {
        activeStroke.points.push(p);
        window.previewEngine.renderFrame(project.timeline.currentTime, false);
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      activeStroke = null;
      renderTimeline();
      if (window.renderInspector) window.renderInspector();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  document.getElementById('tl-draw-toggle').addEventListener('click', () => setDrawMode(!drawModeActive));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawModeActive) setDrawMode(false);
  });

  const colorInput = document.getElementById('draw-color');
  colorInput.value = currentStrokeColor;
  colorInput.addEventListener('input', () => { currentStrokeColor = colorInput.value; });

  const widthInput = document.getElementById('draw-width');
  widthInput.value = currentStrokeWidth;
  widthInput.addEventListener('input', () => { currentStrokeWidth = Number(widthInput.value); });
}

window.setupDrawTool = setupDrawTool;
