"""Generate blue Learning Digest icons (16/48/128) with PIL.

Design: rounded-square blue gradient tile; centered white speech bubble
with three blue waveform bars — "learning captured as conversation".
"""
from PIL import Image, ImageDraw

SIZES = [16, 48, 128]
TOP = (27, 114, 232)     # #1B72E8
BOTTOM = (59, 157, 242)  # #3B9DF2
WHITE = (255, 255, 255, 255)


def rounded_gradient(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * radius_ratio, fill=255)
    img.paste(grad, (0, 0), mask)
    return img, radius_ratio * size


def draw_icon(size):
    img, radius = rounded_gradient(size)
    d = ImageDraw.Draw(img)

    # Speech bubble geometry (fractions of size)
    bx0, by0 = size * 0.18, size * 0.22
    bx1, by1 = size * 0.82, size * 0.70
    br = size * 0.14  # bubble corner radius
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=br, fill=WHITE)
    # Bubble tail
    tail_w = size * 0.16
    tx = size * 0.36
    ty = size * 0.70
    d.polygon(
        [(tx, ty - size * 0.02), (tx + tail_w, ty - size * 0.02), (tx + size * 0.02, size * 0.80)],
        fill=WHITE,
    )

    # Waveform bars inside the bubble (blue, rounded tops/bottoms)
    bar_color = TOP
    bars = 3
    bw = size * 0.075
    gap = size * 0.075
    total = bars * bw + (bars - 1) * gap
    cx = (bx0 + bx1) / 2
    cy = (by0 + by1) / 2
    heights = [size * 0.20, size * 0.30, size * 0.16]
    x = cx - total / 2
    for h in heights:
        d.rounded_rectangle([x, cy - h / 2, x + bw, cy + h / 2], radius=bw / 2, fill=bar_color)
        x += bw + gap

    return img


for s in SIZES:
    icon = draw_icon(s)
    icon.save(f"icons/icon{s}.png")
    print(f"icons/icon{s}.png {icon.size}")
