// ffmpeg has no filter that can stroke an arbitrary freehand path, so a draw
// clip's frames are pre-rendered here (reusing the exact same drawEngine.js
// code the live preview uses, so export matches what was seen while editing)
// and shipped to the main process as a PNG sequence before the real ffmpeg
// export starts - see preload.js/main.js's draw:writeFrames and
// exportGraph.js's image-sequence input branch.
async function prerenderDrawClips(onStatus) {
  const drawClips = [];
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'draw' && clip.draw && clip.draw.strokes.length > 0) drawClips.push(clip);
    }
  }
  if (drawClips.length === 0) return;

  const fps = project.exportSettings.framerate || 30;
  const w = project.canvas.width, h = project.canvas.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  for (let ci = 0; ci < drawClips.length; ci++) {
    const clip = drawClips[ci];
    if (onStatus) onStatus(`Rendering drawing ${ci + 1}/${drawClips.length}…`);
    const dur = project.clipDisplayDuration(clip);
    const frameCount = Math.max(1, Math.ceil(dur * fps));
    const buffers = [];
    for (let i = 0; i < frameCount; i++) {
      const localTime = i / fps;
      const reveal = KF.sample(clip, 'reveal', localTime, clip.draw.reveal == null ? 1 : clip.draw.reveal);
      DrawEngine.renderStrokesToCanvas(ctx, clip.draw.strokes, reveal, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      buffers.push(new Uint8Array(await blob.arrayBuffer()));
    }
    const res = await window.engine.writeDrawFrames(clip.id, buffers);
    clip.draw.framesDir = res.dir;
    clip.draw.frameCount = res.frameCount;
    clip.draw.frameRate = fps;
  }
}

function setupExportPanel() {
  const modal = document.getElementById('export-modal');
  const settingsModal = document.getElementById('export-settings-modal');
  const fill = document.getElementById('export-progress-fill');
  const status = document.getElementById('export-status');
  let unsub = null;

  const qualitySelect = document.getElementById('es-quality');
  const framerateSelect = document.getElementById('es-framerate');
  const bitrateSelect = document.getElementById('es-bitrate');

  document.getElementById('btn-export').addEventListener('click', () => {
    qualitySelect.value = project.exportSettings.quality;
    framerateSelect.value = String(project.exportSettings.framerate);
    bitrateSelect.value = project.exportSettings.bitrateKbps ? String(project.exportSettings.bitrateKbps) : 'auto';
    settingsModal.classList.remove('hidden');
  });

  document.getElementById('export-settings-cancel').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  document.getElementById('export-settings-continue').addEventListener('click', async () => {
    project.exportSettings.quality = qualitySelect.value;
    project.exportSettings.framerate = Number(framerateSelect.value);
    project.exportSettings.bitrateKbps = bitrateSelect.value === 'auto' ? null : Number(bitrateSelect.value);
    settingsModal.classList.add('hidden');

    const outputPath = await window.engine.exportLocationDialog('export.mp4');
    if (!outputPath) return;

    modal.classList.remove('hidden');
    fill.style.width = '0%';
    status.textContent = 'Starting ffmpeg…';

    unsub = window.engine.onExportProgress((p) => {
      fill.style.width = `${Math.min(100, p.percent).toFixed(1)}%`;
      status.textContent = `Rendering… ${fmtTime(p.seconds)} / ${fmtTime(p.totalDuration)}`;
    });

    try {
      await prerenderDrawClips((msg) => { status.textContent = msg; });
      await window.engine.startExport(project.toJSON(), outputPath);
      status.textContent = `Done — saved to ${outputPath}`;
      fill.style.width = '100%';
      setTimeout(() => modal.classList.add('hidden'), 1400);
    } catch (err) {
      status.textContent = 'Export failed: ' + (err && err.message ? err.message : String(err));
    } finally {
      if (unsub) unsub();
    }
  });

  document.getElementById('export-cancel').addEventListener('click', async () => {
    await window.engine.cancelExport();
    modal.classList.add('hidden');
    if (unsub) unsub();
  });
}

window.setupExportPanel = setupExportPanel;
