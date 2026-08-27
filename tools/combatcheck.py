# combatcheck.py <dir> [prefix] — the COMBAT-VFX white-out detector. Exit 0 = clean, 1 = white-out, 2 = inconclusive.
#
# WHY THIS EXISTS (2026-08-27). Wave 5 shipped with five regions where fighting the region's own
# bestiary blew the screen to white — wyvern breath tone-mapping to cream-white over the whole frame,
# a wisp bolt impact landing as a hard white core (rgb 229,238,233), 437 stacked additive particles
# washing the void out with the player never firing, infernal going near-solid white in 0.5 s, a hit
# golem showing an opaque near-white egg over its chest crystal. `tools/gate.mjs` PASSED throughout,
# because blobcheck.py is deliberately scoped to GROUND COVER in a scripted meadow burst — a
# full-screen combat wash is simply outside what it looks at. This file closes that hole. It judges
# the bursts captured by tools/scripts/combat-blob-steps.json: each region's own bestiary spawned at
# 8-18 m, aggroed, player firing NOTHING, a burst where every enemy takes a hit (flash path), and a
# late "sustain" burst so slow volleys (void: windup 0.7 + cd 2.2 + 4.5 s flight) detonate at the
# lens inside the capture window.
#
# WHAT "WHITE-OUT" MEANS HERE, mechanically (user decree: any emissive/additive element that
# tone-maps to WHITE instead of its hue is a bug — saturate the colour, cap the intensity):
# a pixel is WASHED when it is both very bright AND desaturated. A healthy magic hue survives tone
# mapping (violet aether, orange fire, teal frost all keep max-min channel spread); a stacked or
# uncapped value clips all three channels toward 255 and the spread collapses. So the detector keys
# on brightness + LOW channel spread, which is what separates "vivid fire breath" (allowed, wanted)
# from "cream-white frame" (the bug). Three independent tests:
#   1) WASH: fraction of NON-SKY pixels that are washed, per frame. Combat may flash, glow and fill
#      the screen with colour — but if >WASH_FRAC of the visible world is near-white at once, the
#      frame has clipped. Catches dragon/infernal ("near-solid within 0.5 s").
#   2) CORE: compact clusters of washed pixels with real local contrast — the hard white egg / bolt
#      core case. Same cluster machinery as blobcheck (shape + local-contrast rules), but scoped to
#      ALL non-sky pixels, not just ground cover, because in combat the offender sits on an enemy or
#      in the air, and it must NOT be desaturated-white regardless of where it is. Saturated glows of
#      any brightness pass this test by construction — the channel-spread rule is the whole point.
#   3) CATASTROPHE: whole-frame washed fraction (mask ignored) above WASH_FULL_FRAC. Belt and braces
#      for fog-heavy regions (void: fogMul 5.0) where the sky mask legitimately owns most of the
#      frame — a viewport that is half near-white is broken no matter which mask channel owns it.
# SKY MASK: tests 1-2 use mask-*.png (magenta = sky/fog) exactly as blobcheck does, so noon clouds
# and bright haze can never fail the gate; a frame with no mask is INCONCLUSIVE (exit 2), fail-closed
# on the harness rather than the game, same policy as blobcheck.
# CALIBRATED 2026-08-27 against tools/out/cvfx-cal (q=high, hour 13, wave-5 build, all ten regions):
# the detector reproduced the wave-5 critics' findings and found the same bug in three regions they
# under-sampled — measured per-region peak washFrac: forest 0.000 (the one genuinely clean region),
# vale 0.024 with WHITE CORE clusters at mean rgb (225,238,233) — the critic's own sampled value —
# tundra 0.31, shadowfen 0.55, sunken 0.63, celestial 0.83, dragon 0.84, infernal 0.76, lost 0.75.
# Verified by eye: celestial-hit-0 (82.5%) is a solid cream frame; tundra-hit-2 is a cream sheet
# swallowing an icegiant. The bars sit far under the failures and far over the clean region's peak.
# Always emits combatcheck.json with per-frame metrics so the next calibration is a read, not a
# guess. Thresholds are orchestrator-owned: never widen one to turn a red build green. Validate any
# change with `python tools/combatcheck.py --selftest <a clean burst frame>`: it paints a synthetic
# white wash and a white core onto the frame and asserts both are still caught.
import sys, os, glob, json
import numpy as np
from PIL import Image
from blobcheck import mask_path_for, clusters, local_contrast, DEAD_LUM, SKY_DILATE

