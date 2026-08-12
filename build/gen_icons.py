"""
方案 A — 极简星轨系列 icon 生成器
4 个变体:每个生成 1024x1024 PNG, 同步缩放 512 PNG 对应 electron-builder。
轨道环 + 中心球的设计语言,呼应 NEXUS 核心球 + 轨道视图。
"""
import os
from PIL import Image, ImageDraw, ImageFilter
import math

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = (1024, 512, 256)

# 通用:深色背景 + 中心球 + 倾斜轨道环
def make_icon(name: str, draw_fn):
    """draw_fn(img: Image.Image, draw: ImageDraw.ImageDraw) -> None"""
    img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_fn(img, draw)
    img.save(os.path.join(OUT_DIR, f"icon-{name}.png"))
    # 512 缩放版(electron-builder 偏好)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, f"icon-{name}-512.png"))
    # 256 备用
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT_DIR, f"icon-{name}-256.png"))


def fill_rounded_bg(img: Image.Image, color: tuple):
    """填充圆角背景(边角透明,适合 macOS 圆角 mask)/ Fill rounded background."""
    w, h = img.size
    # 圆角半径 ~ 18% (macOS app icon 风格)
    r = int(w * 0.18)
    # 用单独图层画圆角矩形,再合成
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=color)
    img.paste(layer, (0, 0), layer)


def gradient_bg(img: Image.Image, c1: tuple, c2: tuple, direction: str = "tlbr"):
    """方向渐变背景。direction: tlbr / trbl / vertical / radial。"""
    w, h = img.size
    grad = Image.new("RGBA", (w, h))
    pix = grad.load()
    if direction == "radial":
        cx, cy = w / 2, h / 2
        maxd = math.hypot(cx, cy)
        for y in range(h):
            for x in range(w):
                d = math.hypot(x - cx, y - cy) / maxd
                d = min(1.0, max(0.0, d))
                r = int(c1[0] * (1 - d) + c2[0] * d)
                g = int(c1[1] * (1 - d) + c2[1] * d)
                b = int(c1[2] * (1 - d) + c2[2] * d)
                pix[x, y] = (r, g, b, 255)
    else:
        for y in range(h):
            for x in range(w):
                if direction == "tlbr":
                    t = (x + y) / (2 * w)
                elif direction == "trbl":
                    t = (w - x + y) / (2 * w)
                elif direction == "vertical":
                    t = y / h
                else:  # horizontal
                    t = x / w
                r = int(c1[0] * (1 - t) + c2[0] * t)
                g = int(c1[1] * (1 - t) + c2[1] * t)
                b = int(c1[2] * (1 - t) + c2[2] * t)
                pix[x, y] = (r, g, b, 255)
    img.paste(grad, (0, 0), grad)


def draw_ellipse_rotated(img: Image.Image, cx: float, cy: float, rx: float, ry: float, angle_deg: float, color: tuple, width: int):
    """画一个旋转的椭圆轮廓。angle 单位:度。"""
    draw = ImageDraw.Draw(img)
    ellipse_img = Image.new("RGBA", (int(rx * 2 + width * 2), int(ry * 2 + width * 2)), (0, 0, 0, 0))
    ed = ImageDraw.Draw(ellipse_img)
    ed.ellipse((width, width, rx * 2 + width, ry * 2 + width), outline=color, width=width)
    rotated = ellipse_img.rotate(-angle_deg, resample=Image.BICUBIC, expand=False)
    bbox_w, bbox_h = rotated.size
    img_w, img_h = img.size
    px = int(cx - bbox_w / 2)
    py = int(cy - bbox_h / 2)
    # 防止越界
    px = max(0, min(px, img_w - bbox_w))
    py = max(0, min(py, img_h - bbox_h))
    img.paste(rotated, (px, py, px + bbox_w, py + bbox_h), rotated)


