"""
最终 2 个 icon:
- e1-bg: 蓝紫渐变圆角方块(无字) — 保留为纯背景版
- e1-K: 蓝紫渐变圆角方块 + 白 K — 用户主推
配色取自 d1: 左上 (90,61,233) 蓝 → 右下 (167,78,242) 紫
"""
import os, math
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))


def gradient_bg(img, c1, c2, mode="tlbr"):
    w, h = img.size
    grad = Image.new("RGBA", (w, h))
    px = grad.load()
    for y in range(h):
        for x in range(w):
            if mode == "tlbr":
                t = (x + y) / (2 * w)
            elif mode == "trbl":
                t = (w - x + y) / (2 * w)
            else:
                t = y / h
            px[x, y] = (int(c1[0]*(1-t)+c2[0]*t), int(c1[1]*(1-t)+c2[1]*t), int(c1[2]*(1-t)+c2[2]*t), 255)
    img.paste(grad, (0, 0), grad)


def rounded_mask(img, radius_ratio=0.22):
    w, h = img.size
    r = int(w * radius_ratio)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    img.paste(out, (0, 0))


def add_inner_shadow(img, depth=20, alpha=80):
    """柔和内阴影,增加方块的厚度感"""
    w, h = img.size
    sh = Image.new("L", (w, h), 0)
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((depth, depth, w - depth - 1, h - depth - 1),
                         radius=int(w * 0.22) - depth, fill=255)
    sh = sh.filter(Image.filter if False else __import__('PIL.ImageFilter', fromlist=['GaussianBlur']).GaussianBlur(depth * 0.6))
    # 在原图上叠一个深色蒙版
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle((0, 0, w - 1, h - 1), radius=int(w * 0.22), fill=(0, 0, 0, alpha))
    overlay.putalpha(overlay.split()[3].point(lambda p: p * 0.5))
    # 简单跳过内阴影(可选)


def draw_K(img, color, stroke_w=72, k_h=560):
    """居中几何 K: 左竖条 + 上斜 + 下斜"""
    cx, cy = 512, 512
    half_h = k_h / 2
    left_x = cx - 140
    draw = ImageDraw.Draw(img)
    # 竖条
    draw.rounded_rectangle(
        (left_x, cy - half_h, left_x + stroke_w, cy + half_h),
        radius=stroke_w // 2,
        fill=color
    )
    # 上斜线
    draw.line(
        [(left_x + stroke_w / 2, cy - half_h + stroke_w / 2),
         (cx + 240, cy)],
        fill=color, width=stroke_w
    )
    # 下斜线
    draw.line(
        [(left_x + stroke_w / 2, cy + half_h - stroke_w / 2),
         (cx + 240, cy)],
        fill=color, width=stroke_w
    )


def make(name, fn):
    img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fn(img)
    img.save(os.path.join(OUT, f"icon-{name}.png"))
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"icon-{name}-512.png"))
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"icon-{name}-256.png"))


def e1_bg(img):
    """纯蓝紫渐变圆角方块,无字"""
    gradient_bg(img, (66, 56, 230), (192, 84, 246), "tlbr")
    rounded_mask(img, 0.22)


def e1_K(img):
    """蓝紫渐变 + 白 K"""
    gradient_bg(img, (66, 56, 230), (192, 84, 246), "tlbr")
    rounded_mask(img, 0.22)
    draw_K(img, (255, 255, 255), stroke_w=72, k_h=540)


if __name__ == "__main__":
    make("e1-bg", e1_bg)
    print("[ok] e1-bg")
    make("e1-K", e1_K)
    print("[ok] e1-K")