WASH_LUM  = 232   # luminance 0..255 counted as "washed" when the pixel is also desaturated. Above
                  # every legitimate lit surface in the calibration capture (forest combat peaked at
                  # 0.000% washed; sunlit snow/marble as scene surfaces did not register) and below
                  # the measured washes (celestial core mean 247, dragon 247, lost egg-class 236).
WASH_SAT  = 46    # max(r,g,b)-min(r,g,b) at or below this = desaturated. The measured offenders sit
                  # at 9-26 spread; healthy fire/aether/frost VFX keep 60+. 46 leaves real hues room.
WASH_FRAC = 0.055 # fraction of NON-SKY pixels washed in one frame that constitutes a wash. The clean
                  # region peaks at 0.000; the washed regions peak at 0.31-0.84. Vale's bolt-impact
                  # failure mode lives below this bar and is caught by CORE instead.
WASH_FULL_FRAC = 0.40  # whole-frame washed fraction (mask ignored) that is catastrophic regardless
                  # of what the mask owns. Calibration: celestial/dragon/lost measured 0.66-0.83
                  # full-frame; no clean frame exceeded 0.02.
CORE_LUM  = 226   # cluster test uses a slightly lower brightness bar than WASH_LUM: a hard core's
                  # skirt averages down, and the measured vale clusters (mean 225-229) need the
                  # cluster MEAN under the bar to still flag from their 232+ centres.
CORE_SAT  = 36    # tighter spread for the cluster test: a core is the CLIPPED CENTRE of an effect
                  # (measured spread 9-15); 36 keeps warm ambient glass out.
CORE_AREA = 40    # px at 960-wide: the vale bolt cores measured 44-11367 px; below 40 is a spark,
                  # and sparks are judged by WASH if they multiply.
CORE_ASPECT = 5   # a washed strip longer than 5:1 is a lit edge/waterline, not a core.
CORE_CONTRAST = 18  # must stand out from its surround (blobcheck's local_contrast machinery); a
                  # uniformly pale surface is an exposure question, not a core.
CORE_SKIP_PX = 60000  # when a frame ALREADY failed WASH/CATASTROPHE and carries more core-candidate
                  # pixels than this at 960-wide, skip the (python BFS) clustering pass — it would
                  # take seconds per frame to restate a finding the wash tests already made. A frame
                  # that has NOT failed is always clustered, whatever the count.

def np_load(path, w=960):
    im = Image.open(path).convert('RGB')
    im = im.resize((w, round(im.height * w / im.width)))
    return np.asarray(im, dtype=np.int16)

def np_lum(a):
    return (a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722)

def np_sky(path, w, h):
    """Sky/fog classification from mask-*.png, same rule + dilation as blobcheck.load_mask."""
    if not os.path.exists(path): return None
    m = np.asarray(Image.open(path).convert('RGB').resize((w, h), Image.NEAREST), dtype=np.int16)
    r, g, b = m[..., 0], m[..., 1], m[..., 2]
    mag = np.minimum(r, b)
    sky = (mag >= 120) & (g <= mag * 0.9)
    for _ in range(SKY_DILATE):
        s = sky.copy()
        s[1:, :] |= sky[:-1, :]; s[:-1, :] |= sky[1:, :]
        s[:, 1:] |= sky[:, :-1]; s[:, :-1] |= sky[:, 1:]
        sky = s
    return sky

def frame_metrics(a, L, sky):
    """(washFrac over non-sky, fullFrac over whole frame, core-candidate bool grid)."""
    sat = a.max(axis=2) - a.min(axis=2)
    washed = (L >= WASH_LUM) & (sat <= WASH_SAT)
    core = (L >= CORE_LUM) & (sat <= CORE_SAT)
    if sky is not None:
        nonsky = ~sky
        washed_ns = int((washed & nonsky).sum()); ns = max(1, int(nonsky.sum()))
        core &= nonsky
    else:
        washed_ns = int(washed.sum()); ns = washed.size
    return washed_ns / ns, int(washed.sum()) / washed.size, core

