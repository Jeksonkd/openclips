// GPU color-grading pipeline: one WebGL fragment shader implements the full
// adjustment table (light/exposure, color/tone, detail/texture, HSL 8-band,
// tone curves via LUT, and 3-way shadow/mid/highlight color wheels).
// CPU side only maps the 0..100-scaled UI values to shader uniforms and
// builds the two LUT textures used for the curve editor.

const VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uLutLuma;
uniform sampler2D uLutRGB;
uniform vec2 uTexel;
uniform float uTime;

uniform float uBrightness, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemperature, uTint, uSaturation, uVibrance;
uniform float uSharpen, uClarity, uDehaze, uVignette, uGrainAmt;
uniform vec3 uHsl[8];
uniform vec2 uWheelShadow, uWheelMid, uWheelHigh;

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0;
  float s = 0.0;
  if (d > 0.00001) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 0.00001);
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
    if (h < 0.0) h += 1.0;
  }
  return vec3(h, s, l);
}
vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
  float m = l - c * 0.5;
  vec3 rgb;
  if (h < 1.0/6.0) rgb = vec3(c, x, 0.0);
  else if (h < 2.0/6.0) rgb = vec3(x, c, 0.0);
  else if (h < 3.0/6.0) rgb = vec3(0.0, c, x);
  else if (h < 4.0/6.0) rgb = vec3(0.0, x, c);
  else if (h < 5.0/6.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  return rgb + m;
}
vec3 wheelToRgb(vec2 w) {
  float mag = length(w);
  if (mag < 0.001) return vec3(0.0);
  float ang = atan(w.y, w.x);
  vec3 hueColor = hsl2rgb(vec3(fract(ang / 6.28318530718 + 1.0), 1.0, 0.5));
  return (hueColor - vec3(0.5)) * mag;
}

