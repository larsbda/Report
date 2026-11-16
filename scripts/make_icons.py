"""One-off: draws the app icon (sunrise over a horizon) as PNGs with no dependencies."""
import math, struct, zlib, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "web" / "icons"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def pixel(x, y):
    # x, y in 0..1
    top, mid = (31, 41, 70), (240, 138, 69)
    sky = lerp(top, mid, min(1, max(0, (y - 0.05) / 0.62)))
    horizon = 0.66
    cx, cy, r = 0.5, horizon, 0.21
    d = math.hypot(x - cx, y - cy)
    if y < horizon:
        glow = max(0, 1 - d / 0.45) ** 2
        sky = lerp(sky, (255, 214, 150), glow * 0.55)
        if d < r:
            return lerp((255, 236, 190), (255, 196, 110), d / r)
        return sky
    # water: darker band with soft reflection stripes
    t = (y - horizon) / (1 - horizon)
    water = lerp((60, 50, 70), (24, 26, 44), t)
    if abs(x - cx) < r * (1 - t * 0.6) and int((y - horizon) * 60) % 3 == 0:
        water = lerp(water, (250, 180, 110), 0.55 * (1 - t))
    return water


def png(size, path):
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            row.extend(pixel((i + 0.5) / size, (j + 0.5) / size))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    path.write_bytes(data)


OUT.mkdir(parents=True, exist_ok=True)
png(180, OUT / "apple-touch-icon.png")
png(192, OUT / "icon-192.png")
png(512, OUT / "icon-512.png")
print("icons written to", OUT)
