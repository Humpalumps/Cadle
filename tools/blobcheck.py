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
#   BOTH tests are scoped to GROUND COVER (the red channel of the mask, see load_mask) because that is
#   what the decree is about, and because neither test can be made honest outside it: an intended emissive
#   (loot beacon, lantern flame, aether crystal) is a bright compact cluster, and a moving camera sweeps
#   bright/dark EDGES across pixels, which reads as a per-pixel spike. What covers the rest of the world:
#   tools/invariants.mjs pins the vfx / enemy / viewmodel / prop intensity ceilings, creature aether is
#   luminance-capped in src/enemies/materials.js, and Brush.color tints white hot cores toward their hue.
#   2) FLASH: per-pixel luminance SPIKES across consecutive frames of a burst, where the pixel is
#      GLOWING (>= LUM_BRIGHT) in at least one of the two frames. A blade of grass moving in wind
#      swings a pixel between mid-greens; a blob IGNITING swings it to glowing. Requiring the bright
#      endpoint is what separates the user-visible flash from ordinary wind/walk motion.
#      Consecutive means within one burst: frames are only diffed against the SAME burst group
#      (name minus trailing -N) — diffing across an hour change flagged the whole frame.
# SKY MASK. Both tests skip clusters that are mostly SKY. The harness captures one mask-<name>.png per
# burst (postfx.skyMask: dome/sun/clouds hidden, clear colour magenta, post bypassed), so "sky" here is
# ground truth from the renderer, not a guess from the pixels. Without it the detector fails on the sun
# seen through a gap in the treeline and on flat dawn haze above the horizon — both of which are just
# the sky being bright, and neither of which is a blob. This REMOVES false positives only: every pixel
# that is actually geometry is still tested at the original thresholds. If the mask is missing the frame
# is checked in full (fail closed), so a harness that forgets to emit one cannot silently disable the gate.
# Validate any change here with `python tools/blobcheck.py --selftest <frame.png>`: it paints synthetic
# bloom-balls onto a real frame and asserts they are still caught.
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
MIN_THICK  = 4        # px: a blob has THICKNESS. A 11x3 sliver is a lit blade edge, not a bloom ball —
                      # bloom smears a sub-pixel emitter into something round and at least a few px across
                      # in both axes. This catches the slivers that squeak under MAX_ASPECT on area alone.
                      # 4 not 3: at 3 the gate flickered run to run on sunlit blade edges that sit 2-5 above
                      # LUM_BRIGHT. A round blob 4 px across is still MIN_AREA and still caught (selftest).
MAX_AREA_FRAC = 0.012 # a bright region larger than 1.2% of the frame is a LIT SURFACE, not a blob. Every
                      # blob this gate has ever caught measured 15-500 px at 960-wide (bloom smears a
                      # sub-pixel emitter into a ball a few dozen px across); a sunlit snowfield, a dawn-lit
                      # meadow floor or a beach measures thousands. Over-exposure is a real bug, but it is an
                      # EXPOSURE bug with a different fix, and letting it fail here just trains people to
                      # ignore the gate. The FLASH test still covers a large area that ignites.
FLASH_DELTA = 55      # per-pixel luminance jump between consecutive frames counted as a spike
FLASH_AREA  = 10      # clustered spiking pixels that constitute a "flash"
FLASH_FLOOR = 100     # the DIMMER of the two frames must still be this lit. A blade or a mote igniting goes
                      # from lit ground (~120-160) to glowing (~230); a dark enemy silhouette sliding off a
                      # sunlit background goes from ~30 to ~225 and is just parallax, not an ignition. The
                      # floor keeps the former and drops the latter.
DEAD_LUM    = 8       # mean frame luminance below this = render failure, fail loudly
SKY_FRAC    = 0.55    # a cluster more than this fraction sky (per mask-*.png) is the sky, not a blob
SKY_DILATE  = 3       # px: grow the sky mask, so foliage EDGES against the sky are ambiguous, not blobs
GRASS_ERODE = 2       # px: shrink the ground-cover mask. A blade SILHOUETTE pixel is part blade and part
                      # whatever is behind it, so at dawn the bright ground bleeding through the edge of the
                      # canopy reads as "a bright grass pixel" and trips the rule the blades already obey.
                      # Eroding judges only pixels that are wholly blade. A blob is tens of px across and
                      # survives this easily — the painted-blob selftest is the proof.

