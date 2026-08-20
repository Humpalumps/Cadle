# blobcheck.py <dir> <prefix> — the blob detector. Exit 0 = clean, 1 = blobs found.
#
# WHY THIS EXISTS (read before changing thresholds — they are orchestrator-owned):
# Glowing blobs on the grass have shipped four separate times, each from a DIFFERENT source
# (flower-head emissive, wisp glow white-clipping, grass tip specular, grass rim emissive).
# Two earlier detectors missed them:
#   - a near-WHITE test missed BLUE/violet aether blobs (low red channel),
#   - a STATIC-frame test missed FLASHING blobs that appear between screenshots.
# So this checks bursts, in two independent ways:
#   1) BRIGHT: connected clusters of high-luminance pixels of ANY hue, in any frame.
#   2) FLASH:  per-pixel luminance SPIKES across consecutive frames of a burst. A blade of grass
#      moving in wind changes a pixel a little; a blob igniting changes it a lot, in a blob-shaped
#      cluster. This is what actually catches the "flashing" the user sees.
import sys, os, glob, json
from PIL import Image

LUM_BRIGHT = 200      # luminance 0..255 counted as "glowing"
MIN_AREA   = 12       # px at 960-wide; smaller than this is a speck, not a blob
FLASH_DELTA = 55      # per-pixel luminance jump between consecutive frames counted as a spike
FLASH_AREA  = 10      # clustered spiking pixels that constitute a "flash"

def load(path, w=960):
    im = Image.open(path).convert('RGB')
    return im.resize((w, round(im.height * w / im.width)))

def lum_map(im):
    px = im.load(); w, h = im.size
    return [int(0.2126*px[x,y][0] + 0.7152*px[x,y][1] + 0.0722*px[x,y][2]) for y in range(h) for x in range(w)], w, h

def clusters(flags, w, h, min_area, im=None):
    seen = bytearray(w*h); out = []
    px = im.load() if im else None
    for i in range(w*h):
        if flags[i] and not seen[i]:
            st=[i]; seen[i]=1; n=0; rs=gs=bs=0
            while st:
                j=st.pop(); n+=1
                x,y = j%w, j//w
                if px: c=px[x,y]; rs+=c[0]; gs+=c[1]; bs+=c[2]
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx,ny = x+dx, y+dy
                    if 0<=nx<w and 0<=ny<h:
                        k=ny*w+nx
                        if flags[k] and not seen[k]: seen[k]=1; st.append(k)
            if n >= min_area:
                out.append({'px': n, 'rgb': (rs//n, gs//n, bs//n) if px else None})
    return sorted(out, key=lambda c: -c['px'])

def main():
    d = sys.argv[1]; prefix = sys.argv[2] if len(sys.argv) > 2 else 'burst-'
    files = sorted(glob.glob(os.path.join(d, f'{prefix}*.png')))
    if not files:
        print(f'BLOBCHECK: no frames matched {prefix}*.png in {d}'); return 1
    fails, report = [], {}
    prev_l = None; prev_name = None
    for f in files:
        name = os.path.basename(f)
        im = load(f); L, w, h = lum_map(im)
        bright = clusters([1 if v >= LUM_BRIGHT else 0 for v in L], w, h, MIN_AREA, im)
        if bright:
            report[name] = {'bright': bright[:6]}
            top = bright[0]
            fails.append(f"BRIGHT BLOB: {name} — {len(bright)} glowing cluster(s), largest {top['px']} px, mean rgb {top['rgb']}")
        if prev_l is not None:
            spike = clusters([1 if abs(a-b) >= FLASH_DELTA else 0 for a, b in zip(L, prev_l)], w, h, FLASH_AREA, im)
            if spike:
                report.setdefault(name, {})['flash'] = spike[:6]
                top = spike[0]
                fails.append(f"FLASHING BLOB: {name} vs {prev_name} — {len(spike)} cluster(s) spiked, largest {top['px']} px, mean rgb {top['rgb']}")
        prev_l, prev_name = L, name
    json.dump({'fails': fails, 'report': report}, open(os.path.join(d, 'blobcheck.json'), 'w'), indent=1)
    if fails:
        print('BLOBCHECK FAIL')
        for x in fails[:12]: print(' -', x)
        if len(fails) > 12: print(f'   ...and {len(fails)-12} more')
        return 1
    print(f'BLOBCHECK PASS ({len(files)} frames: no glowing clusters, no flashes)')
    return 0

sys.exit(main())
