// The six logo studies. Each icon is drawn on a 1024 design grid: an 824px squircle plate (macOS icon grid)
// with a soft shadow, then the mark. icon(name)(canvas) paints onto any canvas whose scale maps 1024 -> its size.
import {
  box, circle, clamp, grain, grow, hex, intersect, linear, mix, polygon, radial, ramp, ring, rotate, segment, smooth,
  solid, squircle, subtract, union,
} from "./lib.mjs";

const C = 512;
const PLATE = squircle(C, C, 412, 5);
const rad = (d) => (d * Math.PI) / 180;
const polar = (r, deg, cx = C, cy = C) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];

/** Plate: drop shadow, gradient body, grain, top sheen and a thin inner rim light */
function plate(cv, paint, { shadow = "#000000", sheen = 0.02, extra } = {}) {
  cv.shadow(PLATE, shadow, { dy: 18, blur: 34, opacity: 0.38 });
  cv.fill(PLATE, (x, y) => {
    const c = paint(x, y), n = grain(x, y) * 0.012;
    return [c[0] + n, c[1] + n, c[2] + n];
  });
  if (extra) extra();
  // sheen: light falling from the top-left, clipped to the plate
  cv.shade((x, y) => {
    const d = PLATE(x, y);
    if (d > 0.5) return null;
    const a = sheen * (1 - smooth(90, 560, y + (x - C) * 0.25)) * clamp(0.5 - d * cv.s);
    return [1, 1, 1, a];
  });
  // rim light on the top edge, shade on the bottom edge
  cv.shade((x, y) => {
    const d = PLATE(x, y);
    if (d > 0.5 || d < -5) return null;
    const edge = (1 - smooth(-4.5, -0.5, d) < 1 ? smooth(-5, -1.5, d) : 1) * clamp(0.5 - d * cv.s);
    const top = clamp((C - y) / 412);
    return top > 0 ? [1, 1, 1, edge * 0.34 * top] : [0, 0, 0, edge * 0.26 * -clamp((C - y) / 412, -1, 0)];
  });
}
/** A mark: soft shadow underneath, then the fill */
function mark(cv, sdf, paint, { shadow = "#000000", opacity = 0.28, blur = 16, dy = 10 } = {}) {
  cv.shadow(intersect(sdf, grow(PLATE, -6)), shadow, { dy, blur, opacity });
  cv.fill(sdf, paint);
}