def draw_glow_ball(img: Image.Image, cx: float, cy: float, r: float, color: tuple, glow: float = 0.0):
    """中心球 + 可选光晕。"""
    if glow > 0:
        glow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow_layer)
        gd.ellipse((cx - r * (1 + glow), cy - r * (1 + glow), cx + r * (1 + glow), cy + r * (1 + glow)), fill=(*color, 60))
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(r * glow * 0.5))
        img.paste(glow_layer, (0, 0), glow_layer)
    # 主体球
    ball = Image.new("RGBA", img.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(ball)
    bd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    # 内部高光
    hl = r * 0.35
    bd.ellipse((cx - hl * 0.5 - r * 0.2, cy - r * 0.5, cx + hl - r * 0.2, cy), fill=(*color, 200))
    img.paste(ball, (0, 0), ball)


# ─────────────────────────────────────────────────────────────
# A1: 单轨原始 — 深紫底 + 单条金色轨道 + 中心白球
# ─────────────────────────────────────────────────────────────
def variant_a1(img: Image.Image, draw: ImageDraw.ImageDraw):
    gradient_bg(img, (35, 16, 56), (88, 28, 135), "radial")  # 深紫 → 中紫径向
    # 轨道椭圆 (倾斜 22°)
    draw_ellipse_rotated(img, 512, 512, 340, 130, 22, (255, 198, 92, 230), 18)  # 金色
    # 中心球
    draw_glow_ball(img, 512, 512, 95, (255, 255, 255), glow=1.2)


# ─────────────────────────────────────────────────────────────
# A2: 双轨 — 深紫底 + 内深外浅两条轨道 + 金点
# ─────────────────────────────────────────────────────────────
def variant_a2(img: Image.Image, draw: ImageDraw.ImageDraw):
    gradient_bg(img, (28, 12, 48), (74, 22, 122), "radial")
    # 外轨道 (浅金)
    draw_ellipse_rotated(img, 512, 512, 380, 145, 22, (255, 186, 102, 180), 14)
    # 内轨道 (深紫 + 紫红)
    draw_ellipse_rotated(img, 512, 512, 260, 95, 22, (220, 130, 255, 220), 16)
    # 中心球 - 暖金
    draw_glow_ball(img, 512, 512, 88, (255, 215, 130), glow=1.4)


# ─────────────────────────────────────────────────────────────
# A3: 蓝紫渐变 — 深蓝紫底 + 蓝紫渐变轨道 + 中心冷白球
# ─────────────────────────────────────────────────────────────
def variant_a3(img: Image.Image, draw: ImageDraw.ImageDraw):
    gradient_bg(img, (14, 18, 48), (50, 32, 110), "radial")
    # 单条轨道 — 蓝紫渐变(用两层叠加模拟)
    draw_ellipse_rotated(img, 512, 512, 360, 140, 24, (130, 145, 255, 240), 20)
    # 中心球 — 冷白
    draw_glow_ball(img, 512, 512, 92, (220, 230, 255), glow=1.3)


# ─────────────────────────────────────────────────────────────
# A4: 暖琥珀 — 深棕红底 + 琥珀色轨道 + 中心金球(类似原 icon 暖色调)
# ─────────────────────────────────────────────────────────────
def variant_a4(img: Image.Image, draw: ImageDraw.ImageDraw):
    gradient_bg(img, (62, 22, 18), (138, 58, 28), "radial")
    # 轨道 — 琥珀色
    draw_ellipse_rotated(img, 512, 512, 345, 132, 22, (255, 175, 86, 235), 19)
    # 中心球 — 暖白
    draw_glow_ball(img, 512, 512, 95, (255, 240, 215), glow=1.25)


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    for vid, fn in [("a1", variant_a1), ("a2", variant_a2), ("a3", variant_a3), ("a4", variant_a4)]:
        make_icon(vid, fn)
        print(f"[ok] {vid} 1024 + 512 + 256")
    print(f"\n输出到: {OUT_DIR}")
    print("已生成图标:icon-a1.png, icon-a2.png, icon-a3.png, icon-a4.png")
