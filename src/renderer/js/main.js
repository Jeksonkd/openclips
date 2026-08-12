window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('preview-canvas');
  canvas.width = project.canvas.width;
  canvas.height = project.canvas.height;
  window.previewEngine = new PreviewEngine(canvas);

  setupAssetPanel();
  setupTimeline();
  setupInspector();
  setupExportPanel();

  window.canvasOverlay = new CanvasOverlay(
    document.querySelector('.preview-wrap'),
    canvas,
    document.getElementById('xform-box'),
  );

  window.previewEngine.renderFrame(0, false);
  window.canvasOverlay.update();
  window.addEventListener('resize', () => window.canvasOverlay.update());

  // Structural edits (add/delete/split a clip, add a track, apply a
  // transition...) didn't refresh the preview canvas on their own - only
  // scrubbing/playback did, via time:changed. If the playhead happened to
  // sit over whatever you just added or removed, the canvas kept showing
  // whatever was there before until you nudged the scrubber.
  project.on('tracks:changed', () => {
    window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
  });

  // Transport controls
  const playBtn = document.getElementById('btn-playpause');
  playBtn.addEventListener('click', () => {
    if (project.isPlaying) window.previewEngine.pause();
    else window.previewEngine.play();
  });
  project.on('time:changed', () => {
    playBtn.textContent = project.isPlaying ? '⏸' : '▶';
  });

  const scrub = document.getElementById('scrub');
  scrub.addEventListener('mousedown', () => { scrub._dragging = true; });
  scrub.addEventListener('input', () => {
    const dur = project.projectDuration();
    window.previewEngine.seek((Number(scrub.value) / 1000) * dur);
  });
  scrub.addEventListener('mouseup', () => { scrub._dragging = false; });

  // Top bar: new / open / save / export project file
  document.getElementById('btn-new').addEventListener('click', () => {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    Object.keys(project.media).forEach((k) => delete project.media[k]);
    project.timeline.tracks = [];
    project.addTrack('Track 1');
    project.addTrack('Track 2');
    project.selectedClipId = null;
    project.timeline.currentTime = 0;
    project.emit('media:changed');
    project.emit('tracks:changed');
    project.emit('selection:changed');
    project.emit('time:changed');
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const filePath = await window.engine.saveProjectDialog();
    if (!filePath) return;
    await window.engine.saveProject(filePath, JSON.stringify(project.toJSON(), null, 2));
  });

  document.getElementById('btn-open').addEventListener('click', async () => {
    const filePath = await window.engine.openProjectDialog();
    if (!filePath) return;
    const json = await window.engine.loadProject(filePath);
    project.loadFromJSON(JSON.parse(json));
  });

  // Allow dropping media files straight from the OS file manager onto the asset panel.
  const assetList = document.getElementById('asset-list');
  assetList.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  assetList.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const paths = Array.from(e.dataTransfer.files).map((f) => window.engine.getPathForFile(f)).filter(Boolean);
    if (paths.length) { await importMediaFiles(paths); renderAssetList(); }
  });
});
