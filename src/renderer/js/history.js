// Undo/redo via periodic full-state snapshots rather than hooking every
// individual mutation site: the project has dozens of scattered mutation
// points (inspector field edits, timeline drags, transitions, effects...),
// most of which don't emit any event at all today. Diffing project.toJSON()
// against the last captured snapshot on a short interval catches all of
// them uniformly, at the cost of coalescing a fast burst of edits (e.g. a
// slider drag) into a single undo step - which is actually the desired
// granularity anyway.
const History = {
  undoStack: [],
  redoStack: [],
  lastSnapshot: null,
  maxSize: 100,
  _timer: null,

  snapshot() {
    return JSON.stringify(project.toJSON());
  },

  capture() {
    const snap = this.snapshot();
    if (snap === this.lastSnapshot) return;
    if (this.lastSnapshot !== null) {
      this.undoStack.push(this.lastSnapshot);
      if (this.undoStack.length > this.maxSize) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.lastSnapshot = snap;
  },

  init() {
    this.lastSnapshot = this.snapshot();
    this._timer = setInterval(() => this.capture(), 500);
  },

  undo() {
    this.capture(); // flush any pending edit so redo can get back to it
    if (this.undoStack.length === 0) return;
    const current = this.snapshot();
    const prev = this.undoStack.pop();
    this.redoStack.push(current);
    this._restore(prev);
  },

  redo() {
    if (this.redoStack.length === 0) return;
    const current = this.snapshot();
    const next = this.redoStack.pop();
    this.undoStack.push(current);
    this._restore(next);
  },

  _restore(json) {
    this.lastSnapshot = json;
    project.loadFromJSON(JSON.parse(json));
    if (window.renderTimeline) renderTimeline();
    if (window.renderInspector) renderInspector();
    if (window.canvasOverlay) window.canvasOverlay.update();
    if (window.previewEngine) window.previewEngine.renderFrame(project.timeline.currentTime, project.isPlaying);
  },
};

History.init();
window.History = History;
