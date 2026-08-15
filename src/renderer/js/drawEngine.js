// Freehand drawing render logic - shared between the live preview (called
// straight into the on-screen canvas context) and the export pre-render step
// (called into an offscreen canvas whose pixels get shipped to the main
// process as a PNG sequence, since ffmpeg has no filter that can stroke an
// arbitrary freehand path). Keeping this in one place is what makes the two
// outputs WYSIWYG-identical.
//
// `reveal` (0..1) is the fraction of the TOTAL stroke length (summed across
// every stroke, in the order they were drawn) that should be visible -
// animating this via a keyframe is what makes a drawing "draw itself" over
// time, the same way any other clip property gets keyframed.

function strokeLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

function drawFullStroke(ctx, stroke) {
  const pts = stroke.points;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color || '#ff3b3b';
  ctx.lineWidth = stroke.width || 8;
  if (pts.length < 2) {
    // A single-point stroke (a tap/click, no drag) has zero path length, so
    // ctx.stroke() would render nothing - draw it as a dot instead.
    if (pts.length === 1) {
      ctx.fillStyle = stroke.color || '#ff3b3b';
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, (stroke.width || 8) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

// Draws only the first `budget` units of path length of this stroke,
// interpolating the exact cutoff point so the reveal animates smoothly
// rather than jumping point-to-point.
function drawPartialStroke(ctx, stroke, budget) {
  const pts = stroke.points;
  if (pts.length === 0 || budget <= 0) return;
  if (pts.length === 1) { drawFullStroke(ctx, stroke); return; }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color || '#ff3b3b';
  ctx.lineWidth = stroke.width || 8;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  let remaining = budget;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= remaining) {
      ctx.lineTo(b.x, b.y);
      remaining -= segLen;
    } else {
      const t = segLen > 1e-6 ? remaining / segLen : 0;
      ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      break;
    }
  }
  ctx.stroke();
}

function renderStrokesToCanvas(ctx, strokes, revealFraction, w, h) {
  ctx.clearRect(0, 0, w, h);
  if (!strokes || strokes.length === 0) return;
  const reveal = Math.max(0, Math.min(1, revealFraction == null ? 1 : revealFraction));
  if (reveal >= 1) {
    for (const s of strokes) drawFullStroke(ctx, s);
    return;
  }
  if (reveal <= 0) return;
  const lengths = strokes.map((s) => strokeLength(s.points));
  const total = lengths.reduce((a, b) => a + b, 0);
  let budget = total * reveal;
  for (let i = 0; i < strokes.length; i++) {
    if (budget <= 0) break;
    if (budget >= lengths[i]) {
      drawFullStroke(ctx, strokes[i]);
      budget -= lengths[i];
    } else {
      drawPartialStroke(ctx, strokes[i], budget);
      budget = 0;
    }
  }
}

window.DrawEngine = { renderStrokesToCanvas, strokeLength };
