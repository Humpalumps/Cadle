# Contact sheet of all PNGs in a run dir: python tools/sheet.py tools/out/<name> [cols] [thumbw]
import sys, glob, os
from PIL import Image, ImageDraw
d = sys.argv[1]; cols = int(sys.argv[2]) if len(sys.argv) > 2 else 3; tw = int(sys.argv[3]) if len(sys.argv) > 3 else 640
files = sorted(glob.glob(os.path.join(d, '*.png'))); files = [f for f in files if not f.endswith('sheet.png')]
if not files: sys.exit('no pngs')
ims = [Image.open(f) for f in files]; th = int(tw * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * (th + 18)), (10, 10, 14)); dr = ImageDraw.Draw(sheet)
for i, (im, f) in enumerate(zip(ims, files)):
    x, y = (i % cols) * tw, (i // cols) * (th + 18)
    sheet.paste(im.resize((tw, th)), (x, y + 18)); dr.text((x + 4, y + 3), os.path.basename(f), fill=(220, 220, 220))
out = os.path.join(d, 'sheet.png'); sheet.save(out); print(out, sheet.size)
