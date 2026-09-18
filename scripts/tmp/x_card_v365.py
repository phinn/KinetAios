#!/usr/bin/env python3
"""KinetAios X 宣传图 v2:浅色高级感,KinetTask x_post_card 同构 —— 左文右图(真实 UI 截图)"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1600, 900

# ── 浅色底:淡蓝白渐变(左上微冷 → 右下微暖),干净大气 ──
base = Image.new("RGB", (W, H))
for x in range(W):
    tx = x / W
    for y in range(H):
        ty = y / H
        r = int(244 - 14 * tx + 4 * ty)
        g = int(247 - 10 * tx - 2 * ty)
        b = int(252 - 4 * tx - 6 * ty)
        base.putpixel((x, y), (r, g, b))
# 右上一抹品牌色光晕(青/紫,极淡)
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W - 500, -260, W + 300, 320], fill=(51, 199, 217, 255))
gd.ellipse([-260, H - 380, 380, H + 260], fill=(107, 92, 242, 255))
glow = glow.filter(ImageFilter.GaussianBlur(260))
base = Image.blend(base, glow, 0.10)
draw = ImageDraw.Draw(base)

def font(size, bold=True):
    if bold:
        return ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", size)
    return ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", size, index=0)

INK = (24, 28, 40)        # 主文字(近黑)
SUB = (96, 104, 122)      # 副文字
ACCENT = (107, 92, 242)   # 品牌紫
CYAN = (51, 160, 200)

# ── 顶部:icon + 品牌名 ──
icon = Image.open("dist/resources/icon@1024.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
imask = Image.new("L", (96, 96), 0)
ImageDraw.Draw(imask).rounded_rectangle([0, 0, 96, 96], radius=22, fill=255)
base.paste(icon, (100, 72), imask)
draw.text((216, 88), "KinetAios", font=font(56), fill=INK)
draw.text((218, 152), "v3.6.5", font=font(28, False), fill=SUB)

# ── 大标题 + 副标题 ──
LX = 100
draw.text((LX, 250), "AI Agent,runs local.", font=font(72), fill=INK)
draw.text((LX, 360), "本地优先的多引擎 Agent 仪表盘", font=font(38, False), fill=SUB)

# ── 4 条核心卖点(✓ 圆点列表,KinetTask 同构)──
points = [
    ("三大引擎", "Direct / Claude Code / Codex 一键切换"),
    ("Skills 自动加载", "任务匹配即加载,90+ 技能全量可见"),
    ("Token 拆分记账", "输入输出逐次明细,成本可考古"),
    ("过夜 Goal 模式", "替身验收 + 5h 窗口主动接力"),
]
PY = 470
for i, (head, desc) in enumerate(points):
    y = PY + i * 74
    # ✓ 圆点
    cy = y + 22
    draw.ellipse([LX + 2, cy - 20, LX + 44, cy + 22], fill=(90, 200, 250))
    ck = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 28)
    draw.text((LX + 13, cy - 16), "✓", font=ck, fill=(255, 255, 255))
    # 粗体头 + 灰色描述(同一行)
    hf = font(34)
    hw = draw.textlength(head, font=hf)
    draw.text((LX + 66, y), head, font=hf, fill=INK)
    draw.text((LX + 66 + hw + 22, y + 5), desc, font=font(30, False), fill=SUB)

# ── 底部徽章 ──
BY = 790
draw.rounded_rectangle([LX, BY, LX + 640, BY + 74], radius=37, fill=(255, 255, 255),
                       outline=(210, 216, 230), width=2)
draw.text((LX + 36, BY + 18), "本地运行 · 数据不出机器", font=font(32), fill=INK)
draw.text((LX + 680, BY + 24), "Win 11 & macOS", font=font(28, False), fill=SUB)
draw.text((LX, BY + 96), "github.com/phinn/KinetAios", font=font(26, False), fill=CYAN)

# ── 右侧:真实 UI 截图 + mac 窗口框(圆角 + 顶栏红绿灯 + 投影)──
shot = Image.open("build/ka-ui.png").convert("RGBA")
# 裁掉左侧边栏的 40%(突出聊天主区)+ 底部留 5%
sw0, sh0 = shot.size
shot = shot.crop((int(sw0 * 0.38), 0, sw0, int(sh0 * 0.97)))
sh = 700
sw = int(shot.width * sh / shot.height)  # ~700
shot = shot.resize((sw, sh), Image.LANCZOS)
sx = W - sw - 70
sy = 120
# 投影
shadow = Image.new("RGBA", (sw + 120, sh + 120), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([60, 60, 60 + sw, 60 + sh], radius=28, fill=(30, 40, 80, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(30))
base.paste(Image.new("RGB", shadow.size, (0, 0, 0)), (sx - 60, sy - 60), shadow.split()[3].point(lambda a: int(a * 0.35)))
base = base.convert("RGBA")
overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
# 窗口外框(mac 风格)
od.rounded_rectangle([sx - 2, sy - 2, sx + sw + 2, sy + sh + 2], radius=26, fill=(252, 252, 254, 255),
                     outline=(198, 204, 218, 255), width=2)
# 顶栏(红绿灯)
od.rounded_rectangle([sx - 2, sy - 2, sx + sw + 2, sy + 34], radius=26, fill=(240, 242, 247, 255))
od.rectangle([sx - 2, sy + 20, sx + sw + 2, sy + 34], fill=(240, 242, 247, 255))
for k, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    od.ellipse([sx + 18 + k * 26, sy + 9, sx + 34 + k * 26, sy + 25], fill=c + (255,))
base = Image.alpha_composite(base, overlay)
# 内容区圆角裁剪贴入
cmask = Image.new("L", (sw, sh), 0)
ImageDraw.Draw(cmask).rounded_rectangle([0, 0, sw, sh], radius=22, fill=255)
base.paste(shot.convert("RGB"), (sx, sy + 32), cmask)
base = base.convert("RGB")
draw = ImageDraw.Draw(base)

base.save("build/x_card_v365.png")
print("saved build/x_card_v365.png", base.size)
