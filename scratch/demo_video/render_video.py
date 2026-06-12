import json
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "scratch" / "demo_video"
SCREENS = WORK / "screens"
SLIDES = WORK / "slides"
OUTPUT = WORK / "DAA_AeroSched_3min_demo.mp4"
CONCAT = WORK / "concat.txt"
STORYBOARD = WORK / "storyboard.md"
try:
    import imageio_ffmpeg

    FFMPEG = Path(imageio_ffmpeg.get_ffmpeg_exe())
except Exception:
    FFMPEG = Path(r"C:\Users\user\AppData\Local\ms-playwright\ffmpeg-1011\ffmpeg-win64.exe")
SIZE = (1920, 1080)

INTRO_SECONDS = 15.0
APP_SECONDS = 165.0
FPS = 30

APP_SCENE_FILES = [
    "02_long_term_forecast.png",
    "03_capacity_heatmap.png",
    "04_workforce_plan.png",
    "05_roster_pattern.png",
    "06_scenario_planning.png",
    "07_short_term_summary.png",
    "08_task_allocation.png",
    "09_short_term_optimisation.png",
    "10_intraday_reallocation.png",
    "11_intraday_timeline.png",
    "12_intraday_pax_demand.png",
    "13_config.png",
]


def font(size, bold=False):
    candidates = [
        Path(r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf"),
        Path(r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


FONT_HERO = font(82, True)
FONT_HERO_SUB = font(38, False)
FONT_META = font(25, False)
FONT_SCENE_TITLE = font(36, True)
FONT_SCENE_CAPTION = font(24, False)
FONT_SMALL = font(18, False)
FONT_BADGE = font(19, True)


def cover(img, size=SIZE):
    src_w, src_h = img.size
    dst_w, dst_h = size
    scale = max(dst_w / src_w, dst_h / src_h)
    new_w, new_h = math.ceil(src_w * scale), math.ceil(src_h * scale)
    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    x = (new_w - dst_w) // 2
    y = (new_h - dst_h) // 2
    return img.crop((x, y, x + dst_w, y + dst_h))


def add_vignette(base, strength=125):
    w, h = base.size
    vignette = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(vignette)
    draw.ellipse((-w * 0.18, -h * 0.20, w * 1.18, h * 1.22), fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(120))
    inv = Image.eval(vignette, lambda p: int((255 - p) * strength / 255))
    shade = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shade.putalpha(inv)
    return Image.alpha_composite(base.convert("RGBA"), shade)


def gradient_overlay(size, left=(4, 12, 28, 235), right=(4, 12, 28, 70)):
    w, h = size
    overlay = Image.new("RGBA", size)
    pix = overlay.load()
    for x in range(w):
        t = x / max(1, w - 1)
        rgba = tuple(int(left[i] * (1 - t) + right[i] * t) for i in range(4))
        for y in range(h):
            pix[x, y] = rgba
    return overlay


def wrap_text(draw, text, text_font, width):
    words = text.split()
    lines = []
    line = ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textbbox((0, 0), trial, font=text_font)[2] <= width:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def draw_text_block(draw, xy, text, text_font, fill, max_width, line_gap=8):
    x, y = xy
    for line in wrap_text(draw, text, text_font, max_width):
        draw.text((x, y), line, font=text_font, fill=fill)
        bbox = draw.textbbox((x, y), line, font=text_font)
        y += (bbox[3] - bbox[1]) + line_gap
    return y


def draw_intro():
    bg = cover(Image.open(ROOT / "static" / "home_page.jpg").convert("RGB"))
    bg = add_vignette(bg, 90)
    bg = Image.alpha_composite(bg.convert("RGBA"), gradient_overlay(SIZE))
    draw = ImageDraw.Draw(bg)

    accent = (255, 122, 24, 255)
    blue = (0, 168, 255, 255)
    white = (255, 255, 255, 255)
    muted = (198, 221, 242, 255)

    draw.rounded_rectangle((110, 118, 196, 204), radius=18, fill=accent)
    draw.text((134, 137), "daa", font=font(31, True), fill=white)

    draw.text((112, 286), "DAA Workforce Intelligence", font=FONT_HERO, fill=white)
    draw.text((116, 392), "Ground Operations Resource Planning Demo", font=FONT_HERO_SUB, fill=muted)

    draw.rectangle((118, 474, 346, 480), fill=accent)
    draw.rectangle((360, 474, 520, 480), fill=blue)

    body = "Dublin Airport Authority | Strategic forecasting, tactical rostering, and live intraday response"
    draw_text_block(draw, (118, 528), body, FONT_META, (230, 240, 252, 255), 940, 10)

    draw.rounded_rectangle((118, 818, 615, 878), radius=12, fill=(8, 17, 32, 205), outline=(255, 122, 24, 180), width=2)
    draw.text((148, 835), "3-minute app walkthrough", font=FONT_BADGE, fill=white)
    draw.text((118, 930), "15-second branded opening background", font=FONT_SMALL, fill=(190, 210, 232, 255))
    return bg.convert("RGB")


def draw_scene(scene_img, idx, total, title, caption):
    base = scene_img.convert("RGB").resize(SIZE, Image.Resampling.LANCZOS).convert("RGBA")
    base = add_vignette(base, 45)
    draw = ImageDraw.Draw(base)

    panel = (84, 810, 1240, 1010)
    draw.rounded_rectangle(panel, radius=18, fill=(4, 12, 25, 218), outline=(80, 118, 168, 160), width=2)
    draw.rectangle((panel[0], panel[1] + 22, panel[0] + 8, panel[3] - 22), fill=(255, 122, 24, 255))

    badge = f"DAA demo  |  {idx:02d}/{total:02d}"
    draw.text((112, 836), badge, font=FONT_SMALL, fill=(144, 196, 255, 255))
    draw.text((112, 872), title, font=FONT_SCENE_TITLE, fill=(255, 255, 255, 255))
    draw_text_block(draw, (112, 925), caption, FONT_SCENE_CAPTION, (219, 235, 249, 255), 1040, 7)

    return base.convert("RGB")


def seconds_to_timecode(seconds):
    minutes = int(seconds // 60)
    rem = int(round(seconds - minutes * 60))
    return f"{minutes:02d}:{rem:02d}"


def main():
    if not FFMPEG.exists():
        raise FileNotFoundError(f"ffmpeg not found at {FFMPEG}")

    SLIDES.mkdir(parents=True, exist_ok=True)
    metadata = json.loads((WORK / "scene_metadata.json").read_text(encoding="utf-8"))
    meta_by_file = {item["file"]: item for item in metadata}

    slides = []
    intro_path = SLIDES / "00_intro.png"
    draw_intro().save(intro_path)
    slides.append((intro_path, INTRO_SECONDS, "Branded opening background", "Dublin Airport Authority overview title card."))

    per_scene = APP_SECONDS / len(APP_SCENE_FILES)
    for idx, filename in enumerate(APP_SCENE_FILES, start=1):
        item = meta_by_file[filename]
        img = Image.open(SCREENS / filename)
        slide = draw_scene(img, idx, len(APP_SCENE_FILES), item["title"], item["caption"])
        out = SLIDES / filename
        slide.save(out)
        slides.append((out, per_scene, item["title"], item["caption"]))

    with CONCAT.open("w", encoding="utf-8") as f:
        for path, duration, _, _ in slides:
            f.write(f"file '{path.as_posix()}'\n")
            f.write(f"duration {duration:.6f}\n")
        f.write(f"file '{slides[-1][0].as_posix()}'\n")

    current = 0.0
    lines = [
        "# DAA AeroSched Demo Storyboard",
        "",
        "| Start | Duration | Scene | Notes |",
        "| --- | ---: | --- | --- |",
    ]
    for _, duration, title, caption in slides:
        lines.append(f"| {seconds_to_timecode(current)} | {duration:.2f}s | {title} | {caption} |")
        current += duration
    lines.append("")
    lines.append(f"Total runtime: {current:.2f}s")
    STORYBOARD.write_text("\n".join(lines), encoding="utf-8")

    cmd = [
        str(FFMPEG),
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(CONCAT),
        "-f",
        "lavfi",
        "-t",
        "180",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-vf",
        f"fps={FPS},format=yuv420p,fade=t=in:st=0:d=0.7,fade=t=out:st=179.2:d=0.8",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-t",
        "180",
        "-shortest",
        "-movflags",
        "+faststart",
        str(OUTPUT),
    ]
    subprocess.run(cmd, check=True, cwd=str(ROOT))
    print(OUTPUT)
    print(STORYBOARD)


if __name__ == "__main__":
    main()
