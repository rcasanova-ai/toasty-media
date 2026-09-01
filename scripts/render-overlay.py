#!/usr/bin/env python3
import json
import sys
from PIL import Image, ImageDraw, ImageFont


def main():
    spec = json.loads(sys.argv[1])
    width = int(spec["width"])
    height = int(spec["height"])
    output = spec["output"]
    caption = spec.get("caption", "")
    title = spec.get("title", "")
    lower_third = spec.get("lowerThird", "")
    watermark = bool(spec.get("watermark", True))
    brand_name = spec.get("brandName", "TOASTY")
    website = spec.get("website", "")
    color = spec.get("color", "#ff7a29")

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    accent = hex_to_rgba(color, 215)

    if title:
        draw_centered_box(draw, title, width, height, y=int(height * 0.42), font_size=max(34, int(width * 0.055)), fill=accent)

    if caption:
        box_top = int(height * 0.74)
        draw.rounded_rectangle([int(width * 0.06), box_top, int(width * 0.94), int(height * 0.91)], radius=18, fill=(0, 0, 0, 132))
        draw_wrapped_center(draw, caption, width, box_top + 22, max_width=int(width * 0.78), font_size=max(24, int(width * 0.038)), fill=(255, 255, 255, 245))

    if lower_third:
        draw_lower_third(draw, lower_third, width, height, accent)

    if watermark:
        draw_watermark(draw, brand_name, website, width, accent)

    image.save(output)


def draw_centered_box(draw, text, width, height, y, font_size, fill):
    fnt = font(font_size)
    lines = wrap_text(text, fnt, int(width * 0.76), draw)
    line_h = font_size + 8
    box_h = len(lines) * line_h + 34
    box = [int(width * 0.08), y - 18, int(width * 0.92), y + box_h]
    draw.rounded_rectangle(box, radius=20, fill=fill)
    current_y = y
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=fnt)
        draw.text(((width - (bbox[2] - bbox[0])) / 2, current_y), line, font=fnt, fill=(255, 255, 255, 248))
        current_y += line_h


def draw_wrapped_center(draw, text, width, y, max_width, font_size, fill):
    fnt = font(font_size)
    lines = wrap_text(text, fnt, max_width, draw)[:3]
    current_y = y
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=fnt)
        draw.text(((width - (bbox[2] - bbox[0])) / 2, current_y), line, font=fnt, fill=fill)
        current_y += font_size + 6


def draw_lower_third(draw, text, width, height, accent):
    fnt = font(max(20, int(width * 0.026)))
    small = font(max(14, int(width * 0.016)))
    parts = [part.strip() for part in text.split("·", 1)]
    primary = parts[0]
    secondary = parts[1] if len(parts) > 1 else ""
    left = int(width * 0.055)
    bottom = int(height * 0.88)
    box = [left, bottom - 96, min(int(width * 0.72), left + 720), bottom]
    draw.rounded_rectangle(box, radius=16, fill=(0, 0, 0, 150))
    draw.rounded_rectangle([left, bottom - 96, left + 8, bottom], radius=4, fill=accent)
    draw.text((left + 28, bottom - 75), primary, font=fnt, fill=(255, 255, 255, 246))
    if secondary:
        draw.text((left + 30, bottom - 38), secondary, font=small, fill=(255, 231, 210, 210))


def draw_watermark(draw, brand_name, website, width, accent):
    label = (brand_name or "TOASTY").upper()
    mark_w = max(8, int(width * 0.012))
    draw.rounded_rectangle([width - 48, 28, width - 48 + mark_w, 88], radius=4, fill=accent)
    label_font = font(max(16, int(width * 0.022)))
    label_box = draw.textbbox((0, 0), label, font=label_font)
    draw.text((width - 58 - (label_box[2] - label_box[0]), 40), label, font=label_font, fill=(255, 255, 255, 185))
    if website:
        web_font = font(max(11, int(width * 0.013)))
        web_box = draw.textbbox((0, 0), website, font=web_font)
        draw.text((width - 58 - (web_box[2] - web_box[0]), 68), website, font=web_font, fill=(255, 255, 255, 128))


def wrap_text(text, fnt, max_width, draw):
    words = text.split()
    lines = []
    line = ""
    for word in words:
        test = f"{line} {word}".strip()
        bbox = draw.textbbox((0, 0), test, font=fnt)
        if bbox[2] - bbox[0] <= max_width or not line:
            line = test
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines or [text]


def font(size):
    for path in [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def hex_to_rgba(value, alpha):
    value = value.lstrip("#")
    if len(value) != 6:
        value = "ff7a29"
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


if __name__ == "__main__":
    main()
