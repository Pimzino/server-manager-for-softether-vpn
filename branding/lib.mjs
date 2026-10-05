// Dependency-free raster renderer for the logo studies: signed-distance shapes with analytic anti-aliasing,
// OKLab gradients, TrueType outlines (system fonts) and a PNG encoder. Everything is drawn in code: no SVG.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

// ------------------------------------------------------------------------------------------ colour
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** "#rrggbb" -> linear-light [r,g,b] */
export function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [toLin(((n >> 16) & 255) / 255), toLin(((n >> 8) & 255) / 255), toLin((n & 255) / 255)];
}
function toLab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** Gradient through colour stops [[t, "#hex"], ...], interpolated in OKLab (no muddy midpoints). Returns t -> linear rgb. */
export function ramp(stops) {
  const labs = stops.map(([t, c]) => [t, toLab(typeof c === "string" ? hex(c) : c)]);
  return (t) => {
    if (t <= labs[0][0]) return fromLab(labs[0][1]);
    for (let i = 1; i < labs.length; i++) {
      if (t <= labs[i][0]) {
        const [t0, a] = labs[i - 1], [t1, b] = labs[i];
        const k = (t - t0) / (t1 - t0);
        return fromLab([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
      }
    }
    return fromLab(labs[labs.length - 1][1]);
  };
}
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Paint: linear gradient from (x0,y0) to (x1,y1) */
export function linear(x0, y0, x1, y1, stops) {
  const r = ramp(stops), dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  return (x, y) => r(((x - x0) * dx + (y - y0) * dy) / l2);
}
export function radial(cx, cy, rad, stops) {
  const r = ramp(stops);
  return (x, y) => r(Math.hypot(x - cx, y - cy) / rad);
}
export const solid = (c) => { const v = typeof c === "string" ? hex(c) : c; return () => v; };

// ------------------------------------------------------------------------------------------ distance fields
export const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
export const box = (cx, cy, hw, hh, r = 0) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
export const segment = (ax, ay, bx, by, w) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  return (x, y) => {
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2);
    return Math.hypot(x - ax - dx * t, y - ay - dy * t) - w / 2;
  };
};
/** Superellipse plate (the macOS "squircle"), distance normalised by the gradient so edges anti-alias evenly. */
export const squircle = (cx, cy, r, n = 5) => {
  const f = (x, y) => (Math.abs((x - cx) / r) ** n + Math.abs((y - cy) / r) ** n) ** (1 / n) * r - r;
  return (x, y) => {
    const d = f(x, y), gx = f(x + 0.5, y) - f(x - 0.5, y), gy = f(x, y + 0.5) - f(x, y - 0.5);
    return d / (Math.hypot(gx, gy) || 1);
  };
};
/** Convex or concave polygon [[x,y],...] with optional corner rounding (shrinks by r, then grows) */
export const polygon = (pts, r = 0) => (x, y) => {
  let d = Infinity, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const ex = xj - xi, ey = yj - yi, wx = x - xi, wy = y - yi;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey));
    d = Math.min(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
    const c1 = y >= yi, c2 = y < yj, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d) - r;
};
export const union = (...f) => (x, y) => { let d = Infinity; for (const g of f) { const v = g(x, y); if (v < d) d = v; } return d; };
export const intersect = (...f) => (x, y) => { let d = -Infinity; for (const g of f) { const v = g(x, y); if (v > d) d = v; } return d; };
export const subtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));
export const ring = (f, w) => (x, y) => Math.abs(f(x, y)) - w / 2;
export const grow = (f, r) => (x, y) => f(x, y) - r;
export const smoothUnion = (a, b, k) => (x, y) => {
  const p = a(x, y), q = b(x, y), h = clamp(0.5 + (0.5 * (q - p)) / k);
  return mix(q, p, h) - k * h * (1 - h);
};
export const rotate = (f, cx, cy, deg) => {
  const a = (-deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return (x, y) => f(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c);
};
export const move = (f, dx, dy) => (x, y) => f(x - dx, y - dy);

// ------------------------------------------------------------------------------------------ canvas
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export class Canvas {
  /** w x h output pixels; drawing coordinates are multiplied by `scale` (design at 1024, render at any size) */
  constructor(w, h, scale = 1) {
    this.w = w; this.h = h; this.s = scale;
    this.px = new Float32Array(w * h * 4); // premultiplied linear RGBA
  }
  /** Composite a shader over the canvas. shade(x, y) in design units returns [r,g,b,a] (straight alpha, linear) or null. */
  shade(shade, bounds) {
    const s = this.s;
    const [x0, y0, x1, y1] = bounds ? [Math.max(0, Math.floor(bounds[0] * s)), Math.max(0, Math.floor(bounds[1] * s)), Math.min(this.w, Math.ceil(bounds[2] * s)), Math.min(this.h, Math.ceil(bounds[3] * s))] : [0, 0, this.w, this.h];
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const c = shade((px + 0.5) / s, (py + 0.5) / s);
        if (!c || c[3] <= 0) continue;
        const a = c[3] > 1 ? 1 : c[3], i = (py * this.w + px) * 4, k = 1 - a;
        this.px[i] = c[0] * a + this.px[i] * k;
        this.px[i + 1] = c[1] * a + this.px[i + 1] * k;
        this.px[i + 2] = c[2] * a + this.px[i + 2] * k;
        this.px[i + 3] = a + this.px[i + 3] * k;
      }
    }
    return this;
  }
  /** Fill a distance field with a paint. opts: opacity, bounds, feather (extra edge softness in design units) */
  fill(sdf, paint, opts = {}) {
    const s = this.s, op = opts.opacity ?? 1, fe = opts.feather ?? 0;
    return this.shade((x, y) => {
      const d = sdf(x, y);
      const a = fe ? 1 - smooth(-fe, fe, d) : clamp(0.5 - d * s);
      if (a <= 0) return null;
      const c = paint(x, y);
      return [c[0], c[1], c[2], a * op * (c[3] ?? 1)];
    }, opts.bounds);
  }
  /** Soft shadow / glow of a distance field: gaussian-like falloff over `blur` design units */
  shadow(sdf, color, { dx = 0, dy = 0, blur = 20, opacity = 0.4, spread = 0, bounds } = {}) {
    const c = typeof color === "string" ? hex(color) : color;
    return this.shade((x, y) => {
      const d = sdf(x - dx, y - dy) - spread;
      const a = 1 - smooth(-blur, blur, d);
      return a <= 0 ? null : [c[0], c[1], c[2], a * a * opacity];
    }, bounds);
  }
  /** Draw another canvas (same scale assumed) at design position, optional opacity */
  draw(src, dx, dy, opacity = 1) {
    const ox = Math.round(dx * this.s), oy = Math.round(dy * this.s);
    for (let y = 0; y < src.h; y++) {
      const ty = y + oy; if (ty < 0 || ty >= this.h) continue;
      for (let x = 0; x < src.w; x++) {
        const tx = x + ox; if (tx < 0 || tx >= this.w) continue;
        const i = (y * src.w + x) * 4, j = (ty * this.w + tx) * 4, a = src.px[i + 3] * opacity;
        if (a <= 0) continue;
        const k = 1 - a;
        this.px[j] = src.px[i] * opacity + this.px[j] * k;
        this.px[j + 1] = src.px[i + 1] * opacity + this.px[j + 1] * k;
        this.px[j + 2] = src.px[i + 2] * opacity + this.px[j + 2] * k;
        this.px[j + 3] = a + this.px[j + 3] * k;
      }
    }
    return this;
  }
  /** Area-averaged downscale in linear light (how the small icon sizes are made) */
  resized(w, h) {
    const out = new Canvas(w, h, (this.s * w) / this.w), fx = this.w / w, fy = this.h / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx0 = x * fx, sx1 = (x + 1) * fx, sy0 = y * fy, sy1 = (y + 1) * fy;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wgt = wy * (Math.min(sx + 1, sx1) - Math.max(sx, sx0)), i = (sy * this.w + sx) * 4;
          r += this.px[i] * wgt; g += this.px[i + 1] * wgt; b += this.px[i + 2] * wgt; a += this.px[i + 3] * wgt; wsum += wgt;
        }
      }
      const o = (y * w + x) * 4;
      out.px[o] = r / wsum; out.px[o + 1] = g / wsum; out.px[o + 2] = b / wsum; out.px[o + 3] = a / wsum;
    }
    return out;
  }
  /** 8-bit sRGB RGBA PNG, with half-LSB dither so the gradients do not band */
  png() {
    const { w, h } = this, raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      const row = y * (w * 4 + 1);
      raw[row] = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, o = row + 1 + x * 4, a = this.px[i + 3], n = hash(x, y) - 0.5;
        for (let c = 0; c < 3; c++) raw[o + c] = clamp(Math.round(toSrgb(clamp(a > 0 ? this.px[i + c] / a : 0)) * 255 + n), 0, 255);
        raw[o + 3] = clamp(Math.round(a * 255), 0, 255);
      }
    }
    const chunk = (type, data) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
      b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
  save(file) { writeFileSync(file, this.png()); return this; }
}

