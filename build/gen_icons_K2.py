"""
默认 icon 换底色:把灰底 (29,29,33) 替换为 d1 的蓝紫渐变 (#4238E6 → #C054F6)
保留原 logo 主体(中间的几何图案)
"""
import os
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))

src = Image.open(os.path.join(OUT, "icon@1024.png")).convert("RGBA")
w, h = src.size
print(f"src size: {w}x{h}")

# 1. 检测 alpha mask(原 icon 的圆角形状)
# 抠出非透明区域作为 mask
mask = src.split()[3]  # alpha 通道
print(f"alpha range: {mask.getextrema()}")

# 2. 创建蓝紫渐变 (与 d1 一致)
grad = Image.new("RGBA", (w, h), (0, 0, 0, 0))
gpx = grad.load()
c1 = (66, 56, 230)   # #4238E6 蓝
c2 = (192, 84, 246)  # #C054F6 紫
for y in range(h):
    for x in range(w):
        t = (x + y) / (2 * w)  # tlbr 渐变
        r = int(c1[0] * (1 - t) + c2[0] * t)
        g = int(c1[1] * (1 - t) + c2[1] * t)
        b = int(c1[2] * (1 - t) + c2[2] * t)
        gpx[x, y] = (r, g, b, 255)

# 3. 用原 icon 的 alpha 把渐变裁成圆角
out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
out.paste(grad, (0, 0), mask)

# 4. 把原 logo 内容盖回去(原 logo 是不透明像素,非透明区域会显示原图)
# 但原 logo 可能在灰底上也有颜色,先抠出"非底色"像素
# 简单做法:把原图非底色像素(不是 (29,29,33) 也不是其附近灰) 保留
# 用颜色距离判断:远离 (29,29,33) 的像素保留
logo_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
src_px = src.load()
logo_px = logo_layer.load()
bg_color = (29, 29, 33)
threshold = 40  # 颜色距离阈值
for y in range(h):
    for x in range(w):
        r, g, b, a = src_px[x, y]
        if a == 0:
            continue
        # 距离背景色
        dist = abs(r - bg_color[0]) + abs(g - bg_color[1]) + abs(b - bg_color[2])
        if dist > threshold:
            # 非背景色像素,保留(并加一点亮度,因为原来在灰底上可能偏暗)
            logo_px[x, y] = (r, g, b, a)

out.paste(logo_layer, (0, 0), logo_layer)

# 保存
out.save(os.path.join(OUT, "icon-default-bluepurple.png"))
out.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-default-bluepurple-512.png"))
out.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon-default-bluepurple-256.png"))
print("done: icon-default-bluepurple.png (1024/512/256)")