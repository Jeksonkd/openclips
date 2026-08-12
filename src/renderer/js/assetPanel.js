const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg']);

function extOf(p) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

async function importMediaFiles(paths) {
  for (const filePath of paths) {
    const ext = extOf(filePath);
    const isImage = IMAGE_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);
    let probe = { duration: 5, width: 0, height: 0, fps: 0, hasVideo: !isAudio, hasAudio: !isImage };
    try { probe = await window.engine.probeMedia(filePath); } catch (e) { console.error('probe failed', e); }
    const id = uid('media');
    let thumbPath = null;
    if (!isAudio) {
      // Still images only have a frame at t=0 - seeking into them (as we do
      // for a representative video frame) finds nothing and ffmpeg emits a
      // zero-byte file, which is why image thumbnails were coming up blank.
      const thumbAt = isImage ? 0 : Math.min(1, (probe.duration || 1) / 2);
      try { thumbPath = await window.engine.thumbnail(filePath, thumbAt); } catch (e) { /* ignore */ }
    }
    const name = filePath.split('/').pop();
    project.addMedia({
      id, path: filePath, name,
      type: isImage ? 'image' : (isAudio ? 'audio' : 'video'),
      duration: isImage ? 5 : (probe.duration || 5),
      width: probe.width || 1280,
      height: probe.height || 720,
      fps: probe.fps || 30,
      hasAudio: isAudio || !!probe.hasAudio,
      hasVideo: isImage || !!probe.hasVideo,
      thumbPath,
    });
  }
}

function renderAssetList() {
  const list = document.getElementById('asset-list');
  list.innerHTML = '';
  Object.values(project.media).forEach((media) => {
    const item = document.createElement('div');
    item.className = 'asset-item';
    item.draggable = true;
    item.dataset.mediaId = media.id;

    if (media.type === 'audio') {
      const thumb = document.createElement('div');
      thumb.className = 'asset-thumb audio-thumb';
      thumb.textContent = '🎵';
      item.appendChild(thumb);
    } else {
      const img = document.createElement('img');
      img.className = 'asset-thumb';
      img.src = media.thumbPath ? window.engine.toMediaUrl(media.thumbPath) : '';
      item.appendChild(img);
    }

    const name = document.createElement('div');
    name.className = 'asset-name';
    name.textContent = media.name;
    name.title = media.path;
    item.appendChild(name);

    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-openclips-media', media.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    list.appendChild(item);
  });
}

function setupAssetPanel() {
  document.getElementById('btn-import').addEventListener('click', async () => {
    const paths = await window.engine.openMediaDialog();
    if (paths && paths.length) {
      await importMediaFiles(paths);
      renderAssetList();
    }
  });
  project.on('media:changed', renderAssetList);
}

window.setupAssetPanel = setupAssetPanel;
window.importMediaFiles = importMediaFiles;
window.renderAssetList = renderAssetList;