/** Film-grain style noise in [-1,1], stable per design coordinate */
export const grain = (x, y) => hash(Math.floor(x * 2), Math.floor(y * 2)) * 2 - 1;

// ------------------------------------------------------------------------------------------ TrueType text
export class Font {
  /** file: .ttf or .ttc with TrueType (glyf) outlines; face: index inside a .ttc */
  constructor(file, face = 0) {
    const b = (this.b = readFileSync(file));
    let off = 0;
    if (b.toString("latin1", 0, 4) === "ttcf") off = b.readUInt32BE(12 + 4 * face);
    this.t = {};
    for (let i = 0, n = b.readUInt16BE(off + 4); i < n; i++) {
      const r = off + 12 + 16 * i;
      this.t[b.toString("latin1", r, r + 4)] = b.readUInt32BE(r + 8);
    }
    this.upm = b.readUInt16BE(this.t.head + 18);
    this.longLoca = b.readInt16BE(this.t.head + 50) === 1;
    this.numH = b.readUInt16BE(this.t.hhea + 34);
    this.ascent = b.readInt16BE(this.t.hhea + 4);
    this.capHeight = this.t["OS/2"] && b.readUInt16BE(this.t["OS/2"]) >= 2 ? b.readInt16BE(this.t["OS/2"] + 88) : this.ascent * 0.72;
    // cmap: format 4 (BMP)
    const cm = this.t.cmap;
    for (let i = 0, n = b.readUInt16BE(cm + 2); i < n; i++) {
      const sub = cm + b.readUInt32BE(cm + 4 + 8 * i + 4);
      if (b.readUInt16BE(sub) === 4) { this.cmap4 = sub; break; }
    }
    if (!this.cmap4) throw new Error("font has no format 4 cmap");
    // kern (format 0, horizontal)
    this.kern = new Map();
    if (this.t.kern) {
      let p = this.t.kern + 4;
      for (let i = 0, n = b.readUInt16BE(this.t.kern + 2); i < n; i++) {
        const len = b.readUInt16BE(p + 2), cov = b.readUInt16BE(p + 4);
        if (cov >> 8 === 0 && cov & 1) {
          for (let k = 0, np = b.readUInt16BE(p + 6); k < np; k++) {
            const e = p + 14 + 6 * k;
            this.kern.set(b.readUInt16BE(e) * 65536 + b.readUInt16BE(e + 2), b.readInt16BE(e + 4));
          }
        }
        p += len;
      }
    }
  }
  glyphId(cp) {
    const b = this.b, s = this.cmap4, segs = b.readUInt16BE(s + 6) / 2;
    for (let i = 0; i < segs; i++) {
      const end = b.readUInt16BE(s + 14 + 2 * i);
      if (cp > end) continue;
      const start = b.readUInt16BE(s + 16 + 2 * segs + 2 * i);
      if (cp < start) return 0;
      const delta = b.readInt16BE(s + 16 + 4 * segs + 2 * i), roPos = s + 16 + 6 * segs + 2 * i, ro = b.readUInt16BE(roPos);
      if (ro === 0) return (cp + delta) & 0xffff;
      const g = b.readUInt16BE(roPos + ro + 2 * (cp - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  }
  advance(g) { return this.b.readUInt16BE(this.t.hmtx + 4 * Math.min(g, this.numH - 1)); }
  /** Contours of a glyph as arrays of {x,y,on} in font units */
  contours(g) {
    const b = this.b, lo = this.t.loca;
    const o0 = this.longLoca ? b.readUInt32BE(lo + 4 * g) : b.readUInt16BE(lo + 2 * g) * 2;
    const o1 = this.longLoca ? b.readUInt32BE(lo + 4 * g + 4) : b.readUInt16BE(lo + 2 * g + 2) * 2;
    if (o0 === o1) return [];
    let p = this.t.glyf + o0;
    const nc = b.readInt16BE(p);
    p += 10;
    if (nc < 0) { // composite
      const out = [];
      for (;;) {
        const flags = b.readUInt16BE(p), gi = b.readUInt16BE(p + 2);
        p += 4;
        let dx, dy;
        if (flags & 1) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; } else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
        let a = 1, bb = 0, c = 0, d = 1;
        const f2 = () => { const v = b.readInt16BE(p) / 16384; p += 2; return v; };
        if (flags & 8) a = d = f2(); else if (flags & 0x40) { a = f2(); d = f2(); } else if (flags & 0x80) { a = f2(); bb = f2(); c = f2(); d = f2(); }
        for (const ct of this.contours(gi)) out.push(ct.map((q) => ({ x: q.x * a + q.y * c + dx, y: q.x * bb + q.y * d + dy, on: q.on })));
        if (!(flags & 0x20)) break;
      }
      return out;
    }
    const ends = [];
    for (let i = 0; i < nc; i++) { ends.push(b.readUInt16BE(p)); p += 2; }
    p += 2 + b.readUInt16BE(p);
    const n = ends[nc - 1] + 1, flags = [];
    while (flags.length < n) {
      const f = b[p++];
      flags.push(f);
      if (f & 8) for (let r = b[p++]; r > 0; r--) flags.push(f);
    }
    const xs = [], ys = [];
    let v = 0;
    for (let i = 0; i < n; i++) { const f = flags[i]; if (f & 2) { const d = b[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += b.readInt16BE(p); p += 2; } xs.push(v); }
    v = 0;
    for (let i = 0; i < n; i++) { const f = flags[i]; if (f & 4) { const d = b[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += b.readInt16BE(p); p += 2; } ys.push(v); }
    const out = [];
    for (let c = 0, s = 0; c < nc; c++) {
      const ct = [];
      for (let i = s; i <= ends[c]; i++) ct.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      out.push(ct);
      s = ends[c] + 1;
    }
    return out;
  }
  /** Width of a string at `size` (design units per em), with kerning and extra tracking (in em) */
  measure(text, size, tracking = 0) {
    let x = 0, prev = -1;
    for (const ch of text) {
      const g = this.glyphId(ch.codePointAt(0));
      if (prev >= 0) x += this.kern.get(prev * 65536 + g) ?? 0;
      x += this.advance(g) + tracking * this.upm;
      prev = g;
    }
    return ((x - tracking * this.upm) * size) / this.upm;
  }
  /** Flattened outline polylines (design units, y down) for a string whose baseline starts at (x, y) */
  outline(text, x, y, size, tracking = 0) {
    const k = size / this.upm, polys = [];
    let pen = 0, prev = -1;
    for (const ch of text) {
      const g = this.glyphId(ch.codePointAt(0));
      if (prev >= 0) pen += this.kern.get(prev * 65536 + g) ?? 0;
      for (const ct of this.contours(g)) {
        if (ct.length < 2) continue;
        // expand implied on-curve points, then flatten the quadratics
        const pts = [];
        for (let i = 0; i < ct.length; i++) {
          const a = ct[i], b = ct[(i + 1) % ct.length];
          pts.push(a);
          if (!a.on && !b.on) pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
        }
        const start = pts.findIndex((q) => q.on), m = pts.length, poly = [];
        const P = (q) => [x + (pen + q.x) * k, y - q.y * k];
        for (let i = 0; i < m; i++) {
          const a = pts[(start + i) % m];
          if (!a.on) continue;
          const b = pts[(start + i + 1) % m];
          poly.push(P(a));
          if (!b.on) {
            const c = pts[(start + i + 2) % m], [ax, ay] = P(a), [bx, by] = P(b), [cx, cy] = P(c);
            for (let s = 1; s < 10; s++) {
              const t = s / 10, u = 1 - t;
              poly.push([u * u * ax + 2 * u * t * bx + t * t * cx, u * u * ay + 2 * u * t * by + t * t * cy]);
            }
          }
        }
        polys.push(poly);
      }
      pen += this.advance(g) + tracking * this.upm;
      prev = g;
    }
    return polys;
  }
}

/** Fill polylines (non-zero winding) onto a canvas with 5x vertical / exact horizontal coverage */
export function fillPolys(canvas, polys, paint, opacity = 1) {
  const s = canvas.s, SUB = 5, edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    if (ay === by) continue;
    edges.push(ay < by ? [ax * s, ay * s, bx * s, by * s, 1] : [bx * s, by * s, ax * s, ay * s, -1]);
    minY = Math.min(minY, ay * s, by * s); maxY = Math.max(maxY, ay * s, by * s);
  }
  const cov = new Float32Array(canvas.w);
  for (let py = Math.max(0, Math.floor(minY)); py < Math.min(canvas.h, Math.ceil(maxY)); py++) {
    cov.fill(0);
    for (let sub = 0; sub < SUB; sub++) {
      const yy = py + (sub + 0.5) / SUB, xs = [];
      for (const e of edges) if (yy >= e[1] && yy < e[3]) xs.push([e[0] + ((yy - e[1]) / (e[3] - e[1])) * (e[2] - e[0]), e[4]]);
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0, from = 0;
      for (const [xc, dir] of xs) {
        if (wind === 0) from = xc;
        wind += dir;
        if (wind === 0) {
          const a = Math.max(0, from), b = Math.min(canvas.w, xc);
          for (let px = Math.floor(a); px < Math.ceil(b); px++) cov[px] += (Math.min(px + 1, b) - Math.max(px, a)) / SUB;
        }
      }
    }
    for (let px = 0; px < canvas.w; px++) {
      const a = Math.min(1, cov[px]) * opacity;
      if (a <= 0) continue;
      const c = paint((px + 0.5) / s, (py + 0.5) / s), i = (py * canvas.w + px) * 4, k = 1 - a;
      canvas.px[i] = c[0] * a + canvas.px[i] * k; canvas.px[i + 1] = c[1] * a + canvas.px[i + 1] * k;
      canvas.px[i + 2] = c[2] * a + canvas.px[i + 2] * k; canvas.px[i + 3] = a + canvas.px[i + 3] * k;
    }
  }
}

/** Draw text; align: "left" | "center" | "right". Returns the text width. */
export function text(canvas, font, str, x, y, size, paint, { tracking = 0, align = "left", opacity = 1 } = {}) {
  const w = font.measure(str, size, tracking);
  const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  fillPolys(canvas, font.outline(str, x0, y, size, tracking), typeof paint === "function" ? paint : solid(paint), opacity);
  return w;
}
