#!/usr/bin/env python3
"""
Generate the yieldos.app Open Graph share image at 2x retina resolution.

Output: public/og-image.png  (2400 x 1260 px, ~HD on retina displays)

The OG meta tags in index.html still declare width=1200 height=630, which is
the correct *display* size. Social platforms (LinkedIn / Twitter / Facebook)
downsample the larger source and render crisply on high-DPI displays.

Re-run this script any time you want to regenerate the image:
    python3 scripts/generate-og-image.py
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

# -----------------------------------------------------------------------------
# Canvas — rendered at 2x so the resulting PNG is crisp on retina screens.
# The facebook/twitter spec display size is 1200x630, but the file itself can
# be 2400x1260 for HD rendering. We export at 2x.
# -----------------------------------------------------------------------------
SCALE = 2
W, H = 1200 * SCALE, 630 * SCALE

OUTPUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "public", "og-image.png"
)

# Brand colors — matches index.html CSS vars
BG_TOP        = (10, 16, 28)      # slightly lighter at top for subtle gradient
BG_BOTTOM     = (6, 9, 15)        # near-black at bottom
TEXT_WHITE    = (241, 245, 249)   # --text
TEXT_SUB      = (148, 163, 184)   # --text-sub
ACCENT_GREEN  = (52, 211, 153)    # fresh emerald — matches landing "freedom" highlight
ACCENT_BLUE   = (79, 142, 247)    # matches logo background + link accent
DIVIDER       = (40, 52, 76)      # subtle divider line

# -----------------------------------------------------------------------------
# Font paths (paths on this sandbox; if running locally, adjust).
# If a weight is missing, PIL falls back to the regular weight.
# -----------------------------------------------------------------------------
FONT_SERIF_BOLD  = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
FONT_SANS_BOLD   = "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"
FONT_SANS_SEMI   = "/usr/share/fonts/truetype/lato/Lato-Semibold.ttf"
FONT_SANS_REG    = "/usr/share/fonts/truetype/lato/Lato-Regular.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def gradient_background(img):
    """Paint a subtle vertical gradient from BG_TOP to BG_BOTTOM."""
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))


def draw_glow(img, cx, cy, radius, color, intensity=0.15):
    """Radial glow effect — creates depth without being overbearing."""
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    steps = 80
    for i in range(steps, 0, -1):
        alpha = int(255 * intensity * (i / steps) ** 2)
        r = radius * (i / steps)
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r],
                      fill=(*color, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=20))
    img.alpha_composite(glow)


def draw_logo(img, x, y, size):
    """Rounded blue square with a stylized white 'A' glyph.

    x, y are the top-left corner of the square; size is edge length.
    """
    # Rounded square — build on transparent layer, then paste
    logo = Image.new("RGBA", (size + 20, size + 20), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(logo)

    # Soft shadow underneath
    shadow = Image.new("RGBA", (size + 40, size + 40), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle(
        [20, 20, 20 + size, 20 + size],
        radius=int(size * 0.22),
        fill=(0, 0, 0, 140),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12))
    img.alpha_composite(shadow, (x - 20, y - 20 + 8))

    # The rounded square
    ldraw.rounded_rectangle(
        [0, 0, size, size],
        radius=int(size * 0.22),
        fill=ACCENT_BLUE,
    )

    # Stylized "A" glyph — geometric, centered
    cx = size / 2
    base_y = size * 0.78
    top_y = size * 0.22
    half_w = size * 0.28
    stroke = max(4, int(size * 0.11))

    # Left leg
    ldraw.line(
        [(cx - half_w, base_y), (cx, top_y)],
        fill=(255, 255, 255, 255),
        width=stroke,
    )
    # Right leg
    ldraw.line(
        [(cx + half_w, base_y), (cx, top_y)],
        fill=(255, 255, 255, 255),
        width=stroke,
    )
    # Crossbar
    bar_y = size * 0.58
    ldraw.line(
        [(cx - half_w * 0.52, bar_y), (cx + half_w * 0.52, bar_y)],
        fill=(255, 255, 255, 255),
        width=stroke,
    )

    img.alpha_composite(logo, (x, y))


def text_width(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def main():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    gradient_background(img)

    # Subtle blue glow behind the logo area for depth
    draw_glow(img, int(W * 0.15), int(H * 0.35), int(W * 0.35),
              ACCENT_BLUE, intensity=0.12)

    draw = ImageDraw.Draw(img)

    # --- Layout constants -----------------------------------------------------
    left_pad  = int(70 * SCALE)
    right_pad = int(70 * SCALE)
    top_pad   = int(60 * SCALE)

    # --- Brand row (logo + YieldOS wordmark, right-aligned domain) -----------
    logo_size = int(90 * SCALE)
    draw_logo(img, left_pad, top_pad, logo_size)

    brand_font = load_font(FONT_SERIF_BOLD, int(66 * SCALE))
    brand_text = "YieldOS"
    brand_y = top_pad + int(logo_size * 0.06)
    draw.text(
        (left_pad + logo_size + int(28 * SCALE), brand_y),
        brand_text,
        font=brand_font,
        fill=TEXT_WHITE,
    )

    domain_font = load_font(FONT_SANS_SEMI, int(32 * SCALE))
    domain_text = "yieldos.app"
    dw = text_width(draw, domain_text, domain_font)
    domain_x = W - right_pad - dw
    domain_y = top_pad + int(24 * SCALE)
    draw.text(
        (domain_x, domain_y),
        domain_text,
        font=domain_font,
        fill=TEXT_WHITE,
    )
    # Thin underline beneath the domain for the "link" feel
    line_y = domain_y + int(44 * SCALE)
    draw.line(
        [(domain_x, line_y), (domain_x + dw, line_y)],
        fill=ACCENT_BLUE,
        width=int(3 * SCALE),
    )

    # --- Headline -------------------------------------------------------------
    # 82pt at 2x scale keeps line 1 ("Track your paychecks.") within the
    # usable horizontal band (~2120px) with a small right margin.
    headline_font = load_font(FONT_SERIF_BOLD, int(82 * SCALE))
    line1 = "Track your paychecks."
    line2 = "Plan your freedom."

    headline_x = left_pad
    headline_y = int(255 * SCALE)

    draw.text((headline_x, headline_y), line1,
              font=headline_font, fill=TEXT_WHITE)

    line2_y = headline_y + int(105 * SCALE)
    draw.text((headline_x, line2_y), line2,
              font=headline_font, fill=ACCENT_GREEN)

    # --- Subtitle -------------------------------------------------------------
    sub_font = load_font(FONT_SANS_SEMI, int(32 * SCALE))
    sub_text = "Income-first dividend tracker.  Built for FIRE."
    sub_y = line2_y + int(130 * SCALE)
    draw.text((headline_x, sub_y), sub_text,
              font=sub_font, fill=TEXT_SUB)

    # --- Divider line ---------------------------------------------------------
    divider_y = sub_y + int(68 * SCALE)
    draw.line(
        [(left_pad, divider_y), (W - right_pad, divider_y)],
        fill=DIVIDER,
        width=int(2 * SCALE),
    )

    # --- Bottom pill row ------------------------------------------------------
    bottom_font = load_font(FONT_SANS_SEMI, int(26 * SCALE))
    pills = ["Free forever plan", "Paycheck calendar", "Daily AI briefing"]
    sep = "   ·   "
    combined = sep.join(pills)
    bw = text_width(draw, combined, bottom_font)
    bottom_y = divider_y + int(28 * SCALE)
    draw.text((left_pad, bottom_y), combined,
              font=bottom_font, fill=TEXT_SUB)

    # --- Export (flatten alpha, save as PNG) ----------------------------------
    out = Image.new("RGB", (W, H), (0, 0, 0))
    out.paste(img, (0, 0), img)

    # Keep file size sane — OG images above ~1MB can be rejected by some
    # platforms. Use PNG optimize + moderate compression.
    out.save(OUTPUT, "PNG", optimize=True, compress_level=9)

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"Wrote {OUTPUT}  ({W}x{H}, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
