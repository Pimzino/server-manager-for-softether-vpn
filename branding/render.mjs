// Renders the logo studies to branding/out/ (PNG only, everything drawn in code):
//   <key>-icon-{1024,512,256,64,32}.png   app icon on a transparent background
//   <key>-lockup.png                      icon + wordmark + tagline, on light and on dark
//   overview.png                          all options side by side with their small sizes
// usage: node branding/render.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Canvas, Font, box, hex, linear, solid, text } from "./lib.mjs";
import { OPTIONS } from "./icons.mjs";

const out = path.join(import.meta.dirname, "out");
mkdirSync(out, { recursive: true });
const AVENIR = "/System/Library/Fonts/Avenir Next.ttc";
const demi = new Font(AVENIR, 2), medium = new Font(AVENIR, 5), regular = new Font(AVENIR, 7);

const PRODUCT = "Server Manager", SUFFIX = "for SoftEther VPN";
const masters = {};
for (const o of OPTIONS) {
  const cv = new Canvas(1024, 1024, 1);
  o.draw(cv);
  masters[o.key] = cv;
  cv.save(path.join(out, `${o.key}-icon-1024.png`));
  for (const s of [512, 256, 64, 32]) cv.resized(s, s).save(path.join(out, `${o.key}-icon-${s}.png`));
  console.log("icon", o.key);
}

// ---- lockups: 2400 x 1400, light half above dark half
for (const o of OPTIONS) {
  const W = 2400, H = 1400, cv = new Canvas(W, H, 1);
  const icon = masters[o.key].resized(560, 560);
  const halves = [
    { y: 0, bg: linear(0, 0, 0, 700, [[0, "#ffffff"], [1, "#f1f3f7"]]), name: o.ink, sub: "#5b6472", rule: "#d9dee6" },
    { y: 700, bg: linear(0, 700, 0, 1400, [[0, "#14161c"], [1, "#0b0c10"]]), name: "#ffffff", sub: "#a7afbd", rule: "#2a2e38" },
  ];
  for (const h of halves) {
    cv.fill(box(W / 2, h.y + 350, W / 2, 350), h.bg);
    cv.draw(icon, 150, h.y + 70);
    const x = 790;
    text(cv, demi, PRODUCT, x, h.y + 350, 200, h.name, { tracking: -0.014 });
    text(cv, medium, SUFFIX, x + 6, h.y + 470, 84, h.sub);
    cv.fill(box(x + 52, h.y + 548, 46, 5, 5), linear(x, 0, x + 104, 0, [[0, o.colors[1]], [1, o.colors[2]]]));
  }
  cv.save(path.join(out, `${o.key}-lockup.png`));
  console.log("lockup", o.key);
}

// ---- overview: every option with its name, idea and small sizes
{
  const W = 2700, H = 2140, cv = new Canvas(W, H, 1);
  cv.fill(box(W / 2, H / 2, W / 2, H / 2), linear(0, 0, 0, H, [[0, "#f6f7fa"], [1, "#e8ebf1"]]));
  text(cv, demi, "Server Manager for SoftEther VPN: logo options", 90, 130, 76, "#14161c", { tracking: -0.01 });
  text(cv, regular, "Six marks for the same name. Every pixel is drawn by code (branding/render.mjs).", 92, 190, 34, "#5b6472");
  const cw = 820, ch = 900, gx = 30, x0 = 90, y0 = 250;
  OPTIONS.forEach((o, i) => {
    const x = x0 + (i % 3) * (cw + gx), y = y0 + Math.floor(i / 3) * (ch + gx), cx = x + cw / 2;
    const card = box(cx, y + ch / 2, cw / 2, ch / 2, 44);
    cv.shadow(card, "#1b2233", { dy: 10, blur: 28, opacity: 0.1 });
    cv.fill(card, solid("#ffffff"));
    text(cv, medium, String(i + 1).padStart(2, "0"), x + 44, y + 76, 34, o.colors[1], { tracking: 0.04 });
    cv.draw(masters[o.key].resized(440, 440), cx - 220, y + 40);
    text(cv, medium, o.name.toUpperCase(), x + 100, y + 76, 30, "#6b7482", { tracking: 0.12 });
    text(cv, demi, PRODUCT, cx, y + 572, 84, o.ink, { align: "center", tracking: -0.014 });
    text(cv, medium, SUFFIX, cx, y + 626, 38, "#5b6472", { align: "center" });
    // idea, wrapped to two lines
    const words = o.idea.split(" "), lines = [""];
    for (const w of words) {
      const t = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
      if (regular.measure(t, 27) > cw - 150) lines.push(w); else lines[lines.length - 1] = t;
    }
    lines.forEach((l, k) => text(cv, regular, l, cx, y + 692 + k * 38, 27, "#7a8290", { align: "center" }));
    // small sizes: 96, 64, 32, 16 as they would appear in a dock, taskbar or title bar
    const sizes = [96, 64, 32, 16], gap = 34, total = sizes.reduce((a, b) => a + b, 0) + gap * (sizes.length - 1);
    let sx = cx - total / 2;
    for (const s of sizes) { cv.draw(masters[o.key].resized(s, s), sx, y + 862 - s); sx += s + gap; }
    // palette
    o.colors.forEach((c, k) => cv.fill(box(x + cw - 60 - k * 40, y + 62, 14, 14, 14), solid(c)));
  });
  cv.save(path.join(out, "overview.png"));
  console.log("overview");
}
