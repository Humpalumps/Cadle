# blobcheck.py <dir> <prefix> — the blob detector. Exit 0 = clean, 1 = blobs found.
#
# WHY THIS EXISTS (read before changing thresholds — they are orchestrator-owned):
# Glowing blobs on the grass have shipped five separate times, each from a DIFFERENT source
# (flower-head emissive, wisp glow white-clipping, grass tip specular, grass rim emissive,
# wisp-trail vfx + silvering/translucency stacking).
# Two earlier detectors missed them:
#   - a near-WHITE test missed BLUE/violet aether blobs (low red channel),
#   - a STATIC-frame test missed FLASHING blobs that appear between screenshots.
# So this checks bursts, in two independent ways:
#   1) BRIGHT: connected COMPACT clusters of high-luminance pixels of ANY hue, in any frame.
#      Thin strips (bbox aspect > MAX_ASPECT) are horizon/water/shoreline highlights, not blobs —
#      a bloom-smeared blob is roughly round. Flashing strips still fail via (2).
#   2) FLASH: per-pixel luminance SPIKES across consecutive frames of a burst, where the pixel is
#      GLOWING (>= LUM_BRIGHT) in at least one of the two frames. A blade of grass moving in wind
#      swings a pixel between mid-greens; a blob IGNITING swings it to glowing. Requiring the bright
#      endpoint is what separates the user-visible flash from ordinary wind/walk motion.
#      Consecutive means within one burst: frames are only diffed against the SAME burst group
#      (name minus trailing -N) — diffing across an hour change flagged the whole frame.
# Sanity: a near-black frame (mean luminance < DEAD_LUM) fails the run — a dead GPU/WebGL init
# renders black everywhere, which would otherwise pass as "no blobs".
import sys, os, glob, json, re
from PIL import Image

LUM_BRIGHT = 212      # luminance 0..255 counted as "glowing". Calibrated against measured scenes:
                      # every real glow bug (wisp trails, emissive sights, lantern flames) measured
                      # 230+ after ACES, while legitimate sunlit pale surfaces (distant canopy, rock,
                      # birch trunks) sit at ~202-208 and must not fail the gate. Grass itself is
                      # luminance-capped at 0.60 linear (~198 sRGB) so it can never reach this.
MIN_AREA   = 12       # px at 960-wide; smaller than this is a speck, not a blob
MAX_ASPECT = 6        # bright bbox w:h beyond this is a strip (horizon/water), not a blob
FLASH_DELTA = 55      # per-pixel luminance jump between consecutive frames counted as a spike
FLASH_AREA  = 10      # clustered spiking pixels that constitute a "flash"
DEAD_LUM    = 8       # mean frame luminance below this = render failure, fail loudly

def load(path, w=960):
    im = Image.open(path).convert('RGB')
    return im.resize((w, round(im.height * w / im.width)))

def lum_map(im):
    px = im.load(); w, h = im.size
    return [int(0.2126*px[x,y][0] + 0.7152*px[x,y][1] + 0.0722*px[x,y][2]) for y in range(h) for x in range(w)], w, h

def clusters(flags, w, h, min_area, im=None, max_aspect=None):
    seen = bytearray(w*h); out = []
    px = im.load() if im else None
    for i in range(w*h):
        if flags[i] and not seen[i]:
            st=[i]; seen[i]=1; n=0; rs=gs=bs=0
            x0=x1=i%w; y0=y1=i//w
            while st:
                j=st.pop(); n+=1
                x,y = j%w, j//w
                x0=min(x0,x); x1=max(x1,x); y0=min(y0,y); y1=max(y1,y)
                if px: c=px[x,y]; rs+=c[0]; gs+=c[1]; bs+=c[2]
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx,ny = x+dx, y+dy
                    if 0<=nx<w and 0<=ny<h:
                        k=ny*w+nx
                        if flags[k] and not seen[k]: seen[k]=1; st.append(k)
            if n >= min_area:
                bw, bh = x1-x0+1, y1-y0+1
                if max_aspect and max(bw,bh) > max_aspect * min(bw,bh): continue
                out.append({'px': n, 'bbox': [x0,y0,x1,y1], 'rgb': (rs//n, gs//n, bs//n) if px else None})
    return sorted(out, key=lambda c: -c['px'])

def main():
    d = sys.argv[1]; prefix = sys.argv[2] if len(sys.argv) > 2 else 'burst-'
    files = sorted(glob.glob(os.path.join(d, f'{prefix}*.png')))
    if not files:
        print(f'BLOBCHECK: no frames matched {prefix}*.png in {d}'); return 1
    fails, report = [], {}
    prev_l = None; prev_name = None; prev_group = None
    for f in files:
        name = os.path.basename(f)
        group = re.sub(r'-\d+\.png$', '', name)
        im = load(f); L, w, h = lum_map(im)
        if sum(L) / len(L) < DEAD_LUM:
            fails.append(f'DEAD FRAME: {name} — mean luminance < {DEAD_LUM}, renderer produced black (GPU/WebGL failure?)')
            prev_l, prev_name, prev_group = None, None, None
            continue
        bright = clusters([1 if v >= LUM_BRIGHT else 0 for v in L], w, h, MIN_AREA, im, MAX_ASPECT)
        if bright:
            report[name] = {'bright': bright[:6]}
            top = bright[0]
            fails.append(f"BRIGHT BLOB: {name} — {len(bright)} glowing cluster(s), largest {top['px']} px at {top['bbox']}, mean rgb {top['rgb']}")
        if prev_l is not None and group == prev_group:
            spike = clusters([1 if abs(a-b) >= FLASH_DELTA and max(a,b) >= LUM_BRIGHT else 0 for a, b in zip(L, prev_l)], w, h, FLASH_AREA, im)
            if spike:
                report.setdefault(name, {})['flash'] = spike[:6]
                top = spike[0]
                fails.append(f"FLASHING BLOB: {name} vs {prev_name} — {len(spike)} cluster(s) spiked to glowing, largest {top['px']} px at {top['bbox']}, mean rgb {top['rgb']}")
        prev_l, prev_name, prev_group = L, name, group
    json.dump({'fails': fails, 'report': report}, open(os.path.join(d, 'blobcheck.json'), 'w'), indent=1)
    if fails:
        print('BLOBCHECK FAIL')
        for x in fails[:12]: print(' -', x)
        if len(fails) > 12: print(f'   ...and {len(fails)-12} more')
        return 1
    print(f'BLOBCHECK PASS ({len(files)} frames: no glowing clusters, no flashes)')
    return 0

sys.exit(main())