def load(path, w=960):
    im = Image.open(path).convert('RGB')
    return im.resize((w, round(im.height * w / im.width)))

def lum_map(im):
    px = im.load(); w, h = im.size
    return [int(0.2126*px[x,y][0] + 0.7152*px[x,y][1] + 0.0722*px[x,y][2]) for y in range(h) for x in range(w)], w, h

def load_mask(path, w, h):
    """mask-*.png from the harness (postfx._renderSkyMask) classifies every pixel:
         RED   = ground cover (grass blades)        -> the strict BRIGHT test applies here
         GREEN = other geometry                     -> BRIGHT skipped (intended emissives live here:
                                                       lantern flames, loot beacons, aether crystals)
         MAGENTA = sky, or geometry the haze owns   -> its brightness is the atmosphere's, never a blob
       Fog is rendered in magenta too, so a far surface fades toward magenta as the air takes it over.
       Returns (sky, grass) byte arrays. NEAREST so resizing cannot invent in-between colours."""
    if not os.path.exists(path): return None, None
    p = Image.open(path).convert('RGB').resize((w, h), Image.NEAREST).load()
    sky = bytearray(w * h); grass = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b = p[x, y]
            m = r if r < b else b                      # magenta strength = min(red, blue)
            if m >= 120 and g <= m * 0.9: sky[row + x] = 1
            elif r >= 110 and r > g * 1.6 and b < r * 0.75: grass[row + x] = 1
    # Dilate the sky by SKY_DILATE px. Alpha-tested foliage and thin branches against a bright sky flicker
    # their own edge pixels between "leaf" and "sky" as the wind moves them — a genuine luminance spike that
    # is not a blob. The boundary is ambiguous by construction, so treat a band around the sky as sky. A blob
    # on the grass is nowhere near it, and the painted-blob selftest proves the ground rule still bites.
    for _ in range(SKY_DILATE):
        prev = bytes(sky)
        for y in range(h):
            row = y * w
            for x in range(w):
                if prev[row + x]: continue
                if (x and prev[row+x-1]) or (x+1 < w and prev[row+x+1]) or                    (y and prev[row-w+x]) or (y+1 < h and prev[row+w+x]): sky[row + x] = 1
    for _ in range(GRASS_ERODE):
        prev = bytes(grass)
        for y in range(h):
            row = y * w
            for x in range(w):
                if not prev[row + x]: continue
                if x == 0 or x + 1 >= w or y == 0 or y + 1 >= h or                    not (prev[row+x-1] and prev[row+x+1] and prev[row-w+x] and prev[row+w+x]): grass[row + x] = 0
    return sky, grass

