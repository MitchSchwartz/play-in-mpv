# Renders the PNG icons from the shapes in icon.svg (antialiased by supersampling),
# with a simpler 16px design, in colour (a feed found) and grey (none: icon*-off.png). No dependencies: python3 extension/icons/render_icons.py extension/icons
import math, struct, sys, zlib

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def in_rrect(px, py, x, y, w, h, r):
    cx, cy = min(max(px, x + r), x + w - r), min(max(py, y + r), y + h - r)
    return x <= px <= x + w and y <= py <= y + h and math.hypot(px - cx, py - cy) <= r

def in_tri(px, py, pts):
    s = []
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
        s.append((bx - ax) * (py - ay) - (by - ay) * (px - ax))
    return all(v >= 0 for v in s) or all(v <= 0 for v in s)

def stroke(segs, w):
    return lambda x, y: any(seg_dist(x, y, *s) <= w / 2 for s in segs)

def tri(pts, w):  # filled triangle with a rounded stroke of width w
    edges = [(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:] + pts[:1])]
    return lambda x, y: in_tri(x, y, pts) or any(seg_dist(x, y, *e) <= w / 2 for e in edges)

DARK, GREY = (0x1e, 0x1e, 0x1e), (0x55, 0x55, 0x55)

def designs(GREEN, WHITE):
    full = (128, [
        (DARK, lambda x, y: in_rrect(x, y, 4, 4, 120, 120, 28)),
        (GREY, lambda x, y: in_rrect(x, y, 16, 26, 80, 80, 16) and not in_rrect(x, y, 24, 34, 64, 64, 8)),
        (GREEN, tri([(44, 44), (44, 88), (82, 66)], 6)),
        (WHITE, stroke([(78, 22, 106, 22), (106, 22, 106, 50), (104, 24, 80, 48)], 9)),
    ])
    small = (16, [
        (DARK, lambda x, y: in_rrect(x, y, 0, 0, 16, 16, 3.5)),
        (GREEN, tri([(3.5, 4), (3.5, 13), (11, 8.5)], 1)),
        (WHITE, stroke([(10, 2.2, 13.8, 2.2), (13.8, 2.2, 13.8, 6), (13.5, 2.5, 10.5, 5.5)], 1.6)),
    ])
    return full, small

def render(design, size, ss=6):
    unit, shapes = design
    k = unit / size
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x, y = (px + (sx + .5) / ss) * k, (py + (sy + .5) / ss) * k
                    col = None
                    for c, test in shapes:
                        if test(x, y):
                            col = c
                    if col:
                        r += col[0]; g += col[1]; b += col[2]; a += 1
            n = ss * ss
            row += bytes([round(r / a) if a else 0, round(g / a) if a else 0, round(b / a) if a else 0, round(255 * a / n)])
        rows.append(bytes(row))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))

out = sys.argv[1]
for suffix, green, white in [("", (0x43, 0xa0, 0x47), (255, 255, 255)), ("-off", (0x8a, 0x8a, 0x8a), (0xb0, 0xb0, 0xb0))]:
    full, small = designs(green, white)
    for size, design in [(16, small), (32, full), (48, full), (128, full)]:
        with open(f"{out}/icon{size}{suffix}.png", "wb") as f:
            f.write(render(design, size))
