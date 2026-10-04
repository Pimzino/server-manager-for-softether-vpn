// Generates the app icons and the DMG background from vector sources, using Playwright's Chromium to rasterise.
//
//   node build/icons/generate.mjs        (or: pnpm run icons)
//
// Outputs (committed, consumed by electron-builder and the MSI):
//   build/icon.png            1024x1024 macOS-style icon (Big Sur grid: 824px squircle plate + shadow on a 1024 canvas)
//   build/icon.icns           macOS icon set 16..1024 (iconutil)
//   build/icon.ico            Windows icon: 16, 20, 24, 32, 40, 48, 64, 96, 128 as 32-bit BMP + 256 as PNG
//   build/background.png      DMG window background 540x380, plus background@2x.png (1080x760); dmg-builder merges them
//   build/icons/icon-mac.svg, icon-win.svg, dmg-background.svg   the vector sources that were rendered
//
// The motif (white shield + check on blue) follows the original product icon in /Icon/Icon.ProductIcon.ico, whose
// largest image is only 256px and full-bleed, which is too small and the wrong shape for macOS.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const buildDir = path.resolve(import.meta.dirname, "..");
const iconsDir = import.meta.dirname;

/** Superellipse ("squircle") path centred at (c,c) with half-size r, exponent n. */
function squircle(c, r, n = 5, steps = 256) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    const x = c + r * Math.sign(ct) * Math.abs(ct) ** (2 / n);
    const y = c + r * Math.sign(st) * Math.abs(st) ** (2 / n);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** variant "mac": Big Sur grid (plate 824/1024 with drop shadow). "win": plate fills the canvas, no outer shadow. */
function iconSvg(variant) {
  const mac = variant === "mac";
  const plateR = mac ? 412 : 492;
  const k = plateR / 412; // the artwork is drawn for the mac plate and scaled for the Windows one
  const plate = squircle(512, plateR, mac ? 5 : 4.2);
  const art = `
    <g transform="translate(512 512) scale(${k.toFixed(4)}) translate(-512 -512)">
      <path d="M512 244 C452 290 386 311 316 313 L316 518 C316 650 398 742 512 796 C626 742 708 650 708 518 L708 313 C638 311 572 290 512 244 Z"
            fill="url(#shield)" filter="url(#shieldShadow)"/>
      <path d="M512 244 C452 290 386 311 316 313 L316 518 C316 650 398 742 512 796 Z" fill="#FFFFFF" opacity="0.35"/>
      <path d="M414 522 L488 596 L616 454" fill="none" stroke="url(#check)" stroke-width="60" stroke-linecap="round" stroke-linejoin="round"/>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4BA3FF"/>
      <stop offset="0.55" stop-color="#2A7DEB"/>
      <stop offset="1" stop-color="#1656CC"/>
    </linearGradient>
    <radialGradient id="gloss" cx="0.5" cy="0" r="0.9">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#DCE8FF"/>
    </linearGradient>
    <linearGradient id="check" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3A8BFA"/>
      <stop offset="1" stop-color="#1552C6"/>
    </linearGradient>
    <filter id="plateShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.30"/>
    </filter>
    <filter id="shieldShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0A2F7A" flood-opacity="0.35"/>
    </filter>
  </defs>
  <path d="${plate}" fill="url(#plate)"${mac ? ` filter="url(#plateShadow)"` : ""}/>
  <path d="${plate}" fill="url(#gloss)"/>
  <path d="${plate}" fill="none" stroke="#0B3F9E" stroke-opacity="0.25" stroke-width="2"/>${art}
</svg>
`;
}

function dmgBackgroundSvg() {
  // 540x380 logical; app icon at (140,190) and the Applications link at (400,190) (see electron-builder.config.mjs)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F7FAFF"/>
      <stop offset="1" stop-color="#E6EEFA"/>
    </linearGradient>
  </defs>
  <rect width="540" height="380" fill="url(#bg)"/>
  <text x="270" y="58" text-anchor="middle" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
        font-size="20" font-weight="600" fill="#1C2B45">SoftEther Manager</text>
  <text x="270" y="84" text-anchor="middle" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"
        font-size="13" fill="#51607A">Drag the app into the Applications folder to install it</text>
  <g fill="none" stroke="#7F9CC8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M222 190 H316"/>
    <path d="M300 174 L318 190 L300 206"/>
  </g>
  <text x="270" y="352" text-anchor="middle" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
        font-size="11" fill="#8A97AD">Manage SoftEther VPN Servers from macOS and Windows</text>
</svg>
`;
}

/** Render an SVG at the given pixel sizes; returns { png: Buffer, rgba: Buffer } per size. */
async function rasterise(page, svg, width, height) {
  return page.evaluate(async ({ svg, width, height }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    let bin = "";
    for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgba.subarray(i, i + 0x8000));
    return { png: c.toDataURL("image/png").split(",")[1], rgba: btoa(bin) };
  }, { svg, width, height }).then((r) => ({ png: Buffer.from(r.png, "base64"), rgba: Buffer.from(r.rgba, "base64") }));
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

const macSvg = iconSvg("mac");
const winSvg = iconSvg("win");
const bgSvg = dmgBackgroundSvg();
writeFileSync(path.join(iconsDir, "icon-mac.svg"), macSvg);
writeFileSync(path.join(iconsDir, "icon-win.svg"), winSvg);
writeFileSync(path.join(iconsDir, "dmg-background.svg"), bgSvg);

const browser = await chromium.launch();
const tmp = mkdtempSync(path.join(os.tmpdir(), "sem-icons-"));
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");

  // macOS: icon.png (1024) + icns
  const mac1024 = await rasterise(page, macSvg, 1024, 1024);
  writeFileSync(path.join(buildDir, "icon.png"), mac1024.png);
  const iconset = path.join(tmp, "icon.iconset");
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = base * scale;
      const r = px === 1024 ? mac1024 : await rasterise(page, macSvg, px, px);
      writeFileSync(path.join(iconset, `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`), r.png);
    }
  }
  // iconutil runs in the temp dir (APFS); the exFAT project volume would add ._* files to the iconset
  execFileSync("iconutil", ["-c", "icns", "-o", path.join(tmp, "icon.icns"), iconset]);
  copyFileSync(path.join(tmp, "icon.icns"), path.join(buildDir, "icon.icns"));

  // Windows: multi-resolution ico (BMP for <=128 for maximum compatibility, PNG for 256)
  const images = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
    const r = await rasterise(page, winSvg, size, size);
    images.push({ size, data: size >= 256 ? r.png : dibEntry(size, r.rgba) });
  }
  writeIco(path.join(buildDir, "icon.ico"), images);

  // DMG background (@1x + @2x; dmg-builder combines them into a HiDPI tiff with tiffutil)
  writeFileSync(path.join(buildDir, "background.png"), (await rasterise(page, bgSvg, 540, 380)).png);
  writeFileSync(path.join(buildDir, "background@2x.png"), (await rasterise(page, bgSvg, 1080, 760)).png);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Sanity report
const ico = readFileSync(path.join(buildDir, "icon.ico"));
const n = ico.readUInt16LE(4);
const sizes = Array.from({ length: n }, (_, i) => ico[6 + 16 * i] || 256);
console.log(`icon.ico: ${n} images (${sizes.join(", ")})`);
console.log(execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path.join(buildDir, "icon.png")]).toString().trim());
console.log(execFileSync("file", [path.join(buildDir, "icon.icns")]).toString().trim());
