"""生成应用图标：蓝色渐变圆角方块 + 白色 D，输出 ico（多尺寸）与 png。

用法：python scripts/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
MARGIN = 56
RADIUS = 224
TOP = (0x4D, 0x6B, 0xFE)
BOTTOM = (0x24, 0x3C, 0xD8)
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\seguisb.ttf",
]

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "resources"


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def main() -> None:
    background = gradient(SIZE)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=RADIUS, fill=255
    )

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(background, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
    if font_path is None:
        raise SystemExit("找不到可用的粗体字体")
    font = ImageFont.truetype(font_path, 600)

    text = "D"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    width, height = right - left, bottom - top
    draw.text(
        ((SIZE - width) / 2 - left, (SIZE - height) / 2 - top - 16),
        text,
        font=font,
        fill=(255, 255, 255, 255),
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    canvas.resize((512, 512), Image.LANCZOS).save(OUT_DIR / "icon.png")
    canvas.save(
        OUT_DIR / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {OUT_DIR / 'icon.ico'} and icon.png")


if __name__ == "__main__":
    main()
