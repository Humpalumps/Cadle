# gate.py <dir> — analyze gate screenshots. Exit 0 = pass, 1 = fail.
# Checks (see tools/gate.mjs):
#  1. WHITE BLOBS: on every blob-*.png (camera pitched -0.55 into pure meadow, HUD hidden) find
#     connected clusters of near-white pixels (min(R,G,B) >= WHITE). Any cluster >= MIN_AREA px
#     (at 960px width) fails — that is a washed-white glowing blob, the thing the user decree bans.
#     Colored glows (lanterns, aether violet) have a low min-channel and pass.
#  2. JITTER: burst-jit-*.png, static camera with the WORLD FROZEN (game.paused, rendering still
#     running). Wind/clouds/water cannot contribute, so any per-frame change is pure rendering
#     instability — TAA failing to converge, animated dither. Measured across the FULL frame, and
#     the drift must not grow (a non-converging TAA ramps upward: verified 1.17 -> 3.21 at q=high
#     while q=low sat flat at 1.15, matching the user-visible "jitter on high, none on low").
import sys, os, glob, json
from PIL import Image, ImageChops

WHITE = 232        # min-channel threshold for "washed white"
MIN_AREA = 16      # px at 960-wide downscale (~0.5m blob at 20m); flowers/specks stay below
JITTER_MAX = 2.0   # mean abs diff (0..255) between consecutive frames with the world frozen
                   # (grain-only baseline measures ~1.15; a non-converging TAA climbs past 3)

d = sys.argv[1] if len(sys.argv) > 1 else 'tools/out/gate'
fails, report = [], {}

def clusters(img):
    im = img.convert('RGB')
    w = 960; h = round(im.height * w / im.width)
    im = im.resize((w, h))
    px = im.load()
    mask = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if min(r, g, b) >= WHITE: mask[y * w + x] = 1
    seen = bytearray(w * h); out = []
    for i in range(w * h):
        if mask[i] and not seen[i]:
            stack = [i]; seen[i] = 1; n = 0
            while stack:
                j = stack.pop(); n += 1
                x, y = j % w, j // w
                for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx, ny = x+dx, y+dy
                    if 0 <= nx < w and 0 <= ny < h:
                        k = ny * w + nx
                        if mask[k] and not seen[k]: seen[k] = 1; stack.append(k)
            if n >= MIN_AREA: out.append(n)
    return sorted(out, reverse=True)

for f in sorted(glob.glob(os.path.join(d, 'shot-blob-*.png'))):
    c = clusters(Image.open(f))
    report[os.path.basename(f)] = c[:8]
    if c: fails.append(f'BLOBS: {os.path.basename(f)} has {len(c)} washed-white cluster(s), largest {c[0]} px — user decree: no white blobs, saturate the color / cut the intensity')

jit = sorted(glob.glob(os.path.join(d, 'burst-jit-*.png')))
if len(jit) >= 3:
    diffs = []
    prev = None
    for f in jit:
        im = Image.open(f).convert('L')   # full frame: the world is frozen, so nothing legitimate moves
        if prev is not None:
            df = ImageChops.difference(prev, im)
            hist = df.histogram()
            total = sum(hist); mean = sum(i * n for i, n in enumerate(hist)) / max(total, 1)
            diffs.append(round(mean, 3))
        prev = im
    report['jitter_diffs'] = diffs
    worst = max(diffs)
    if worst > JITTER_MAX:
        fails.append(f'JITTER: frozen-world frame diff {worst} > {JITTER_MAX} (pairs: {diffs}) — the renderer keeps changing a static scene; TAA is not converging (see HANDOVER "jitter")')
    elif len(diffs) >= 3 and diffs[-1] > diffs[0] * 2 and diffs[-1] > 1.6:
        fails.append(f'JITTER: frozen-world drift is RAMPING ({diffs}) — TAA history is diverging instead of settling')
else:
    fails.append('JITTER: burst-jit frames missing — gate steps did not run')

json.dump({'fails': fails, 'report': report}, open(os.path.join(d, 'gate-report.json'), 'w'), indent=1)
if fails:
    print('GATE FAIL')
    for f in fails: print(' -', f)
    sys.exit(1)
print('GATE PASS (blob shots clean, jitter', report.get('jitter_diffs'), ')')
