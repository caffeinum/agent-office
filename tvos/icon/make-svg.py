# Writes the app icon layers as SVG: back.svg (sky) and front.svg (an isometric voxel office island, transparent).
# Both are 1280x768 (tvOS app icon aspect 5:3); render.swift turns them into the asset catalog's PNGs.
import os

K = 40  # px per world unit
OX, OY = 640, 205  # where world (0, 0, 0) lands


def P(x, y, z):
    return (OX + (x - z) * K, OY + (x + z) * K / 2 - y * K)


def poly(pts, fill, extra=""):
    d = " ".join(f"{px:.1f},{py:.1f}" for px, py in pts)
    return f'<polygon points="{d}" fill="{fill}" {extra}/>'


def shade(hexc, f):
    r, g, b = (int(hexc[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c * f))) for c in (r, g, b))


def box(x0, y0, z0, x1, y1, z1, color, top=None):
    """Top, +z (left-front) and +x (right-front) faces: the three a viewer from +x+z sees."""
    return [
        poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], top or color),
        poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], shade(color, 0.82)),
        poly([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], shade(color, 0.68)),
    ]


out = []
# the island: grass top on a sandstone plinth
out += box(-2.2, -1.1, -2.2, 12.2, 0, 12.2, "#cfbb9b", top="#79b85a")
# wood floor with plank seams
out.append(poly([P(0, 0.01, 0), P(10, 0.01, 0), P(10, 0.01, 10), P(0, 0.01, 10)], "#d9b086"))
for z in range(1, 10):
    a, b = P(0, 0.01, z), P(10, 0.01, z)
    out.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="#c39a6f" stroke-width="2"/>')
# back walls (inner faces), trim caps
out.append(poly([P(0, 0, 0), P(10, 0, 0), P(10, 4, 0), P(0, 4, 0)], "#f3e6cf"))
out.append(poly([P(0, 0, 0), P(0, 0, 10), P(0, 4, 10), P(0, 4, 0)], "#dccbaf"))
out += box(-0.3, 4, -0.3, 10, 4.3, 0, "#b98a5e")
out += box(-0.3, 4, 0, 0, 4.3, 10, "#b98a5e")
# a window on the back wall
out.append(poly([P(5.5, 1.6, 0.02), P(8.5, 1.6, 0.02), P(8.5, 3.4, 0.02), P(5.5, 3.4, 0.02)], "#bfe6ff", 'stroke="#ffffff" stroke-width="6"'))
# rug, desk with a glowing monitor, chair
out.append(poly([P(2.5, 0.02, 2.5), P(8, 0.02, 2.5), P(8, 0.02, 6.5), P(2.5, 0.02, 6.5)], "#c9785f"))
out += box(3.2, 0, 3.0, 7.2, 1.5, 4.6, "#d6a46a")
out += box(4.4, 1.5, 3.3, 6.2, 2.9, 3.55, "#25303f")
out.append(poly([P(4.55, 1.65, 3.56), P(6.05, 1.65, 3.56), P(6.05, 2.75, 3.56), P(4.55, 2.75, 3.56)], "#7fd1ff"))
out += box(4.6, 0, 5.4, 6.0, 1.0, 6.6, "#6aa6c9")
# the agent: legs, shirt, head, hair
out += box(4.8, 0, 7.2, 5.3, 1.3, 7.7, "#3d4a66")
out += box(5.5, 0, 7.2, 6.0, 1.3, 7.7, "#3d4a66")
out += box(4.6, 1.3, 7.0, 6.2, 2.9, 7.9, "#e86f86")
out += box(4.7, 2.9, 6.8, 6.1, 4.3, 8.1, "#f1c7a1")
out += box(4.6, 4.1, 6.7, 6.2, 4.6, 8.2, "#3a2a22")
for ex in (4.95, 5.55):  # eyes on the face (+z side)
    out.append(poly([P(ex, 3.45, 8.11), P(ex + 0.3, 3.45, 8.11), P(ex + 0.3, 3.8, 8.11), P(ex, 3.8, 8.11)], "#25222b"))
# plant and an outdoor tree
out += box(8.4, 0, 8.4, 9.4, 0.9, 9.4, "#b9653f")
out += box(8.2, 0.9, 8.2, 9.6, 2.3, 9.6, "#5aa64a")
out += box(11.0, 0, -0.8, 11.6, 2.4, -0.2, "#8a5a3a")
out += box(10.2, 2.2, -1.6, 12.4, 4.4, 0.6, "#4f9c43")

here = os.path.dirname(os.path.abspath(__file__))
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="768" viewBox="0 0 1280 768">{}</svg>'
with open(os.path.join(here, "front.svg"), "w") as f:
    f.write(svg.format("".join(out)))
with open(os.path.join(here, "back.svg"), "w") as f:
    f.write(svg.format('<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fd3f5"/>'
                       '<stop offset="0.55" stop-color="#d9eef7"/><stop offset="1" stop-color="#fbe7cf"/></linearGradient></defs>'
                       '<rect width="1280" height="768" fill="url(#s)"/>'))
