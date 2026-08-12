"""
字母 K — 4 个变体
方案 D:渐变底 + 几何 K 字母。Claude/Cursor 同款路线,极简高端。
变体: D1 蓝紫渐变 / D2 极简白 K 紫底 / D3 暗色描边 K / D4 暖琥珀
"""
import os
from PIL import Image, ImageDraw, ImageFilter
import math

OUT = os.path.dirname(os.path.abspath(__file__))


def make(name, fn):
    img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    fn(img, draw)
    img.save(os.path.join(OUT, f"icon-{name}.png"))
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"icon-{name}-512.png"))
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"icon-{name}-256.png"))


def gradient_bg(img, c1, c2, mode="tlbr"):
    """mode: tlbr / trbl / radial / vertical"""
    w, h = img.size
    grad = Image.new("RGBA", (w, h))
    px = grad.load()
    if mode == "radial":
        cx, cy = w / 2, h / 2
        maxd = math.hypot(cx, cy)
        for y in range(h):
            for x in range(w):
                d = min(1.0, max(0.0, math.hypot(x - cx, y - cy) / maxd))
                px[x, y] = (int(c1[0]*(1-d)+c2[0]*d), int(c1[1]*(1-d)+c2[1]*d), int(c1[2]*(1-d)+c2[2]*d), 255)
    else:
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
    """圆角遮罩 (macOS app icon 风格)"""
    w, h = img.size
    r = int(w * radius_ratio)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    img.paste(out, (0, 0))


def draw_K_geometric(img, color, stroke_w=64, k_h=560):
    """画一个现代几何 K:
    - 左竖:垂直粗条
    - 上斜:左上→右中(顶到中心)
    - 下斜:左下→右中(底到中心)
    - K 高度 = k_h, 居中在 (512, 512)
    """
    cx, cy = 512, 512
    half_h = k_h / 2
    # 竖条:从 (cx - 110, cy - half_h) 到 (cx - 110 + stroke_w, cy + half_h)
    left_x = cx - 130
    # 竖条
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        (left_x, cy - half_h, left_x + stroke_w, cy + half_h),
        radius=stroke_w // 2,
        fill=color
    )
    # 上斜:从竖条顶部斜向上到右上
    # 用 polygon 画一根斜条
    slope_w = stroke_w
    # 上斜起点 (竖条顶部右侧), 终点 (右侧中部上方)
    top_y = cy - half_h
    bot_y = cy + half_h
    right_x = cx + 230
    mid_x = cx - 10  # 斜条交点在中心
    # 上斜条 polygon
    p1 = (left_x + stroke_w, top_y)  # 竖条上端右
    p2 = (left_x + stroke_w + slope_w * 0.4, top_y)  # 起点顶
    p3 = (right_x, cy - 20)  # 终点
    p4 = (right_x - slope_w * 0.4, cy + 20 - slope_w * 0.4)  # 终点下
    # 用更直接的方法 — 两点线 (粗)
    draw.line([(left_x + stroke_w / 2, top_y + slope_w / 2), (right_x, cy)], fill=color, width=slope_w)
    # 下斜
    draw.line([(left_x + stroke_w / 2, bot_y - slope_w / 2), (right_x, cy)], fill=color, width=slope_w)


# ─────────────────────────────────────────
# D1: 蓝紫渐变 + 白 K(主推, 类似 Cursor 风)
# ─────────────────────────────────────────
def d1(img, draw):
    gradient_bg(img, (66, 56, 230), (192, 84, 246), "tlbr")  # 蓝→紫
    rounded_mask(img)
    draw_K_geometric(img, (255, 255, 255), stroke_w=68, k_h=540)


# ─────────────────────────────────────────
# D2: 暗紫底 + 亮金 K(奢华感)
# ─────────────────────────────────────────
def d2(img, draw):
    gradient_bg(img, (24, 14, 56), (76, 32, 130), "radial")
    rounded_mask(img)
    draw_K_geometric(img, (255, 200, 110), stroke_w=68, k_h=540)


# ─────────────────────────────────────────
# D3: 深黑 + 蓝紫渐变 K(科技感)
# ─────────────────────────────────────────
def d3(img, draw):
    gradient_bg(img, (10, 10, 20), (32, 24, 60), "radial")
    rounded_mask(img)
    # K 用渐变色 — 先画 mask 再贴渐变
    mask_img = Image.new("L", img.size, 0)
    draw_K_geometric(mask_img, 255, stroke_w=68, k_h=540)
    k_grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gpx = grad.load()
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            t = (x + y) / (2 * img.size[0])
            gpx[x, y] = (int(96 * (1 - t) + 200 * t), int(140 * (1 - t) + 140 * t), int(255 * (1 - t) + 255 * t), 255)
    k_grad.paste(grad, (0, 0), mask_img)
    img.paste(k_grad, (0, 0), k_grad)


# ─────────────────────────────────────────
# D4: 暖琥珀 + 深棕底(温暖亲切)
# ─────────────────────────────────────────
def d4(img, draw):
    gradient_bg(img, (82, 38, 18), (180, 90, 38), "tlbr")
    rounded_mask(img)
    draw_K_geometric(img, (255, 248, 235), stroke_w=68, k_h=540)


if __name__ == "__main__":
    for n, fn in [("d1", d1), ("d2", d2), ("d3", d3), ("d4", d4)]:
        make(n, fn)
        print(f"[ok] {n}")
    print("done")