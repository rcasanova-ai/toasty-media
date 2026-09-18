#!/usr/bin/env python3
"""Create transparent Studio derivatives from supplied brand artwork.

This only removes backgrounds from the provided images. It does not redraw,
reinterpret, or generate logos.
"""
from __future__ import annotations

from collections import deque
from math import sqrt
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path("/Users/ricardocasanova/.cursor/projects/Users-ricardocasanova-Projects-toasty-media/assets")
PEEPS_SRC = ASSETS / "image-022223ef-bca1-4fd9-a55a-b9917e45b12f.png"
SUPERTEAM_SRC = ASSETS / "image-b31696aa-3afa-45c5-a95a-e93dad327d41.png"


def dist(a, b) -> float:
    return sqrt(sum((int(a[i]) - int(b[i])) ** 2 for i in range(3)))


def saturation(pixel) -> float:
    red, green, blue = pixel[:3]
    maximum = max(red, green, blue)
    minimum = min(red, green, blue)
    if maximum == 0:
        return 0
    return (maximum - minimum) / maximum


def luminance(pixel) -> float:
    red, green, blue = pixel[:3]
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255


def is_protected_mark(pixel) -> bool:
    """Keep the white 3D Superteam ST / elephant (low-sat, bright) as seed foreground."""
    return luminance(pixel) > 0.50 and saturation(pixel) < 0.30


def is_letter_shading(pixel) -> bool:
    return luminance(pixel) > 0.18 and luminance(pixel) < 0.72 and saturation(pixel) < 0.22


def is_flag_red(pixel) -> bool:
    red, green, blue = pixel[:3]
    return red > 140 and red > green + 28 and red > blue + 18 and green < 160 and blue < 160


def is_flag_blue(pixel) -> bool:
    red, green, blue = pixel[:3]
    return blue > 70 and blue > red + 8 and blue >= green - 8 and red < 120 and green < 140


def is_flag_white(pixel) -> bool:
    return luminance(pixel) > 0.62 and saturation(pixel) < 0.28


def is_flag_pixel(pixel) -> bool:
    return is_flag_red(pixel) or is_flag_blue(pixel) or is_flag_white(pixel)


def is_peeps_cream(pixel, seed, threshold: float = 36) -> bool:
    return dist(pixel, seed) <= threshold and luminance(pixel) > 0.82 and saturation(pixel) < 0.18


def is_peeps_letter(pixel) -> bool:
    red, green, blue = pixel[:3]
    if pixel[3] < 16:
        return False
    dark_brown = red < 130 and green < 90 and blue < 70 and luminance(pixel) < 0.38
    return dark_brown and saturation(pixel) < 0.55


def neighbors(x: int, y: int, width: int, height: int):
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < width and 0 <= ny < height:
            yield nx, ny


def grow_superteam_mark(image: Image.Image) -> Image.Image:
    """Keep the supplied ST + elephant + attached flag; drop the square gradient."""
    source = image.convert("RGBA")
    width, height = source.size
    src = source.load()
    keep = bytearray(width * height)
    distance = [0] * (width * height)
    queue = deque()

    def mark(x: int, y: int, steps: int) -> None:
        index = y * width + x
        if keep[index]:
            return
        keep[index] = 1
        distance[index] = steps
        queue.append((x, y))

    for y in range(height):
        for x in range(width):
            if is_protected_mark(src[x, y]):
                mark(x, y, 0)

    flag_left = int(width * 0.40)
    while queue:
        x, y = queue.popleft()
        steps = distance[y * width + x]
        for nx, ny in neighbors(x, y, width, height):
            index = ny * width + nx
            if keep[index]:
                continue
            pixel = src[nx, ny]
            if is_protected_mark(pixel):
                mark(nx, ny, 0)
                continue
            if is_letter_shading(pixel) and steps < 10:
                mark(nx, ny, steps + 1)
                continue
            flag_band = nx >= flag_left and int(height * 0.36) <= ny <= int(height * 0.76)
            if flag_band and is_flag_pixel(pixel) and steps < 36:
                mark(nx, ny, steps + 1)

    result = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dst = result.load()
    for y in range(height):
        for x in range(width):
            if keep[y * width + x]:
                pixel = src[x, y]
                dst[x, y] = (pixel[0], pixel[1], pixel[2], 255)
    return result