def find_cores(a, L, core, w, h, sky, already_failed=False):
    n = int(core.sum())
    if n < CORE_AREA or (already_failed and n > CORE_SKIP_PX): return []
    flags = bytearray(core.reshape(-1).astype(np.uint8).tobytes())
    Lf = L.reshape(-1)
    im = Image.fromarray(a.astype(np.uint8))
    skyb = bytearray(sky.reshape(-1).astype(np.uint8).tobytes()) if sky is not None else None
    out = []
    for c in clusters(flags, w, h, CORE_AREA, im, None, skyb):
        x0, y0, x1, y1 = c['bbox']
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        if max(bw, bh) > CORE_ASPECT * min(bw, bh): continue
        if local_contrast(Lf, w, h, c['bbox']) < CORE_CONTRAST: continue
        out.append(c)
    return out

def check(d, prefix='burst-cvfx-'):
    files = sorted(glob.glob(os.path.join(d, f'{prefix}*.png')))
    if not files:
        print(f'COMBATCHECK: no frames matched {prefix}*.png in {d}'); return 1
    unmasked = [os.path.basename(f) for f in files if not os.path.exists(mask_path_for(d, os.path.basename(f)))]
    if unmasked:
        print('COMBATCHECK INCONCLUSIVE (harness, not the game)')
        print(f' - {len(unmasked)} of {len(files)} frame(s) have no mask-*.png; the capture was cut short.')
        json.dump({'inconclusive': unmasked}, open(os.path.join(d, 'combatcheck.json'), 'w'), indent=1)
        return 2
    fails, report = [], {}
    for f in files:
        name = os.path.basename(f)
        a = np_load(f); h, w = a.shape[:2]
        L = np_lum(a)
        sky = np_sky(mask_path_for(d, name), w, h)
        if float(L.mean()) < DEAD_LUM:
            fails.append(f'DEAD FRAME: {name} — renderer produced black'); continue
        frac, full, core = frame_metrics(a, L, sky)
        cores = find_cores(a, L, core, w, h, sky, already_failed=(frac >= WASH_FRAC or full >= WASH_FULL_FRAC))
        report[name] = {'washFrac': round(frac, 4), 'fullFrac': round(full, 4),
                        'cores': [{'px': c['px'], 'bbox': c['bbox'], 'rgb': c['rgb']} for c in cores[:4]]}
        if frac >= WASH_FRAC:
            fails.append(f'WASH: {name} — {frac:.1%} of the visible world is near-white desaturated (bar {WASH_FRAC:.1%})')
        if full >= WASH_FULL_FRAC:
            fails.append(f'CATASTROPHE: {name} — {full:.1%} of the ENTIRE frame is near-white (bar {WASH_FULL_FRAC:.0%})')
        if cores:
            top = cores[0]
            fails.append(f"WHITE CORE: {name} — {len(cores)} clipped cluster(s), largest {top['px']} px at {top['bbox']}, mean rgb {top['rgb']}")
    json.dump(report, open(os.path.join(d, 'combatcheck.json'), 'w'), indent=1)
    if fails:
        print(f'COMBATCHECK FAIL — {len(fails)} finding(s) across {len(files)} frames:')
        for x in fails[:24]: print(' - ' + x)
        if len(fails) > 24: print(f' - ... and {len(fails) - 24} more (see combatcheck.json)')
        return 1
    peak = max((r['washFrac'] for r in report.values()), default=0)
    print(f'COMBATCHECK OK — {len(files)} frames clean (peak washFrac {peak:.1%}, bar {WASH_FRAC:.1%})')
    return 0

