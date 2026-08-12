const { execFile } = require('child_process');
const path = require('path');

let electronApp = null;
try { electronApp = require('electron').app; } catch (e) { /* running outside Electron (e.g. test harness) */ }

function resolveBinary(devPath, prodRelative) {
  if (electronApp && electronApp.isPackaged) {
    // extraResources drops these in unpacked (not asar), and on Windows the
    // file must actually be named with .exe - an explicit path passed to
    // execFile isn't resolved through PATHEXT the way a bare command name
    // would be, so without this a packaged Windows build launches nothing.
    const name = process.platform === 'win32' ? `${prodRelative}.exe` : prodRelative;
    return path.join(process.resourcesPath, name);
  }
  return devPath;
}

const ffmpegPath = resolveBinary(require('ffmpeg-static'), 'ffmpeg');
const ffprobePath = resolveBinary(require('ffprobe-static').path, 'ffprobe');

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function probeMedia(filePath) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  const out = await run(ffprobePath, args);
  const data = JSON.parse(out);

  const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');

  const duration = parseFloat((data.format && data.format.duration) || (videoStream && videoStream.duration) || (audioStream && audioStream.duration) || '0');

  let fps = 0;
  if (videoStream && videoStream.r_frame_rate) {
    const [n, d] = videoStream.r_frame_rate.split('/').map(Number);
    fps = d ? n / d : n;
  }

  return {
    duration: duration || 0,
    width: videoStream ? videoStream.width : 0,
    height: videoStream ? videoStream.height : 0,
    fps: fps || 0,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
  };
}

function generateThumbnail(filePath, atSeconds, outPath) {
  const args = [
    '-y',
    '-ss', String(Math.max(0, atSeconds)),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    outPath,
  ];
  return run(ffmpegPath, args);
}

module.exports = { probeMedia, generateThumbnail, ffmpegPath, ffprobePath };