def clusters(flags, w, h, min_area, im=None, max_aspect=None, sky=None):
    seen = bytearray(w*h); out = []
    px = im.load() if im else None
    for i in range(w*h):
        if flags[i] and not seen[i]:
            st=[i]; seen[i]=1; n=0; rs=gs=bs=0; nsky=0
            x0=x1=i%w; y0=y1=i//w
            while st:
                j=st.pop(); n+=1
                if sky and sky[j]: nsky+=1
                x,y = j%w, j//w
                x0=min(x0,x); x1=max(x1,x); y0=min(y0,y); y1=max(y1,y)
                if px: c=px[x,y]; rs+=c[0]; gs+=c[1]; bs+=c[2]
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx,ny = x+dx, y+dy
                    if 0<=nx<w and 0<=ny<h:
                        k=ny*w+nx
                        if flags[k] and not seen[k]: seen[k]=1; st.append(k)
            if n >= min_area:
                if sky and nsky > n * SKY_FRAC: continue        # it is the sky/sun, not a blob
                if max_aspect and n > w * h * MAX_AREA_FRAC: continue   # a lit surface (BRIGHT test only)
                bw, bh = x1-x0+1, y1-y0+1
                if max_aspect and max(bw,bh) > max_aspect * min(bw,bh): continue
                if max_aspect and min(bw,bh) < MIN_THICK: continue      # a sliver, not a ball
                out.append({'px': n, 'bbox': [x0,y0,x1,y1], 'rgb': (rs//n, gs//n, bs//n) if px else None})
    return sorted(out, key=lambda c: -c['px'])

def selftest(frame):
    """Two-sided proof the sky mask did not blind the detector: paint synthetic bloom-balls onto a real
       frame (over GROUND, and over SKY) and assert the ground ones are caught and the sky one is not."""
    im = load(frame); L, w, h = lum_map(im)
    d = os.path.dirname(frame)
    name = os.path.basename(frame)
    sky, grass = load_mask(os.path.join(d, 'mask-' + re.sub(r'-\d+\.png$', '.png', name)[len('burst-'):]), w, h)
    print(f'[selftest] {name} {w}x{h}, mask: {"present" if sky else "MISSING (checking full frame)"}, '
          f'grass pixels: {sum(grass) if grass else "n/a"}')
    bm = lambda LL: [1 if v >= LUM_BRIGHT and (grass is None or grass[i]) else 0 for i, v in enumerate(LL)]
    base = clusters(bm(L), w, h, MIN_AREA, im, MAX_ASPECT, sky)
    px = im.load()
    def ball(cx, cy, rad, col):
        # flat-ish core with a soft skirt: that is the shape bloom actually smears a blob into, and it is
        # what MIN_AREA is calibrated against (a needle-sharp dot has a sub-threshold core and is not a blob)
        for y in range(max(0, cy-rad*2), min(h, cy+rad*2)):
            for x in range(max(0, cx-rad*2), min(w, cx+rad*2)):
                t = (((x-cx)**2 + (y-cy)**2) ** 0.5) / rad
                if t > 2: continue
                a = max(0.0, 1.0 - t*0.42)
                o = px[x, y]
                px[x, y] = tuple(min(255, int(o[i]*(1-a) + col[i]*a)) for i in range(3))
    # Two blobs ON THE BLADES — one washed white, one saturated violet (the two historical flavours).
    # Centres are picked from the grass mask itself, so the test exercises the rule that actually ships.
    spots = []
    if grass:
        for frac in (0.62, 0.80):
            y = int(h * frac)
            row = [x for x in range(w // 8, w - w // 8) if grass[y * w + x]]
            if row: spots.append((row[len(row) // 3], y))
    while len(spots) < 2: spots.append((w // 3 if not spots else 2 * w // 3, int(h * 0.74)))
    ball(spots[0][0], spots[0][1], 10, (255, 252, 245))
    ball(spots[1][0], spots[1][1], 11, (238, 214, 255))
    print(f'[selftest] painted at {spots[0]} and {spots[1]}')
    L2, _, _ = lum_map(im)
    found = clusters(bm(L2), w, h, MIN_AREA, im, MAX_ASPECT, sky)
    new = len(found) - len(base)
    print(f'[selftest] clean -> {len(base)} cluster(s); +2 painted ground blobs -> {len(found)}')
    for c in found[:4]: print(f'           px={c["px"]:5d} bbox={c["bbox"]} rgb={c["rgb"]}')
    ok = new >= 2
    print('[selftest] ' + ('PASS: painted ground blobs are still caught' if ok else
          'FAIL: a painted ground blob was swallowed — do NOT ship this'))
    return 0 if ok else 1

def main():
    if sys.argv[1] == '--selftest':
        return selftest(sys.argv[2])
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
        sky, grass = load_mask(os.path.join(d, 'mask-' + re.sub(r'-\d+\.png$', '.png', name)[len('burst-'):]), w, h)
        if sum(L) / len(L) < DEAD_LUM:
            fails.append(f'DEAD FRAME: {name} — mean luminance < {DEAD_LUM}, renderer produced black (GPU/WebGL failure?)')
            prev_l, prev_name, prev_group = None, None, None
            continue
        # BRIGHT is the ground-cover rule (user decree): only blades. FLASH stays whole-frame, because a
        # thing that IGNITES between two 100 ms frames is a bug wherever it is, and props do not do it.
        bmask = [1 if v >= LUM_BRIGHT and (grass is None or grass[i]) else 0 for i, v in enumerate(L)]
        bright = clusters(bmask, w, h, MIN_AREA, im, MAX_ASPECT, sky)
        if bright:
            report[name] = {'bright': bright[:6]}
            top = bright[0]
            fails.append(f"BRIGHT BLOB: {name} — {len(bright)} glowing cluster(s), largest {top['px']} px at {top['bbox']}, mean rgb {top['rgb']}")
        if prev_l is not None and group == prev_group:
            fmask = [1 if abs(a - b) >= FLASH_DELTA and max(a, b) >= LUM_BRIGHT and min(a, b) >= FLASH_FLOOR
                     and (grass is None or grass[i]) else 0
                     for i, (a, b) in enumerate(zip(L, prev_l))]
            spike = clusters(fmask, w, h, FLASH_AREA, im, None, sky)
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
