"""生成启动器图标 icon.ico（需要 Pillow）。"""
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # 没装 Pillow 就跳过，不影响打包
    print("Pillow 未安装，跳过图标生成")
    raise SystemExit(0)

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 深色圆角背景
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=(15, 23, 42, 255))
d.rounded_rectangle([8, 8, S - 9, S - 9], radius=50, outline=(56, 78, 122, 255), width=3)

# K 线柱
candles = [
    (48, 150, 196, 128, (34, 197, 94)),   # x, y_high, y_low, y_body, color
    (92, 132, 190, 156, (239, 68, 68)),
    (136, 104, 168, 130, (34, 197, 94)),
    (180, 72, 140, 96, (34, 197, 94)),
]
for cx, hi, lo, by, color in candles:
    d.line([(cx, hi), (cx, lo)], fill=color, width=6)
    d.rounded_rectangle([cx - 13, by, cx + 13, lo - 16], radius=5, fill=color)

# 上扬趋势线
d.line([(40, 178), (96, 150), (150, 118), (214, 62)], fill=(250, 204, 21, 255),
       width=9, joint="curve")
# 箭头
d.polygon([(214, 40), (222, 92), (172, 62)], fill=(250, 204, 21, 255))

out = Path(__file__).resolve().parent / "icon.ico"
img.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"已生成图标: {out}")