def selftest(frame):
    """Paint (a) a translucent near-white wash over ~20% of the frame and (b) a hard white core onto
       a clean frame; assert the clean frame passes and both injections are caught."""
    d, name = os.path.dirname(frame), os.path.basename(frame)
    a = np_load(frame); h, w = a.shape[:2]
    L = np_lum(a)
    sky = np_sky(mask_path_for(d, name), w, h)
    if sky is None:
        print('[selftest] SKIP: frame has no mask; pick a burst frame with its mask-*.png present'); return 0
    frac0, full0, core0 = frame_metrics(a, L, sky)
    cores0 = find_cores(a, L, core0, w, h, sky)
    print(f'[selftest] clean frame: washFrac {frac0:.2%} (bar {WASH_FRAC:.1%}), cores {len(cores0)}')
    if frac0 >= WASH_FRAC:
        print('[selftest] FAIL: the chosen frame is already washed — pick a clean one'); return 1
    # (a) wash: blend the NON-SKY pixels of the lower-middle band toward warm white, the way a
    # stacked additive effect actually clips: bright, desaturated, a ghost of the scene surviving.
    # Painting only where the mask says "world" matters: in a fog-heavy frame the ground is
    # fog-owned (magenta) and a naive rectangle lands on pixels the WASH test rightly ignores —
    # the selftest would then be measuring the frame, not the detector (same lesson as blobcheck's
    # dense-patch rule).
    y0, y1 = int(h * 0.50), int(h * 0.95); x0, x1 = int(w * 0.10), int(w * 0.90)
    nonsky = ~sky
    band_sel = np.zeros((h, w), dtype=bool); band_sel[y0:y1, x0:x1] = True; band_sel &= nonsky
    need = int(nonsky.sum() * (WASH_FRAC * 2.2))
    if int(band_sel.sum()) < max(need, 4000):
        print(f'[selftest] SKIP: only {int(band_sel.sum())} non-sky pixels in the paint band '
              f'(need {max(need, 4000)}); this frame is mostly sky/fog — pick one with visible ground.')
        return 0
    a2 = a.copy()
    sel = band_sel[..., None]
    a2 = np.where(sel, np.minimum(255, a.astype(np.float64) * 0.06 + np.array([252, 249, 242]) * 0.94), a2).astype(np.int16)
    # (b) core: a hard-edged egg at the measured golem-egg value rgb(236,232,221), centred on the
    # densest non-sky neighbourhood of the upper half so it cannot straddle masked pixels.
    rad = 9; R = rad * 3
    density = nonsky[:h // 2].astype(np.float32)
    csum = density.cumsum(axis=0).cumsum(axis=1)
    best, cx, cy = -1, w // 2, h // 4
    for yy in range(R, h // 2 - R, 8):
        for xx in range(R, w - R, 8):
            s = csum[yy + R - 1, xx + R - 1] - csum[yy - R, xx + R - 1] - csum[yy + R - 1, xx - R] + csum[yy - R, xx - R]
            if s > best: best, cx, cy = s, xx, yy
    yy, xx = np.mgrid[cy - rad * 2:cy + rad * 2, cx - rad * 2:cx + rad * 2]
    t = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / rad
    alpha = np.clip(np.where(t <= 1.0, 1.0, 1.0 - (t - 1.0) * 1.4), 0, 1)[..., None]
    patch = a2[cy - rad * 2:cy + rad * 2, cx - rad * 2:cx + rad * 2].astype(np.float64)
    a2[cy - rad * 2:cy + rad * 2, cx - rad * 2:cx + rad * 2] = \
        np.minimum(255, patch * (1 - alpha) + np.array([236, 232, 221]) * alpha).astype(np.int16)
    L2 = np_lum(a2)
    frac2, full2, core2 = frame_metrics(a2, L2, sky)
    cores2 = find_cores(a2, L2, core2, w, h, sky)
    wash_ok = frac2 >= WASH_FRAC
    core_ok = len(cores2) > len(cores0) or any(
        abs((c['bbox'][0] + c['bbox'][2]) // 2 - cx) < rad * 3 and abs((c['bbox'][1] + c['bbox'][3]) // 2 - cy) < rad * 3
        for c in cores2)
    print(f'[selftest] painted: washFrac {frac2:.2%} (must be >= {WASH_FRAC:.1%}: {"PASS" if wash_ok else "FAIL"}), '
          f'cores {len(cores0)} -> {len(cores2)} ({"PASS" if core_ok else "FAIL"})')
    ok = wash_ok and core_ok
    print('[selftest] ' + ('PASS: synthetic wash and core are both caught' if ok
          else 'FAIL: an injected white-out was swallowed — do NOT ship this'))
    return 0 if ok else 1

def main():
    if sys.argv[1] == '--selftest':
        return selftest(sys.argv[2])
    return check(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'burst-cvfx-')

if __name__ == '__main__':
    sys.exit(main())
