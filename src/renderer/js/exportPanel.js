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
