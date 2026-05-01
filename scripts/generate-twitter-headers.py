#!/usr/bin/env python3
"""
Generate four Twitter header variants for the @Yieldos_app account.

Output: docs/twitter-headers/{a,b,c,d}.png at 3000x1000 (2x retina for 1500x500)

Pick the one you like, upload to Twitter (Profile → Edit profile → header image).
Twitter recommends 1500x500; we render at 2x so it stays crisp on retina.

Re-run with: python3 scripts/generate-twitter-headers.py
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

# Twitter header is 1500x500. Render at 2x for retina crispness.
SCALE = 2
W, H = 1500 * SCALE, 500 * SCALE

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs", "twitter-headers"
)
os.makedirs(OUT_DIR, exist_ok=True)

# Brand palette (matches CLAUDE.md + index.html CSS variables)
BG_TOP        = (10, 16, 28)
BG_BOTTOM     = (6, 9, 15)
TEXT_WHITE    = (241, 245, 249)
TEXT_SUB      = (148, 163, 184)
TEXT_MUTED    = (107, 116, 131)
ACCENT_GREEN  = (52, 211, 153)
ACCENT_BLUE   = (79, 142, 247)
ACCENT_GOLD   = (245, 158, 11)
DIVIDER       = (40, 52, 76)

FONT_SERIF_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
FONT_SANS_SEMI  = "/usr/share/fonts/truetype/lato/Lato-Semibold.ttf"
FONT_SANS_REG   = "/usr/share/fonts/truetype/lato/Lato-Regular.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def gradient_bg(img):
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))


def radial_glow(img, cx, cy, radius, color, intensity=0.15):
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    steps = 60
    for i in range(steps, 0, -1):
        alpha = int(255 * intensity * (i / steps) ** 2)
        r = radius * (i / steps)
        gdraw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=(*color, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=18))
    img.alpha_composite(glow)


def draw_logo(img, x, y, size):
    """Rounded blue square + chart-peak path + dot (matches /public/favicon.svg).

    Source SVG (28x28 viewBox):
      rect rx=7 fill=#4f8ef7
      path M8 20 L14 8 L20 20  stroke=#fff w=2.2 round caps/joins
      circle cx=14 cy=17 r=2 fill=#fff
    """
    logo = Image.new("RGBA", (size + 24, size + 24), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(logo)

    shadow = Image.new("RGBA", (size + 48, size + 48), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle(
        [24, 24, 24 + size, 24 + size],
        radius=int(size * 0.25),  # 7/28 = 0.25
        fill=(0, 0, 0, 130),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=10))
    img.alpha_composite(shadow, (x - 24, y - 24 + 8))

    ldraw.rounded_rectangle(
        [0, 0, size, size],
        radius=int(size * 0.25),
        fill=ACCENT_BLUE,
    )

    # Chart peak path: (8,20) -> (14,8) -> (20,20) on 28-unit grid
    s = size / 28.0
    p1 = (8 * s, 20 * s)
    p2 = (14 * s, 8 * s)
    p3 = (20 * s, 20 * s)
    # Match favicon's stroke-width=2.2 on a 28-unit grid (slightly slimmer
    # than what I had before — gives the dot breathing room).
    stroke = max(3, int(size * 0.082))

    # Round caps via ellipses at each vertex
    half = stroke / 2
    for px, py in (p1, p2, p3):
        ldraw.ellipse(
            [px - half, py - half, px + half, py + half],
            fill=(255, 255, 255, 255),
        )
    ldraw.line([p1, p2], fill=(255, 255, 255, 255), width=stroke)
    ldraw.line([p2, p3], fill=(255, 255, 255, 255), width=stroke)

    # Dot under the peak. Favicon has cx=14 cy=17 r=2; dropping cy a half-unit
    # to 17.6 and shrinking r slightly so the dot sits cleanly inside the
    # widening V instead of butting up against the diagonals.
    dot_cx = 14 * s
    dot_cy = 17.6 * s
    dot_r = max(2, int(1.75 * s))
    ldraw.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=(255, 255, 255, 255),
    )

    img.alpha_composite(logo, (x, y))


def text_w(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


# Profile-photo cutout: Twitter's profile photo overlays the bottom-left
# of the header. We avoid putting any critical text in roughly the lower-
# left 300x250 area on the 1500x500 base (so 600x500 at 2x). The dividend
# chart line in design A also avoids this region.
PROFILE_AVOID = (0, H - 500, 600, H)


# ─── DESIGN A — Tagline driven (matches OG image identity) ────────────────
def design_a():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    gradient_bg(img)
    radial_glow(img, int(W * 0.15), int(H * 0.30), int(W * 0.30), ACCENT_BLUE, intensity=0.10)
    draw = ImageDraw.Draw(img)

    # Subtle ascending dividend-growth chart in the right portion
    chart_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(chart_layer)
    pts = [
        (int(W * 0.55), int(H * 0.78)),
        (int(W * 0.62), int(H * 0.72)),
        (int(W * 0.68), int(H * 0.74)),
        (int(W * 0.74), int(H * 0.62)),
        (int(W * 0.80), int(H * 0.58)),
        (int(W * 0.86), int(H * 0.45)),
        (int(W * 0.92), int(H * 0.36)),
        (int(W * 0.97), int(H * 0.28)),
    ]
    cdraw.line(pts, fill=(*ACCENT_GREEN, 60), width=int(4 * SCALE))
    # data dots
    for px, py in pts:
        r = 6 * SCALE
        cdraw.ellipse([px - r, py - r, px + r, py + r], fill=(*ACCENT_GREEN, 90))
    img.alpha_composite(chart_layer)

    # Logo + wordmark top-left (avoids profile-photo zone since it sits BELOW)
    logo_size = int(60 * SCALE)
    draw_logo(img, int(50 * SCALE), int(40 * SCALE), logo_size)
    wordmark_font = load_font(FONT_SERIF_BOLD, int(40 * SCALE))
    draw.text(
        (int(50 * SCALE) + logo_size + int(18 * SCALE), int(48 * SCALE)),
        "YieldOS",
        font=wordmark_font,
        fill=TEXT_WHITE,
    )

    # Headline — center-vertical, left-anchored at safe x
    headline_font = load_font(FONT_SERIF_BOLD, int(58 * SCALE))
    line1 = "Track your paychecks."
    line2 = "Plan your freedom."
    headline_x = int(330 * SCALE)
    line1_y = int(175 * SCALE)
    line2_y = line1_y + int(78 * SCALE)
    draw.text((headline_x, line1_y), line1, font=headline_font, fill=TEXT_WHITE)
    draw.text((headline_x, line2_y), line2, font=headline_font, fill=ACCENT_GREEN)

    # Domain bottom-right
    domain_font = load_font(FONT_SANS_SEMI, int(22 * SCALE))
    domain = "yieldos.app"
    dw = text_w(draw, domain, domain_font)
    draw.text(
        (W - int(50 * SCALE) - dw, H - int(50 * SCALE) - int(28 * SCALE)),
        domain,
        font=domain_font,
        fill=TEXT_SUB,
    )

    return img


# ─── DESIGN B — Bold contrarian ────────────────────────────────────────────
def design_b():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    gradient_bg(img)
    radial_glow(img, int(W * 0.50), int(H * 0.50), int(W * 0.45), ACCENT_BLUE, intensity=0.08)
    draw = ImageDraw.Draw(img)

    # Centered three-word statement
    big_font = load_font(FONT_SERIF_BOLD, int(120 * SCALE))
    parts = [("Income", ACCENT_GREEN), (" > ", TEXT_WHITE), ("Balance", TEXT_MUTED)]
    total_w = sum(text_w(draw, t, big_font) for t, _ in parts)
    x = (W - total_w) // 2
    y = (H - int(120 * SCALE) - int(60 * SCALE)) // 2  # vertical center, accounting for descender
    for txt, color in parts:
        draw.text((x, y), txt, font=big_font, fill=color)
        x += text_w(draw, txt, big_font)

    # Subtitle below
    sub_font = load_font(FONT_SANS_REG, int(20 * SCALE))
    sub = "An income-first dividend tracker · yieldos.app"
    sw = text_w(draw, sub, sub_font)
    draw.text(
        ((W - sw) // 2, y + int(120 * SCALE) + int(24 * SCALE)),
        sub,
        font=sub_font,
        fill=TEXT_SUB,
    )

    return img


# ─── DESIGN C — Minimal ───────────────────────────────────────────────────
def design_c():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    gradient_bg(img)
    radial_glow(img, int(W * 0.50), int(H * 0.50), int(W * 0.40), ACCENT_BLUE, intensity=0.18)
    draw = ImageDraw.Draw(img)

    # Logo + wordmark centered
    logo_size = int(110 * SCALE)
    word_font = load_font(FONT_SERIF_BOLD, int(78 * SCALE))
    word_text = "YieldOS"
    word_w = text_w(draw, word_text, word_font)
    gap = int(28 * SCALE)
    total_w = logo_size + gap + word_w

    cx = (W - total_w) // 2
    cy = int(160 * SCALE)
    draw_logo(img, cx, cy, logo_size)
    # Vertical-center the wordmark on the logo
    draw.text((cx + logo_size + gap, cy + int(12 * SCALE)), word_text, font=word_font, fill=TEXT_WHITE)

    # Domain centered below
    domain_font = load_font(FONT_SANS_SEMI, int(28 * SCALE))
    domain = "yieldos.app"
    dw = text_w(draw, domain, domain_font)
    draw.text(
        ((W - dw) // 2, cy + logo_size + int(34 * SCALE)),
        domain,
        font=domain_font,
        fill=TEXT_SUB,
    )

    return img


# ─── DESIGN D — Story driven ──────────────────────────────────────────────
def design_d():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    gradient_bg(img)
    radial_glow(img, int(W * 0.20), int(H * 0.40), int(W * 0.30), ACCENT_BLUE, intensity=0.10)
    draw = ImageDraw.Draw(img)

    # Logo top-left
    logo_size = int(56 * SCALE)
    draw_logo(img, int(50 * SCALE), int(40 * SCALE), logo_size)
    wordmark_font = load_font(FONT_SERIF_BOLD, int(34 * SCALE))
    draw.text(
        (int(50 * SCALE) + logo_size + int(16 * SCALE), int(46 * SCALE)),
        "YieldOS",
        font=wordmark_font,
        fill=TEXT_WHITE,
    )

    # Two-line story, center-vertical, anchored center-right of safe zone
    story_font = load_font(FONT_SERIF_BOLD, int(64 * SCALE))
    line1 = "I quit my job at 45."
    line2 = "My dividends didn't."
    line1_w = text_w(draw, line1, story_font)
    line2_w = text_w(draw, line2, story_font)
    base_x = int(420 * SCALE)
    line1_y = int(170 * SCALE)
    line2_y = line1_y + int(86 * SCALE)
    draw.text((base_x, line1_y), line1, font=story_font, fill=TEXT_WHITE)
    draw.text((base_x, line2_y), line2, font=story_font, fill=ACCENT_GREEN)

    # Domain bottom-right
    domain_font = load_font(FONT_SANS_SEMI, int(22 * SCALE))
    domain = "yieldos.app"
    dw = text_w(draw, domain, domain_font)
    draw.text(
        (W - int(50 * SCALE) - dw, H - int(50 * SCALE) - int(28 * SCALE)),
        domain,
        font=domain_font,
        fill=TEXT_SUB,
    )

    return img


def export(img, name):
    out = Image.new("RGB", (W, H), (0, 0, 0))
    out.paste(img, (0, 0), img)
    path = os.path.join(OUT_DIR, f"{name}.png")
    out.save(path, "PNG", optimize=True, compress_level=9)
    size_kb = os.path.getsize(path) / 1024
    print(f"Wrote {path}  ({W}x{H}, {size_kb:.1f} KB)")


def main():
    export(design_a(), "a-tagline")
    export(design_b(), "b-bold")
    export(design_c(), "c-minimal")
    export(design_d(), "d-story")
    print()
    print("Open all four:")
    print(f"  open {OUT_DIR}/")


if __name__ == "__main__":
    main()
