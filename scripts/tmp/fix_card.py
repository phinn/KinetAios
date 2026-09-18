#!/usr/bin/env python3
"""v4:新截图 + 位置右上贴边,带 mac 窗口框浮层,文字区左移让开"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W, H = 1600, 900
base = Image.new("RGB", (W, H))
for x in range(W):
    tx = x / W
    for y in range(H):
        ty = y / H
        base.putpixel((x, y), (int(244 - 14*tx + 4*ty), int(247 - 10*tx - 2*ty), int(252 - 4*tx - 6*ty)))
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W-500, -260, W+300, 320], fill=(51,199,217,255))
gd.ellipse([-260, H-380, 380, H+260], fill=(107,92,242,255))
glow = glow.filter(ImageFilter.GaussianBlur(260))
base = Image.blend(base, glow, 0.10)

def font(size, bold=True):
    return ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/Hiragino Sans GB.ttc", size, **({'index':0} if not bold else {}))

INK=(24,28,40); SUB=(96,104,122); CYAN=(41,150,190)

# ── 右侧:真实 UI 截图,mac 窗口框浮层,右上贴边,大尺寸,底投影 ──
shot = Image.open("build/ka-ui.png").convert("RGB")
sw0, sh0 = shot.size
# 裁:去掉最左 1/4(侧栏太窄)+ 顶部系统栏区域(截图是纯窗口,无需裁顶),保留下方输入框
shot = shot.crop((int(sw0*0.235), int(sh0*0.045), sw0, int(sh0*0.985)))  # 裁掉窗口自带标题栏(红绿灯在下面自绘)
sh = 800
sw = int(shot.width * sh / shot.height)
shot = shot.resize((sw, sh), Image.LANCZOS)
sx = W - sw - 44   # 右贴边留 44px
sy = 56            # 顶留 56px

# 投影(先画,落在底上)
shadow = Image.new("RGBA", base.size, (0,0,0,0))
ImageDraw.Draw(shadow).rounded_rectangle([sx-8, sy+10, sx+sw+8, sy+sh+18], radius=30, fill=(40, 50, 90, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(26))
base = Image.alpha_composite(base.convert("RGBA"), shadow)

# 窗口框(mac 浅灰顶栏 + 红绿灯)
overlay = Image.new("RGBA", base.size, (0,0,0,0))
od = ImageDraw.Draw(overlay)
BAR = 44
od.rounded_rectangle([sx, sy, sx+sw, sy+sh], radius=24, fill=(252,252,254,255), outline=(200,206,220,255), width=2)
od.rounded_rectangle([sx, sy, sx+sw, sy+BAR], radius=24, fill=(238,240,246,255))
od.rectangle([sx, sy+BAR-16, sx+sw, sy+BAR], fill=(238,240,246,255))
for k, c in enumerate([(255,95,86),(255,189,46),(39,201,63)]):
    od.ellipse([sx+20+k*27, sy+14, sx+38+k*27, sy+32], fill=c+(255,))
base = Image.alpha_composite(base, overlay)

# 内容圆角裁剪贴入
cmask = Image.new("L", (sw, sh), 0)
cd = ImageDraw.Draw(cmask)
cd.rounded_rectangle([0, 0, sw, sh], radius=18, fill=255)
cd.rectangle([0, 0, sw, BAR], fill=255)      # 顶栏区域全显示(由窗口框绘制覆盖)
cd.rectangle([0, sh-BAR-24, sw, sh], fill=255)  # 底部两角补直
# 左缘 220px 渐隐到透明(与浅底自然衔接)
fade = Image.new("L", (sw, sh), 255)
fd = ImageDraw.Draw(fade)
for x in range(220):
    fd.line([(x, 0), (x, sh)], fill=int(255 * x / 220))
cmask = Image.composite(cmask, Image.new("L", cmask.size, 0), fade.point(lambda a: a)) if False else ImageChops.multiply(cmask, fade)
base.paste(shot, (sx, sy+BAR), cmask)
base = base.convert("RGB")
draw = ImageDraw.Draw(base)

# ── 左侧文字区(右边界 ~760,避开截图)──
icon = Image.open("build/appicon-1024.png").convert("RGBA").resize((88, 88), Image.LANCZOS)
imask = Image.new("L", (88, 88), 0)
ImageDraw.Draw(imask).rounded_rectangle([0, 0, 88, 88], radius=20, fill=255)
base.paste(icon, (92, 70), imask)
draw.text((200, 82), "KinetAios", font=font(52), fill=INK)
draw.text((202, 144), "v3.6.5", font=font(26, False), fill=SUB)

LX = 92
draw.text((LX, 250), "AI Agent,", font=font(76), fill=INK)
draw.text((LX, 345), "runs local.", font=font(76), fill=(107, 92, 242))
draw.text((LX, 465), "本地优先的多引擎 Agent 仪表盘", font=font(33, False), fill=SUB)

points = [
    ("三大引擎", "Direct / Claude Code / Codex"),
    ("Skills 自动加载", "任务匹配即拉取正文"),
    ("Token 拆分记账", "逐次明细 · 成本可考古"),
    ("过夜 Goal 模式", "替身验收 · 5h 主动接力"),
]
PY = 560
f_head = font(30)
f_desc = font(25, False)
for i, (head, desc) in enumerate(points):
    y = PY + i * 58
    cy = y + 18
    draw.ellipse([LX+2, cy-18, LX+38, cy+18], fill=(90, 200, 250))
    draw.line([(LX+12, cy+1), (LX+19, cy+9)], fill=(255,255,255), width=4)
    draw.line([(LX+19, cy+9), (LX+30, cy-9)], fill=(255,255,255), width=4)
    draw.text((LX+56, y), head, font=f_head, fill=INK)
    hw = draw.textlength(head, font=f_head)
    dw = draw.textlength(desc, font=f_desc)
    if LX+56+hw+16+dw > 680:
        draw.text((LX+56, y+38), desc, font=f_desc, fill=SUB)
    else:
        draw.text((LX+56+hw+16, y+3), desc, font=f_desc, fill=SUB)

# ── 底部徽章(左下角,避开截图)──
BY = 836
draw.rounded_rectangle([LX, BY, LX+520, BY+52], radius=26, fill=(255,255,255), outline=(210,216,230), width=2)
draw.text((LX+28, BY+11), "本地运行 · 数据不出机器", font=font(26), fill=INK)
draw.text((LX+556, BY+16), "Win 11 & macOS  ·  github.com/phinn/KinetAios", font=font(22, False), fill=CYAN)

base.save("build/x_card_v365.png")
print("saved", base.size)
