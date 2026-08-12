// Interactive on-canvas move/resize/rotate handles for the selected clip in
// the preview panel, matching the classic NLE "drag to position, corner
// handles to scale, rotate handle" manipulator. Commits go through the same
// keyframe-aware path as the Inspector fields: if the property already has
// keyframes, dragging records/updates one at the current playhead time;
// otherwise it just edits the static transform value.
//
// When the selected clip has an active mask (Mask & Blend tab), the box
// switches to representing the MASK's own bounding box instead of the
// clip's transform box: dragging moves clip.mask.posX/posY, corner handles
// resize clip.mask.sizeX/sizeY independently (a plain crop-style selection
// box, not a uniform scale-from-center), and rotation is disabled since
// masks aren't rotatable. This is what you want selected while positioning
// a mask - the whole clip's own move/resize handles would be one layer too
// far removed from what's actually being edited. Mask position/size are
// keyframeable too (mask_posX/mask_posY/mask_sizeX/mask_sizeY), so both
// reads and writes here go through the same KF sample/commit pattern as the
// transform box.

function commitTransformProp(clip, property, value, localTime) {
  if (KF.hasAny(clip, property)) {
    KF.add(clip, property, localTime, value);
  } else {
    clip.transform[property] = value;
  }
}

const MASK_PROP_KEYS = { posX: 'mask_posX', posY: 'mask_posY', sizeX: 'mask_sizeX', sizeY: 'mask_sizeY' };
function commitMaskProp(clip, maskField, value, localTime) {
  const kfProperty = MASK_PROP_KEYS[maskField];
  if (KF.hasAny(clip, kfProperty)) {
    KF.add(clip, kfProperty, localTime, value);
  } else {
    clip.mask[maskField] = value;
  }
}

