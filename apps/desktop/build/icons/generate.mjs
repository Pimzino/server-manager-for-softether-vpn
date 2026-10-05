// Generates the app icons and the DMG background. Everything is drawn in code by raster.mjs (distance-field
// shapes, OKLab gradients, TrueType outlines): there are no vector sources and no browser involved.
//
//   node build/icons/generate.mjs        (or: pnpm run icons)      macOS only (iconutil, Avenir Next system font)
//
// Outputs (committed, consumed by electron-builder, the MSI and the renderer):
//   build/icon.png            1024x1024 macOS-style icon (Big Sur grid: 824px squircle plate + shadow on a 1024 canvas)
//   build/icon.icns           macOS icon set 16..1024 (iconutil)
//   build/icon.ico            Windows icon: 16, 20, 24, 32, 40, 48, 64, 96, 128 as 32-bit BMP + 256 as PNG
//   build/background.png      DMG window background 540x380, plus background@2x.png (1080x760); dmg-builder merges them
//   src/renderer/assets/app-icon.png   256px icon shown in the sidebar, the welcome page and Preferences
//   resources/default.ico     fallback icon for the client packages the app builds (MSI, setup.exe) when a template
//                             has none; a smaller set of sizes because it is embedded in every package. Also copied
//                             to tools/setup-stub/default.ico, the icon source of the setup.exe launcher stubs.
//
// The mark is a hub: a hexagonal frame with three links meeting at a centre node (a SoftEther Virtual Hub and the
// servers joined to it), amber on charcoal.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Canvas, Font, box, circle, clamp, grain, grow, hex, intersect, linear, polygon, ring, segment, smooth, solid, squircle, text, union,
} from "./raster.mjs";

const buildDir = path.resolve(import.meta.dirname, "..");
const PRODUCT = "Server Manager for SoftEther VPN";
const C = 512;
const polar = (r, deg) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)];

/**
 * Draws the icon on a 1024 design grid whose plate is a squircle of half-size 412.
 * variant "mac": that plate with a drop shadow (Big Sur grid). "win": no outer shadow and a squarer plate; the
 * canvas is zoomed so the plate fills it (see winCanvas).
 */
function drawIcon(cv, variant) {
  const mac = variant === "mac";
  const PLATE = squircle(C, C, 412, mac ? 5 : 4.2);
  const inPlate = (x, y) => clamp(0.5 - PLATE(x, y) * cv.s);
  if (mac) cv.shadow(PLATE, "#000000", { dy: 18, blur: 34, opacity: 0.38 });
  const body = linear(200, 100, 820, 940, [[0, "#343946"], [1, "#14161b"]]);
  cv.fill(PLATE, (x, y) => { const c = body(x, y), n = grain(x, y) * 0.012; return [c[0] + n, c[1] + n, c[2] + n]; });
  // warm glow behind the mark
  const glow = hex("#ff9d1c");
  cv.shade((x, y) => [glow[0], glow[1], glow[2], 0.2 * (1 - smooth(60, 430, Math.hypot(x - C, y - C))) * inPlate(x, y)]);
  // light from the top left, a rim light on the top edge and a shade on the bottom edge
  cv.shade((x, y) => [1, 1, 1, 0.012 * (1 - smooth(90, 560, y + (x - C) * 0.25)) * inPlate(x, y)]);
  cv.shade((x, y) => {
    const d = PLATE(x, y);
    if (d > 0.5 || d < -5) return null;
    const edge = smooth(-5, -1.5, d) * inPlate(x, y), top = (C - y) / 412;
    return top > 0 ? [1, 1, 1, edge * 0.34 * clamp(top)] : [0, 0, 0, edge * 0.26 * clamp(-top)];
  });

  const hexagon = [0, 1, 2, 3, 4, 5].map((i) => polar(262 * 0.9, -90 + i * 60));
  const frame = ring(polygon(hexagon, 26), 44);
  const arms = [0, 1, 2].map((i) => segment(C, C, ...polar(250, -90 + i * 120), 40));
  const amber = linear(260, 220, 760, 820, [[0, "#ffd45e"], [0.5, "#ffae1f"], [1, "#ff7a1a"]]);
  const mark = union(frame, ...arms);
  cv.shadow(intersect(mark, grow(PLATE, -6)), "#000000", { dy: 10, blur: 18, opacity: 0.5 });
  cv.fill(mark, amber);
  // nodes: dark sockets with amber cores read as joints
  for (const [x, y, r] of [[C, C, 74], ...[0, 1, 2].map((i) => [...polar(262, -90 + i * 120), 54])]) {
    cv.fill(circle(x, y, r), amber);
    cv.fill(circle(x, y, r - 20), solid("#1a1c22"));
    cv.fill(circle(x, y, r - 36), linear(x - r, y - r, x + r, y + r, [[0, "#ffe08a"], [1, "#ff9a1a"]]));
  }
}
/** 1024px canvas zoomed about the centre so the 412 plate becomes 492 (it nearly fills a Windows icon) */
function winCanvas() {
  const k = 492 / 412;
  return new Canvas(1024, 1024, k, C / k - C, C / k - C);
}

