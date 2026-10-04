#!/usr/bin/env python3
"""Generate the default application icon (shield) as a multi-size .ico with PNG entries (Vista+)."""
import math, struct, sys, zlib

def png(size):
    w = h = size
    rows = []
    cx, top, bot = w / 2, h * 0.08, h * 0.94
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            # rounded square background
            r = size * 0.18
            dx = max(abs(x + 0.5 - w / 2) - (w / 2 - r), 0)
            dy = max(abs(y + 0.5 - h / 2) - (h / 2 - r), 0)
            inside_bg = dx * dx + dy * dy <= r * r
            # shield: flat top, curved bottom point
            t = (y - top) / (bot - top)
            half = (w * 0.30) * (1 if t < 0.45 else math.cos((t - 0.45) / 0.55 * math.pi / 2))
            inside_shield = 0 <= t <= 1 and abs(x + 0.5 - cx) <= half
            if inside_shield and size >= 24:
                # check mark
                px, py = (x + 0.5) / w, (y + 0.5) / h
                d1 = abs((py - 0.52) - (px - 0.40)) / math.sqrt(2) if 0.33 <= px <= 0.47 else 9
                d2 = abs((py - 0.59) + (px - 0.47)) / math.sqrt(2) if 0.46 <= px <= 0.68 else 9
                if min(d1, d2) < 0.045:
                    row += bytes((28, 126, 214, 255)); continue
                row += bytes((255, 255, 255, 255))
            elif inside_bg:
                row += bytes((28, 126, 214, 255))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [png(s) for s in sizes]
out = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
for s, d in zip(sizes, imgs):
    out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(d), offset)
    offset += len(d)
out += b"".join(imgs)
open(sys.argv[1] if len(sys.argv) > 1 else "default.ico", "wb").write(out)
print("icon written", len(out), "bytes")