export const OPTIONS = [
  {
    key: "helm", name: "Helm", tagline: "",
    idea: "A ship's helm that is also a six-spoke hub: steering many servers.",
    colors: ["#081a3a", "#0b4f8a", "#19c3c8"], ink: "#0b2a55",
    draw(cv) {
      plate(cv, linear(180, 120, 860, 920, [[0, "#0a1f44"], [0.55, "#0b5c9a"], [1, "#19c3c8"]]), {
        extra: () => {
          // faint sonar rings behind the wheel
          cv.shade((x, y) => {
            if (PLATE(x, y) > 0) return null;
            const r = Math.hypot(x - C, y - C);
            const band = Math.abs(((r + 30) % 78) - 39);
            return [1, 1, 1, 0.045 * (1 - smooth(0.6, 2.2, band)) * smooth(430, 250, r)];
          });
        },
      });
      const spokes = [];
      for (let i = 0; i < 6; i++) {
        const a = -90 + i * 60, [x0, y0] = polar(40, a), [x1, y1] = polar(288, a);
        spokes.push(segment(x0, y0, x1, y1, 30), circle(...polar(292, a), 31));
      }
      const wheel = union(ring(circle(C, C, 196), 40), ...spokes, circle(C, C, 62));
      mark(cv, wheel, linear(300, 220, 720, 800, [[0, "#ffffff"], [1, "#c9f4f6"]]), { shadow: "#031028", opacity: 0.42 });
      cv.fill(circle(C, C, 27), linear(480, 480, 545, 545, [[0, "#0b4f8a"], [1, "#0f86a6"]]));
    },
  },
  {
    key: "hub", name: "Hub", tagline: "",
    idea: "Three links joining at a centre node inside a hexagonal hub.",
    colors: ["#15171c", "#2b2f3a", "#ffb020"], ink: "#1b1d23",
    draw(cv) {
      plate(cv, linear(200, 100, 820, 940, [[0, "#343946"], [1, "#14161b"]]), {
        sheen: 0.012,
        extra: () => cv.fill(PLATE, radial(C, 470, 420, [[0, "#ffb020"], [1, "#ffb020"]]), { opacity: 0 }) && cv.shade((x, y) => {
          if (PLATE(x, y) > 0) return null;
          const c = hex("#ff9d1c");
          return [c[0], c[1], c[2], 0.2 * (1 - smooth(60, 430, Math.hypot(x - C, y - C)))];
        }),
      });
      const hexPts = [0, 1, 2, 3, 4, 5].map((i) => polar(262, -90 + i * 60));
      const frame = ring(polygon(hexPts.map(([x, y]) => [C + (x - C) * 0.9, C + (y - C) * 0.9]), 26), 44);
      const arms = [0, 1, 2].map((i) => segment(C, C, ...polar(250, -90 + i * 120), 40));
      const amber = linear(260, 220, 760, 820, [[0, "#ffd45e"], [0.5, "#ffae1f"], [1, "#ff7a1a"]]);
      mark(cv, union(frame, ...arms), amber, { opacity: 0.5, blur: 18 });
      // nodes: dark sockets with amber cores read as "joints"
      for (const [x, y, r] of [[C, C, 74], ...[0, 1, 2].map((i) => [...polar(262, -90 + i * 120), 54])]) {
        cv.fill(circle(x, y, r), amber);
        cv.fill(circle(x, y, r - 20), solid("#1a1c22"));
        cv.fill(circle(x, y, r - 36), linear(x - r, y - r, x + r, y + r, [[0, "#ffe08a"], [1, "#ff9a1a"]]));
      }
    },
  },
  {
    key: "links", name: "Links", tagline: "",
    idea: "Two chain links woven over and under: client and server joined.",
    colors: ["#2a1380", "#6d3bff", "#ff5fa8"], ink: "#2a1380",
    draw(cv) {
      const bg = linear(160, 140, 880, 900, [[0, "#2a1380"], [0.55, "#6d3bff"], [1, "#ff5fa8"]]);
      plate(cv, bg);
      // both links lie along the rising diagonal and overlap by their end caps, which cross at two points
      const k = Math.SQRT1_2, off = 142;
      const link = (cx, cy) => rotate(ring(box(cx, cy, 200, 124, 124), 56), cx, cy, -45);
      const A = link(C - off * k, C + off * k), B = link(C + off * k, C - off * k);
      const white = linear(240, 240, 800, 800, [[0, "#ffffff"], [1, "#eadfff"]]);
      // A passes over B at the upper-left crossing and under it at the lower-right one
      const upper = (x, y) => x + y - 1024, lower = (x, y) => 1024 - x - y;
      // the gap tapers to nothing towards the line between the two crossings, so it leaves no seam there
      const gap = (over, under, zone) => cv.fill((x, y) => Math.max(over(x, y) - 18 * smooth(0, 36, -zone(x, y) * k), under(x, y), zone(x, y)), bg);
      cv.shadow(intersect(union(A, B), grow(PLATE, -6)), "#1b0a5c", { dy: 10, blur: 16, opacity: 0.4 });
      cv.fill(B, white);
      gap(A, B, upper);
      cv.fill(A, white);
      gap(B, A, lower);
      cv.fill(intersect(B, lower), white);
    },
  },
  {
    key: "arches", name: "Arches", tagline: "",
    idea: "A tunnel seen head-on: concentric arches with a light at the end.",
    colors: ["#04352a", "#0b8f66", "#7cf2c0"], ink: "#064e3b",
    draw(cv) {
      plate(cv, linear(240, 100, 780, 940, [[0, "#0fae7c"], [0.6, "#087355"], [1, "#04352a"]]));
      const base = 716;
      const arch = (r) => union(circle(C, 500, r), box(C, 500 + (base - 500) / 2 + 40, r, (base - 500) / 2 + 40));
      const floor = (x, y) => y - base;
      const tones = [["#ffffff", 1], ["#d9fbe9", 0.92], ["#a8f5d2", 0.82]];
      [268, 176, 84].forEach((r, i) => {
        const shape = i === 2 ? intersect(arch(r + 23), floor) : intersect(ring(arch(r), 46), floor);
        cv.shadow(intersect(shape, grow(PLATE, -6)), "#012018", { dy: 10, blur: 16, opacity: 0.34 });
        cv.fill(shape, i === 2 ? linear(C, 400, C, base, [[0, "#fff7c2"], [1, "#ffd76a"]]) : solid(tones[i][0]), { opacity: tones[i][1] });
      });
      // the road
      cv.fill(box(C, base + 44, 300, 17, 17), solid("#ffffff"), { opacity: 0.95 });
    },
  },
  {
    key: "orbit", name: "Orbit", tagline: "",
    idea: "A lit sphere with a ring passing behind and in front of it.",
    colors: ["#170f3f", "#c2317a", "#ffa24c"], ink: "#2a1454",
    draw(cv) {
      plate(cv, linear(220, 80, 800, 960, [[0, "#170f3f"], [0.5, "#5b1e7a"], [0.8, "#d13f78"], [1, "#ffa24c"]]), {
        sheen: 0.012,
        extra: () => cv.shade((x, y) => {
          // stars
          if (PLATE(x, y) > -20) return null;
          const gx = Math.floor(x / 46), gy = Math.floor(y / 46);
          const h = Math.abs(Math.sin(gx * 127.1 + gy * 311.7) * 43758.5453) % 1;
          if (h < 0.72) return null;
          const sx = (gx + 0.2 + 0.6 * ((h * 7.3) % 1)) * 46, sy = (gy + 0.2 + 0.6 * ((h * 13.7) % 1)) * 46;
          const r = 1.6 + 2.6 * ((h * 3.1) % 1);
          return [1, 1, 1, 0.75 * clamp(1 - Math.hypot(x - sx, y - sy) / r) * smooth(900, 300, y)];
        }),
      });
      const planet = circle(C, C, 176);
      // ring: an ellipse stroke, tilted; drawn in two halves (behind / in front of the planet)
      const tilt = -24, rx = 334, ry = 100, w = 40;
      const ell = (x, y) => {
        const a = rad(-tilt), dx = x - C, dy = y - C, u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
        const k = Math.hypot(u / rx, v / ry), g = Math.hypot(u / (rx * rx), v / (ry * ry)) || 1e-6;
        return { d: Math.abs(((k - 1) * k) / g) - w / 2, v };
      };
      const gold = linear(200, 380, 830, 640, [[0, "#fff1c4"], [0.5, "#ffc861"], [1, "#ff9d4a"]]);
      const half = (front) => (x, y) => { const e = ell(x, y); return Math.max(e.d, front ? -e.v : e.v); };
      cv.fill(half(false), gold, { opacity: 0.9 });
      cv.shadow(intersect(planet, grow(PLATE, -6)), "#0c0626", { dy: 12, blur: 22, opacity: 0.45 });
      cv.fill(planet, (x, y) => {
        // lit sphere: light from the upper left
        const nx = (x - C) / 176, ny = (y - C) / 176, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const l = clamp(nx * -0.5 + ny * -0.62 + nz * 0.6);
        return ramp([[0, "#6a2a8c"], [0.45, "#e9c4f2"], [1, "#ffffff"]])(l);
      });
      cv.shadow(intersect(half(true), planet), "#2a0a3a", { dy: 12, blur: 12, opacity: 0.4 });
      cv.fill(half(true), gold);
    },
  },
  {
    key: "shield", name: "Shield", tagline: "",
    idea: "A shield with a tunnel through it, closest to the current icon.",
    colors: ["#0a2a8f", "#1f6bff", "#6fc2ff"], ink: "#0a2a8f",
    draw(cv) {
      plate(cv, linear(200, 100, 820, 940, [[0, "#3f9bff"], [0.5, "#1857e6"], [1, "#0a2a8f"]]));
      // shield outline as a polygon (straight shoulders, sides sweeping to the point), corners rounded by 30
      const cubic = (p0, p1, p2, p3, n = 24) => Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n, u = 1 - t;
        return [0, 1].map((j) => u * u * u * p0[j] + 3 * u * u * t * p1[j] + 3 * u * t * t * p2[j] + t * t * t * p3[j]);
      });
      const right = [[228, 252], ...cubic([228, 450], [228, 610], [130, 716], [0, 790])];
      const pts = [...right.map(([x, y]) => [C + x, y]), ...right.slice(0, -1).reverse().map(([x, y]) => [C - x, y])];
      const shield = polygon(pts, 30);
      mark(cv, shield, linear(280, 220, 740, 820, [[0, "#ffffff"], [1, "#d3e7ff"]]), { shadow: "#03154d", opacity: 0.45, blur: 20 });
      // tunnel doorway cut into the shield, with depth rings and a light
      const door = (r) => union(circle(C, 452, r), box(C, 452 + 100, r, 100));
      const clip = (x, y) => y - 618;
      const blue = linear(C, 300, C, 630, [[0, "#2a78ff"], [1, "#0a2a8f"]]);
      cv.fill(intersect(door(138), clip), blue);
      cv.fill(intersect(ring(door(92), 18), clip), solid("#8fd0ff"), { opacity: 0.9 });
      cv.fill(intersect(door(46), clip), linear(C, 410, C, 620, [[0, "#ffffff"], [1, "#bfe3ff"]]));
    },
  },
];