function drawDmgBackground(cv) {
  // 540x380 logical; app icon at (140,190) and the Applications link at (400,190) (see electron-builder.config.mjs)
  const AVENIR = "/System/Library/Fonts/Avenir Next.ttc";
  const demi = new Font(AVENIR, 2), regular = new Font(AVENIR, 7);
  cv.fill(box(270, 190, 270, 190), linear(0, 0, 0, 380, [[0, "#fbfaf7"], [1, "#efece6"]]));
  text(cv, demi, PRODUCT, 270, 58, 20, "#1c1d22", { align: "center" });
  text(cv, regular, "Drag the app into the Applications folder to install it", 270, 84, 13, "#5d5f68", { align: "center" });
  cv.fill(union(segment(222, 190, 316, 190, 5), segment(300, 174, 318, 190, 5), segment(300, 206, 318, 190, 5)), solid("#c9a25a"));
  text(cv, regular, "Manage SoftEther VPN Servers from macOS and Windows", 270, 352, 11, "#93959d", { align: "center" });
}

/** 32-bit BMP (DIB) icon image: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask. */
function dibEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function writeIco(file, images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((im, i) => {
    const o = 6 + 16 * i;
    head[o] = im.size >= 256 ? 0 : im.size;
    head[o + 1] = im.size >= 256 ? 0 : im.size;
    head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(im.data.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += im.data.length;
  });
  writeFileSync(file, Buffer.concat([head, ...images.map((im) => im.data)]));
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "sem-icons-"));
try {
  // Each icon is drawn once at 1024 and area-averaged down in linear light for the smaller sizes
  const mac = new Canvas(1024, 1024, 1);
  drawIcon(mac, "mac");
  mac.save(path.join(buildDir, "icon.png"));
  mac.resized(256, 256).save(path.resolve(buildDir, "../src/renderer/assets/app-icon.png"));
  const iconset = path.join(tmp, "icon.iconset");
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = base * scale;
      (px === 1024 ? mac : mac.resized(px, px)).save(path.join(iconset, `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`));
    }
  }
  // iconutil runs in the temp dir (APFS); an exFAT project volume would add ._* files to the iconset
  execFileSync("iconutil", ["-c", "icns", "-o", path.join(tmp, "icon.icns"), iconset]);
  copyFileSync(path.join(tmp, "icon.icns"), path.join(buildDir, "icon.icns"));

  // Windows: multi-resolution ico (BMP for <=128 for maximum compatibility, PNG for 256)
  const win = winCanvas();
  drawIcon(win, "win");
  const icoImages = (sizes) => sizes.map((size) => {
    const r = win.resized(size, size);
    return { size, data: size >= 256 ? r.png() : dibEntry(size, r.rgba()) };
  });
  writeIco(path.join(buildDir, "icon.ico"), icoImages([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]));
  const fallback = path.resolve(buildDir, "../resources/default.ico");
  writeIco(fallback, icoImages([16, 24, 32, 48, 64, 256]));
  copyFileSync(fallback, path.resolve(buildDir, "../../../tools/setup-stub/default.ico"));

  // DMG background (@1x + @2x; dmg-builder combines them into a HiDPI tiff with tiffutil)
  for (const [scale, name] of [[1, "background.png"], [2, "background@2x.png"]]) {
    const bg = new Canvas(540 * scale, 380 * scale, scale);
    drawDmgBackground(bg);
    bg.save(path.join(buildDir, name));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Sanity report
const ico = readFileSync(path.join(buildDir, "icon.ico"));
const n = ico.readUInt16LE(4);
const sizes = Array.from({ length: n }, (_, i) => ico[6 + 16 * i] || 256);
console.log(`icon.ico: ${n} images (${sizes.join(", ")})`);
console.log(execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path.join(buildDir, "icon.png")]).toString().trim());
console.log(execFileSync("file", [path.join(buildDir, "icon.icns")]).toString().trim());