class CanvasOverlay {
  constructor(wrap, canvas, box) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.box = box;
    this.current = null;
    this.rotateHandle = box.querySelector('.xform-handle.rotate');
    this.rotateLine = box.querySelector('.xform-rotate-line');
    this._wireBoxDrag();
    this._wireHandles();
    project.on('time:changed', () => this.update());
    project.on('selection:changed', () => this.update());
    project.on('tracks:changed', () => this.update());
  }

  currentClipAndState() {
    const found = project.selectedClip();
    if (!found) return null;
    const { clip } = found;
    if (clip.kind === 'adjustment' || clip.kind === 'effect') return null;
    const media = clip.kind === 'media' ? project.media[clip.mediaId] : null;
    if (media && media.type === 'audio') return null;

    const localTime = project.timeline.currentTime - clip.startTime;
    const dur = project.clipDisplayDuration(clip);
    if (localTime < 0 || localTime > dur) return null;

    const engine = window.previewEngine;
    let srcW, srcH;
    if (clip.kind === 'text') {
      const size = engine.intrinsicSizeFor(clip);
      srcW = size.w; srcH = size.h;
    } else {
      srcW = (media && media.width) || project.canvas.width;
      srcH = (media && media.height) || project.canvas.height;
    }
    const state = engine.transformStateFor(clip, localTime, srcW, srcH);
    const maskMode = clip.kind === 'media' && !!(clip.mask && clip.mask.type && clip.mask.type !== 'none');
    let maskState = null;
    if (maskMode) {
      const m = clip.mask;
      maskState = {
        posX: KF.sample(clip, 'mask_posX', localTime, m.posX == null ? 0.5 : m.posX),
        posY: KF.sample(clip, 'mask_posY', localTime, m.posY == null ? 0.5 : m.posY),
        sizeX: KF.sample(clip, 'mask_sizeX', localTime, m.sizeX == null ? 0.3 : m.sizeX),
        sizeY: KF.sample(clip, 'mask_sizeY', localTime, m.sizeY == null ? 0.3 : m.sizeY),
      };
    }
    return { clip, state, localTime, srcW, srcH, maskMode, maskState };
  }

  screenScale() {
    const canvasRect = this.canvas.getBoundingClientRect();
    return {
      canvasRect,
      scaleX: canvasRect.width / project.canvas.width,
      scaleY: canvasRect.height / project.canvas.height,
    };
  }

  // The clip's own on-screen box (position + size, ignoring rotation) - the
  // frame the mask's fractional pos/size are relative to.
  clipScreenBox(state) {
    const { canvasRect, scaleX, scaleY } = this.screenScale();
    const wrapRect = this.wrap.getBoundingClientRect();
    const cx = canvasRect.left - wrapRect.left + canvasRect.width / 2 + state.posX * scaleX;
    const cy = canvasRect.top - wrapRect.top + canvasRect.height / 2 + state.posY * scaleY;
    const w = state.drawW * scaleX;
    const h = state.drawH * scaleY;
    return { cx, cy, w, h, left: cx - w / 2, top: cy - h / 2 };
  }

  update() {
    const found = this.currentClipAndState();
    this.current = found;
    if (!found) { this.box.style.display = 'none'; return; }
    const { state, maskMode, maskState } = found;

    this.box.classList.toggle('mask-mode', maskMode);
    this.rotateHandle.style.display = maskMode ? 'none' : '';
    this.rotateLine.style.display = maskMode ? 'none' : '';

    if (maskMode) {
      const cb = this.clipScreenBox(state);
      const maskCx = cb.left + cb.w * maskState.posX;
      const maskCy = cb.top + cb.h * maskState.posY;
      const maskW = Math.max(4, cb.w * 2 * Math.max(0.02, maskState.sizeX));
      const maskH = Math.max(4, cb.h * 2 * Math.max(0.02, maskState.sizeY));
      this.box.style.display = 'block';
      this.box.style.left = (maskCx - maskW / 2) + 'px';
      this.box.style.top = (maskCy - maskH / 2) + 'px';
      this.box.style.width = maskW + 'px';
      this.box.style.height = maskH + 'px';
      // Masks stay axis-aligned to the clip's own frame regardless of the
      // clip's rotation (export applies the mask after rotation, in the
      // rotated frame's own coordinates) - keeping the box unrotated here
      // also avoids needing rotation-aware hit-testing for mask dragging.
      this.box.style.transform = '';
      return;
    }

    const cb = this.clipScreenBox(state);
    const w = Math.max(4, cb.w);
    const h = Math.max(4, cb.h);
    this.box.style.display = 'block';
    this.box.style.left = (cb.cx - w / 2) + 'px';
    this.box.style.top = (cb.cy - h / 2) + 'px';
    this.box.style.width = w + 'px';
    this.box.style.height = h + 'px';
    this.box.style.transform = `rotate(${state.rotation || 0}deg)`;
  }

  _finishDrag() {
    renderTimeline();
    window.refreshInspectorValues();
    this.update();
  }

  _wireBoxDrag() {
    this.box.addEventListener('mousedown', (e) => {
      if (e.target !== this.box) return; // handles have their own listeners
      e.stopPropagation();
      e.preventDefault();
      const found = this.current;
      if (!found) return;
      const { clip, state, localTime, maskMode, maskState } = found;
      const startX = e.clientX, startY = e.clientY;

      if (maskMode) {
        const cb = this.clipScreenBox(state);
        const origPosX = maskState.posX, origPosY = maskState.posY;
        const onMove = (ev) => {
          const dx = (ev.clientX - startX) / Math.max(1, cb.w);
          const dy = (ev.clientY - startY) / Math.max(1, cb.h);
          commitMaskProp(clip, 'posX', Math.min(1, Math.max(0, origPosX + dx)), localTime);
          commitMaskProp(clip, 'posY', Math.min(1, Math.max(0, origPosY + dy)), localTime);
          window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
          this.update();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          this._finishDrag();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }

      const { scaleX, scaleY } = this.screenScale();
      const origX = state.posX, origY = state.posY;
      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / scaleX;
        const dy = (ev.clientY - startY) / scaleY;
        commitTransformProp(clip, 'positionX', origX + dx, localTime);
        commitTransformProp(clip, 'positionY', origY + dy, localTime);
        window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
        this.update();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._finishDrag();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _wireHandles() {
    const corners = this.box.querySelectorAll('.xform-handle:not(.rotate)');
    corners.forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const found = this.current;
        if (!found) return;
        const { clip, state, localTime, srcW, srcH, maskMode, maskState } = found;

        if (maskMode) {
          const cb = this.clipScreenBox(state);
          const startX = e.clientX, startY = e.clientY;
          const origSizeX = maskState.sizeX, origSizeY = maskState.sizeY;
          const h = handle.dataset.handle; // 'nw'|'ne'|'sw'|'se'
          const signX = (h === 'ne' || h === 'se') ? 1 : -1;
          const signY = (h === 'sw' || h === 'se') ? 1 : -1;
          const onMove = (ev) => {
            const dx = ((ev.clientX - startX) / Math.max(1, cb.w)) * signX;
            const dy = ((ev.clientY - startY) / Math.max(1, cb.h)) * signY;
            commitMaskProp(clip, 'sizeX', Math.max(0.02, origSizeX + dx), localTime);
            commitMaskProp(clip, 'sizeY', Math.max(0.02, origSizeY + dy), localTime);
            window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
            this.update();
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            this._finishDrag();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          return;
        }

        const { scaleX, scaleY, canvasRect } = this.screenScale();
        const wrapRect = this.wrap.getBoundingClientRect();
        const centerX = canvasRect.left - wrapRect.left + canvasRect.width / 2 + state.posX * scaleX;
        const centerY = canvasRect.top - wrapRect.top + canvasRect.height / 2 + state.posY * scaleY;
        const rot = (state.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(-rot), sin = Math.sin(-rot);
        const origHalfDiag = Math.max(1, Math.hypot(srcW * state.scale, srcH * state.scale) / 2);
        const origScale = state.scale;

        const onMove = (ev) => {
          const wrapRect2 = this.wrap.getBoundingClientRect();
          const mx = ev.clientX - wrapRect2.left - centerX;
          const my = ev.clientY - wrapRect2.top - centerY;
          // Rotate the mouse offset into the box's own (unrotated) local space
          // so corner-dragging still tracks the cursor when the clip is rotated.
          const localX = (mx * cos - my * sin) / scaleX;
          const localY = (mx * sin + my * cos) / scaleY;
          const dist = Math.hypot(localX, localY);
          const newScale = Math.max(0.02, origScale * (dist / origHalfDiag));
          commitTransformProp(clip, 'scale', newScale, localTime);
          window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
          this.update();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          this._finishDrag();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    this.rotateHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const found = this.current;
      if (!found || found.maskMode) return;
      const { clip, state, localTime } = found;
      const { canvasRect } = this.screenScale();
      const wrapRect = this.wrap.getBoundingClientRect();

      const onMove = (ev) => {
        const centerX = canvasRect.left - wrapRect.left + canvasRect.width / 2 + state.posX * this.screenScale().scaleX;
        const centerY = canvasRect.top - wrapRect.top + canvasRect.height / 2 + state.posY * this.screenScale().scaleY;
        const dx = ev.clientX - wrapRect.left - centerX;
        const dy = ev.clientY - wrapRect.top - centerY;
        const deg = Math.atan2(dx, -dy) * 180 / Math.PI;
        commitTransformProp(clip, 'rotation', Math.round(deg), localTime);
        window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
        this.update();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._finishDrag();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

window.CanvasOverlay = CanvasOverlay;