void main() {
  vec4 base = texture2D(uSource, vUv);
  vec3 color = base.rgb;

  vec3 blurN = (
    texture2D(uSource, vUv + uTexel * vec2(1.0, 0.0)).rgb +
    texture2D(uSource, vUv - uTexel * vec2(1.0, 0.0)).rgb +
    texture2D(uSource, vUv + uTexel * vec2(0.0, 1.0)).rgb +
    texture2D(uSource, vUv - uTexel * vec2(0.0, 1.0)).rgb
  ) * 0.25;
  color = color + (color - blurN) * uSharpen;

  vec3 blurW = (
    texture2D(uSource, vUv + uTexel * vec2(3.0, 0.0)).rgb +
    texture2D(uSource, vUv - uTexel * vec2(3.0, 0.0)).rgb +
    texture2D(uSource, vUv + uTexel * vec2(0.0, 3.0)).rgb +
    texture2D(uSource, vUv - uTexel * vec2(0.0, 3.0)).rgb
  ) * 0.25;
  color = color + (color - blurW) * uClarity * 0.7;

  color = color * uExposure + uBrightness;
  color = (color - 0.5) * (uContrast + uDehaze * 0.35) + 0.5;

  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  float hMask = smoothstep(0.5, 1.0, luma);
  float sMask = 1.0 - smoothstep(0.0, 0.5, luma);
  color += uHighlights * hMask * 0.6;
  color += uShadows * sMask * 0.6;
  color = mix(color, color * (1.0 + uWhites), hMask);
  color = mix(color, color + uBlacks * (1.0 - luma), sMask);

  color.r += uTemperature * 0.16;
  color.b -= uTemperature * 0.16;
  color.g += uTint * 0.12;
  color.r -= uTint * 0.06;
  color.b -= uTint * 0.06;

  float luma2 = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma2), color, uSaturation + uDehaze * 0.25);
  float sat0 = length(color - vec3(luma2));
  float vibW = 1.0 - clamp(sat0 * 2.0, 0.0, 1.0);
  color = mix(vec3(dot(color, vec3(0.299,0.587,0.114))), color, 1.0 + uVibrance * vibW);

  vec3 hsl = rgb2hsl(clamp(color, 0.0, 1.0));
  float hueDeg = hsl.x * 360.0;
  for (int i = 0; i < 8; i++) {
    float center = float(i) * 45.0;
    float d = abs(mod(hueDeg - center + 180.0, 360.0) - 180.0);
    float w = clamp(1.0 - d / 45.0, 0.0, 1.0);
    hsl.x = fract(hsl.x + (uHsl[i].x / 360.0) * w);
    hsl.y *= mix(1.0, clamp(1.0 + uHsl[i].y, 0.0, 3.0), w);
    hsl.z += uHsl[i].z * 0.3 * w;
  }
  hsl.y = clamp(hsl.y, 0.0, 1.0);
  hsl.z = clamp(hsl.z, 0.0, 1.0);
  color = hsl2rgb(hsl);

  float lw = dot(color, vec3(0.299, 0.587, 0.114));
  float wS = 1.0 - smoothstep(0.0, 0.6, lw);
  float wH = smoothstep(0.4, 1.0, lw);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  color += wheelToRgb(uWheelShadow) * wS * 0.5;
  color += wheelToRgb(uWheelMid) * wM * 0.5;
  color += wheelToRgb(uWheelHigh) * wH * 0.5;

  color = clamp(color, 0.0, 1.0);
  float li = dot(color, vec3(0.299, 0.587, 0.114));
  float lumaAdj = texture2D(uLutLuma, vec2(li, 0.5)).r;
  color += (lumaAdj - li);
  color = clamp(color, 0.0, 1.0);
  color = vec3(
    texture2D(uLutRGB, vec2(color.r, 0.5)).r,
    texture2D(uLutRGB, vec2(color.g, 0.5)).g,
    texture2D(uLutRGB, vec2(color.b, 0.5)).b
  );

  float n = fract(sin(dot(vUv * (uTime * 60.0 + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
  color += (n - 0.5) * uGrainAmt;

  vec2 centered = vUv - 0.5;
  float dist = length(centered) * 1.35;
  float vig = smoothstep(0.85, 0.15, dist * (1.0 + uVignette * 1.4));
  color *= mix(1.0, clamp(vig, 0.0, 1.0), uVignette);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
}`;

const HSL_ORDER = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'];

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}

function buildCurveLutData(points, channelIndex, out4) {
  // points: sorted [[x(0-255), y(0-255)], ...]; produces 256 values in [0,1]
  const pts = (points && points.length >= 2) ? [...points].sort((a, b) => a[0] - b[0]) : [[0, 0], [255, 255]];
  const lut = new Float32Array(256);
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < pts.length - 2 && x > pts[seg + 1][0]) seg++;
    const [x0, y0] = pts[seg];
    const [x1, y1] = pts[seg + 1];
    const span = Math.max(1e-6, x1 - x0);
    const t = Math.min(1, Math.max(0, (x - x0) / span));
    lut[x] = (y0 + (y1 - y0) * t) / 255;
  }
  return lut;
}

class ColorPipeline {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true }) ||
      this.canvas.getContext('experimental-webgl', { premultipliedAlpha: false, alpha: true });
    const gl = this.gl;
    if (!gl) throw new Error('WebGL unavailable');

    // Source images/video frames upload top-row-first; without this WebGL's
    // default texture coordinate convention renders every clip upside down
    // (harmless no-op for the 1px-tall LUT textures uploaded on this same context).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.quad = quad;

    this.sourceTex = gl.createTexture();
    this._setupTex(this.sourceTex);
    this.lutLumaTex = gl.createTexture();
    this._setupTex(this.lutLumaTex);
    this.lutRgbTex = gl.createTexture();
    this._setupTex(this.lutRgbTex);

    this.uniforms = {};
    ['uSource', 'uLutLuma', 'uLutRGB', 'uTexel', 'uTime', 'uBrightness', 'uExposure', 'uContrast', 'uHighlights',
      'uShadows', 'uWhites', 'uBlacks', 'uTemperature', 'uTint', 'uSaturation', 'uVibrance', 'uSharpen', 'uClarity',
      'uDehaze', 'uVignette', 'uGrainAmt', 'uWheelShadow', 'uWheelMid', 'uWheelHigh'].forEach((n) => {
      this.uniforms[n] = gl.getUniformLocation(prog, n);
    });
    this.uHsl = gl.getUniformLocation(prog, 'uHsl[0]');
    this._lastCurveKey = null;
  }

  _setupTex(tex) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  _uploadCurves(curves) {
    const key = JSON.stringify(curves);
    if (key === this._lastCurveKey) return;
    this._lastCurveKey = key;
    const gl = this.gl;

    const lumaLut = buildCurveLutData(curves.luma);
    const lumaData = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { lumaData[i * 4] = lumaLut[i] * 255; lumaData[i * 4 + 1] = 0; lumaData[i * 4 + 2] = 0; lumaData[i * 4 + 3] = 255; }
    gl.bindTexture(gl.TEXTURE_2D, this.lutLumaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lumaData);

    const rLut = buildCurveLutData(curves.red);
    const gLut = buildCurveLutData(curves.green);
    const bLut = buildCurveLutData(curves.blue);
    const rgbData = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      rgbData[i * 4] = rLut[i] * 255;
      rgbData[i * 4 + 1] = gLut[i] * 255;
      rgbData[i * 4 + 2] = bLut[i] * 255;
      rgbData[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutRgbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgbData);
  }

  // sourceEl: HTMLVideoElement / HTMLImageElement / HTMLCanvasElement
  render(sourceEl, adjustments, outWidth, outHeight, timeSeconds) {
    const gl = this.gl;
    if (this.canvas.width !== outWidth || this.canvas.height !== outHeight) {
      this.canvas.width = outWidth;
      this.canvas.height = outHeight;
    }
    gl.viewport(0, 0, outWidth, outHeight);
    gl.useProgram(this.prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceEl);
    } catch (e) { /* source not decoded yet this frame */ }
    gl.uniform1i(this.uniforms.uSource, 0);

    this._uploadCurves(adjustments.curves || { luma: [[0,0],[255,255]], red: [[0,0],[255,255]], green: [[0,0],[255,255]], blue: [[0,0],[255,255]] });
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutLumaTex);
    gl.uniform1i(this.uniforms.uLutLuma, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutRgbTex);
    gl.uniform1i(this.uniforms.uLutRGB, 2);

    gl.uniform2f(this.uniforms.uTexel, 1 / outWidth, 1 / outHeight);
    gl.uniform1f(this.uniforms.uTime, timeSeconds || 0);

    const a = adjustments;
    gl.uniform1f(this.uniforms.uBrightness, (a.brightness || 0) / 200);
    gl.uniform1f(this.uniforms.uExposure, Math.pow(2, (a.exposure || 0) / 100));
    gl.uniform1f(this.uniforms.uContrast, 1 + (a.contrast || 0) / 100);
    gl.uniform1f(this.uniforms.uHighlights, (a.highlights || 0) / 100);
    gl.uniform1f(this.uniforms.uShadows, (a.shadows || 0) / 100);
    gl.uniform1f(this.uniforms.uWhites, (a.whites || 0) / 100);
    gl.uniform1f(this.uniforms.uBlacks, (a.blacks || 0) / 100);
    gl.uniform1f(this.uniforms.uTemperature, (a.temperature || 0) / 100);
    gl.uniform1f(this.uniforms.uTint, (a.tint || 0) / 100);
    gl.uniform1f(this.uniforms.uSaturation, 1 + (a.saturation || 0) / 100);
    gl.uniform1f(this.uniforms.uVibrance, (a.vibrance || 0) / 100);
    gl.uniform1f(this.uniforms.uSharpen, (a.sharpen || 0) / 100);
    gl.uniform1f(this.uniforms.uClarity, (a.clarity || 0) / 100);
    gl.uniform1f(this.uniforms.uDehaze, (a.dehaze || 0) / 100);
    gl.uniform1f(this.uniforms.uVignette, (a.vignette || 0) / 100);
    gl.uniform1f(this.uniforms.uGrainAmt, (a.grain || 0) / 100 * 0.3);

    const hsl = a.hsl || {};
    const flat = new Float32Array(24);
    HSL_ORDER.forEach((name, i) => {
      const v = hsl[name] || [0, 0, 0];
      flat[i * 3] = (v[0] || 0) * 0.3; // hue slider -100..100 -> +-30deg
      flat[i * 3 + 1] = (v[1] || 0) / 100;
      flat[i * 3 + 2] = (v[2] || 0) / 100;
    });
    gl.uniform3fv(this.uHsl, flat);

    const wheels = a.wheels || {};
    gl.uniform2fv(this.uniforms.uWheelShadow, wheels.shadows || [0, 0]);
    gl.uniform2fv(this.uniforms.uWheelMid, wheels.midtones || [0, 0]);
    gl.uniform2fv(this.uniforms.uWheelHigh, wheels.highlights || [0, 0]);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

window.ColorPipeline = ColorPipeline;