def extract_skyline(lockup: Image.Image) -> Image.Image:
    """Keep temple / skyline silhouettes from the existing cinematic lockup."""
    source = lockup.convert("RGBA")
    width, height = source.size
    src = source.load()
    result = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dst = result.load()
    for y in range(int(height * 0.58)):
        for x in range(width):
            if int(width * 0.24) < x < int(width * 0.76):
                continue
            pixel = src[x, y]
            lum = luminance(pixel)
            sat = saturation(pixel)
            if lum > 0.38:
                continue
            if sat > 0.45 and lum > 0.16:
                continue
            alpha = int(min(190, 255 * (1 - lum / 0.38)))
            dst[x, y] = (232, 238, 246, alpha)
    return result


def crop_opaque(image: Image.Image, padding: int = 12) -> Image.Image:
    bbox = image.getbbox()
    if not bbox:
        return image
    left, top, right, bottom = bbox
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(image.width, right + padding)
    bottom = min(image.height, bottom + padding)
    return image.crop((left, top, right, bottom))


def key_color(image: Image.Image, matcher) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    seed = rgba.getpixel((0, 0))
    width, height = rgba.size
    for y in range(height):
        for x in range(width):
            if matcher(pixels[x, y], seed):
                pixels[x, y] = (0, 0, 0, 0)
    return rgba


def strip_peeps_letters(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    for y in range(height):
        for x in range(width):
            if is_peeps_letter(pixels[x, y]):
                pixels[x, y] = (0, 0, 0, 0)
    return rgba


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")
    print(f"wrote {path.relative_to(ROOT)} {image.size}")


def main() -> None:
    superteam_dir = ROOT / "shared/brand/clients/superteam-thailand"
    peeps_dir = ROOT / "shared/brand/toasty-peeps"
    (superteam_dir / "source").mkdir(parents=True, exist_ok=True)
    (peeps_dir / "source").mkdir(parents=True, exist_ok=True)

    cinematic = superteam_dir / "source/lockup-cinematic.png"
    if not cinematic.exists():
        legacy = superteam_dir / "logo.png"
        if legacy.exists():
            Image.open(legacy).save(cinematic)

    Image.open(SUPERTEAM_SRC).save(superteam_dir / "source/mark-square.png")
    Image.open(PEEPS_SRC).save(peeps_dir / "source/logo-source.png")

    st_cut = crop_opaque(grow_superteam_mark(Image.open(SUPERTEAM_SRC)), padding=16)
    save(st_cut, superteam_dir / "logo.png")

    elephant = crop_opaque(
        st_cut.crop((int(st_cut.width * 0.63), int(st_cut.height * 0.20), st_cut.width, st_cut.height)),
        padding=8,
    )
    save(elephant, superteam_dir / "watermark-elephant.png")

    skyline = crop_opaque(extract_skyline(Image.open(cinematic)), padding=8)
    save(skyline, superteam_dir / "silhouette-skyline.png")

    peeps_cut = crop_opaque(key_color(Image.open(PEEPS_SRC), is_peeps_cream), padding=18)
    save(peeps_cut, peeps_dir / "logo.png")

    mascot = crop_opaque(
        strip_peeps_letters(
            peeps_cut.crop((
                int(peeps_cut.width * 0.17),
                0,
                int(peeps_cut.width * 0.43),
                int(peeps_cut.height * 0.60),
            ))
        ),
        padding=8,
    )
    save(mascot, peeps_dir / "watermark-mascot.png")


if __name__ == "__main__":
    main()
