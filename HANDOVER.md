# HANDOVER — Cadle orchestration

Read this first if you are picking this project up cold (new session, new agent, previous orchestrator ran out of usage). It tells you what the job is, how the machine is built, what state it is in, and the exact commands to carry on.

**Keep this file current.** Every loop tick / wave boundary: update "Current state" + "Next actions". It is the only thing a replacement agent gets.

---

## 1. The job (from the user, verbatim intent)

Build a browser FPS-RPG in Three.js at **Destiny 2** level for game mechanics and **Final Fantasy XIV** level for the mystical look. Utterly perfect, beautiful, responsive. Three pillars in order: **graphics, performance, game mechanics (smooth)**. Later, after fundamentals are signed off: world bosses with mechanics, quests, story mode with voiced NPCs.

Method the user asked for, which you must keep using:
- Break the game into the **smallest pieces that can be judged on their own** (orchestrator decides the pieces).
- **Fan out sub-agents**, one builder per piece, files strictly owned.
- **A separate fresh-context sub-agent critic inspects the actual running game** — never the builder's summary — and is a really harsh critic.
- Critic does a **blind side-by-side vs the real Destiny 2 / FF14**, says which is better, and when ours loses names **the single biggest gap** and sends the builder back in.
- **No fixed number of rounds.** Loop until every critic is genuinely wowed.
- Between major waves, **one fresh agent plays the whole game** and smooths everything into one coherent thing.
- Keep a **live progress page** the user can watch.
- Use `ultracode` / Workflow orchestration; the user is away, so act, never ask.

Standing constraints (also in `CLAUDE.md`): everything procedural (no asset downloads/CDN/fetch), one owner per file, perf budget, determinism via `core/Noise.js`, `?auto=1` automation must keep working.

---

## 2. Machine (how work actually gets done)

| Thing | Path | What it is |
|---|---|---|
| Game | `src/**` | Vite 8 + three r185 + `postprocessing` 6.39, plain ES modules |
| Contracts + rules | `CLAUDE.md` | architecture, ownership table, conventions, perf budget, world layout, `window.__game` API |
| Builder protocol | `tools/BUILDER.md` | what a builder sub-agent must do |
| Critic protocol | `tools/CRITIC.md` | how a critic inspects + the JSON verdict schema |
| Harness | `tools/inspect.mjs` | Playwright headless Chromium **with the real GPU**, drives the game, saves shots + perf + errors |
| Syntax gate | `tools/check.mjs` | `node --check` every src file + resolve relative imports (run before every harness run) |
| Contact sheet | `tools/sheet.py` | `python tools/sheet.py tools/out/<dir> 3 640` → `sheet.png` to Read |
| Progress page | `progress/state.json` + `tools/progress.mjs` → `progress.html` | live status page, served by Vite |
| Wave workflows | `tools/workflows/*.js` | Workflow scripts (fan-out + critic loop) |

### Dev server (keep it up)
Always runs at `http://127.0.0.1:5173/`. Check: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/`.
Restart if down:
```bash
npx vite --port 5173 --strictPort --host 127.0.0.1 > tools/out/vite.log 2>&1 &
```
The orchestrator also keeps the game open in the Browser pane so it can see it live:
`preview_start {name:"cadle"}` (config in `.claude/launch.json`, attaches, starts nothing), then `navigate` to `http://127.0.0.1:5173/?auto=1&debug=1`, then `computer{action:"screenshot"}` / `read_console_messages` / `javascript_tool`. **The pane must be visible in the app for screenshots to work** — if it returns "Browser pane is not displayed", fall back to `tools/inspect.mjs` screenshots (headless, always works).

### Harness usage
```bash
node tools/inspect.mjs --name tour-w2                      # default tour (24 shots, perf windows)
node tools/inspect.mjs --nolock --name x --steps '[{"wait":5},{"shot":"a"}]'
node tools/inspect.mjs --name x --script file.json --q low --w 1920 --h 1080
```
- Step language is documented in the header of `tools/inspect.mjs`.
- `--nolock` for quick screenshot iteration; **omit it for perf numbers** (mkdir-mutex serialises runs so parallel agents don't skew each other).
- Perf: wait ≥ 5 s after load before a `perfWindow` (shader warmup). `stats().gpuMs` = true GPU ms (timer queries), `stats().systems` = per-system CPU ms EMA.
- GPU flags that make headless use the RTX 3060: `--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu` (already in the harness). Without them you silently get SwiftShader and useless numbers.

---

## 3. How a wave is run (the pattern to repeat)

One Workflow call fans out one agent per piece; each piece runs `critic → (fix builder → critic)*` until `verdict: "WIN"` or the round cap, all pieces in parallel via `pipeline()`.

- Script lives in `tools/workflows/<wave>.js`, launched with `Workflow({scriptPath: "C:\\Users\\ianca\\Desktop\\FPS3\\tools\\workflows\\<wave>.js"})`.
- **Strip CRLF from the script** (`python -c "s=open(p,newline='').read().replace('\r','')"`) or the permission layer rejects it ("control characters").
- Builders get `COMMON` + a per-piece `brief` + the files they own + the critic JSON from the previous round. Critics get `tools/CRITIC.md` + the same brief and return the verdict JSON (schema in the script).
- Round cap per wave is a knob (`MAX_FIX_ROUNDS`); pieces that come back `LOSE`/`TOSSUP` go into the next wave. There is no global round limit — keep launching waves until every piece is `WIN`.
- **Usage-limit recovery pattern (this happens every wave — the monthly/session limit kills the run ~90 min in):** if critics returned but fix builders died, the next wave goes **fix-first**: embed each piece's full stored verdict JSON as `PREJUDGED` in the script and start with the builder, then a fresh critic (see `tools/workflows/wave4.js` + its generator `scratchpad/wave4-gen.py` pattern). Never re-run critics whose verdicts are already in the journal.
- Watch progress: `/workflows`, or read `~/.claude/projects/C--Users-ianca-Desktop-FPS3/<session>/subagents/workflows/<runId>/journal.jsonl` (one `{"type":"result"}` line per finished agent — the critic JSON is in there even if the workflow itself dies).
- If a wave dies mid-way (usage limit, crash): the source files on disk keep whatever the builders wrote. Do **not** resume blindly — relaunch a critic-first wave (like `tools/workflows/wave1.js` does) so already-built pieces get judged instead of rebuilt.

### Between waves (required by the user)
1. **Integrate**: wire any new system hooks into `window.__game` (`src/main.js`), run `node tools/check.mjs`, run the full tour, fix cross-system breakage.
2. **Coherence agent**: one fresh agent plays the whole game end to end and smooths inconsistencies into one coherent thing — including STYLE coherence: generated assets (ASSETS.md) and procedural art must read as one painterly-realistic look (palette rules in CLAUDE.md style section).
3. Update `progress/state.json` → `node tools/progress.mjs`.
4. Launch the next wave.

---

## 3b. Asset pipeline (NEW 2026-08-20 — user bought Magnific MCP; "no excuse" mandate for AAA look)

- **Magnific MCP** connected (tools `mcp__df0d6b46-...__*`): images_generate (seedream-5-pro default, 100 cr/2k image), audio_sfx_generate (ElevenLabs, ~10-40 cr), audio_music_generate (elevenlabs-music-generation-v2, ~20 cr/s — pricey, use sparingly), models3d_generate (image→GLB, tripo-v31 detailed ≈ 1160 cr), images_remove_background, images_upscale. Check `account_balance` before big batches; started with 45k credits. Flow: generate → `creations_wait` → curl the `url` into `public/assets/...` (tokens expire — download IMMEDIATELY) → update `ASSETS.md`.
- **ToS gotcha**: naming trademarked games ("Final Fantasy XIV") in music prompts = rejection; describe the style instead.
- **`ASSETS.md`** = manifest builders read (paths, usage notes, ASSET ASK protocol). Landed: 10 textures (6 terrain/stone albedos + bark + alpha leaf card + 2 glyph rings, tiling verified), 28 SFX takes, field + night themes, 3 GLBs (handcannon 57k / aetheryte 38k / column 31k tris — decimated from 380k with gltf-transform simplify+quantize; sharp/vips texture-resize is broken on this machine, geometry decimation is what matters). Total payload ~24 MB.
- **`src/core/Assets.js` (orchestrator-owned) preloads everything** as the FIRST system init: parallel fetch, GPU texture pre-upload (`renderer.initTexture`), progress events `assets:progress` for the HUD load bar, null-safe accessors (`game.assets.tex/model/audioBuffer`), measured 2.6 s under full wave load (43/43 assets, 0 errors). Builders must NOT load asset files directly — CLAUDE.md forbids it; keeps one copy + zero mid-game streaming hitches. Prod perf rules (tri/texture/payload budgets, preload-only, style-coherence palette) are now a CLAUDE.md conventions block.
- **`TECHNIQUES.md`** = ranked license-verified open-source three.js techniques from X/GitHub research (N8AO CC0, SimonDev Quick_Grass MIT, three-good-godrays zlib, hex-tiling MIT, octahedral impostors MIT, volumetric clouds MIT, takram atmosphere reference...). Builders follow its STEAL guidance.
- CLAUDE.md conventions updated: generated assets allowed (local-only at runtime, committed to repo, no CDN/external fetch from game code).

## 4. Current state

**Updated: 2026-08-20 (blob/pointer-lock fix + guardrail hardening PR).**

- **Fifth blob recurrence fixed at the source (fresh clone was visibly broken; gate failed).** Live causes found by bisection + gate screenshots: (1) three r185 gives GLSL3 `ShaderMaterial`s NO `gl_FragColor` alias — both cloud shaders in Sky.js failed to compile (console shader errors, no clouds; this was also the q=high frozen-jitter breach — after the fix, frozen diff is ~0.8 vs the 2.0 limit, all remaining variation is film grain); (2) the vfx `trail` preset wisps drag across the meadow 24/7 was WHITE at hdr 2.5 → drifting white/purple flashing streaks; (3) viewmodel `white` sight emissive 2.2 + glossy gold/brass (roughness 0.22-0.3, envMap 1.6) → permanent white/warm glints in every frame; (4) lantern flames emissive 4.0 → sub-pixel warm blobs; (5) sunlit grass silvering × translucency could cross the 1.05 day bloom threshold field-wide. Fixes: Sky GLSL3 `out` vars; trail saturated + hdr 1.1; sights 0.9 / metals roughness ≥ 0.35; flames 1.4; and the structural one — **`GRASS_LUM_CAP` in Grass.js: the final outgoing luminance of grass is hue-preserving-capped at 0.60**, closing every current and future term at once (see CLAUDE.md architectural law).
- **Guardrails now enforce themselves**: `tools/invariants.mjs` extended (pointer-lock hookup + synthetic guard, grass cap, vfx/enemy/viewmodel/prop ceilings, bloom/exposure pins — every rule injection-tested to fail when its bug is reintroduced), CI runs it + `check.mjs` on every push/PR (`.github/workflows/checks.yml`), and `.claude/settings.json` runs it as a Stop hook after every agent turn. `tools/blobcheck.py` fixed: no more diffing across burst/hour boundaries, FLASH requires the spiking pixel to reach glowing (wind motion no longer false-positives), thin horizon/water strips are not "blobs" (compactness), dead-black frames fail loudly. `tools/gate-steps.json` gained a dawn burst (threshold mid-lerp, backlit — worst case).

*(previous state below)*

- **Wave 1**: builders landed ~9.1k lines across 15 systems; usage limit killed the critics.
- **Wave 1b** (`wf_6614cf46-d1b`, dead): critic-first on 16 pieces. **All 15 critics returned verdicts** (journal: `.claude/projects/.../3bf2ab25-.../subagents/workflows/wf_6614cf46-d1b/journal.jsonl`): **12 LOSE / 3 TOSSUP / 0 WIN** (movement 8.2, combat 7.5, lighting 6.5 TOSSUP; terrain/water/enemies 4.5 worst). The 16 fix builders launched, then the **usage limit killed 14 of them mid-flight**; only camera (full recoil/bob/flinch fix pass) and HUD (built fresh, never judged) completed. Files on disk may contain partial fix-round edits — `check.mjs` passes, game boots clean.
- **Wave 2** (`wf_022db421-f2d`, dead — usage limit killed 27/40 agents): 13 critics returned — combat 5.5, lighting 6, water 6, vegetation 6, abilities 4.5, grass 7 TOSSUP, vfx 5, enemies 4, camera 7 TOSSUP, terrain 4.5, audio 6, movement 8.2 TOSSUP; sky critic returned empty (no StructuredOutput), postfx/weapons/hud critics killed. Several fix builders completed mid-wave (grass clipmap rewrite, enemies standoff defs, weapons hands.js, TAAPass) — judged fresh in wave 3.
- **Wave 3** (`wf_e7ac807f-e3c`, dead at 13/42 — usage limit again): 13 fresh verdicts, **scores climbing every wave** (avg ~5.2 → ~6.5): combat 8 (occlusion fixed), movement 8.3, camera 8, grass 7.3, water 7.2 (all TOSSUP — one gap from WIN each); terrain 5.5 (textures landed, shape still soft-serve), enemies 6 (standoff landed but overtuned — no melee pressure), vegetation 5.5, weapons 6 (hands exist, reloads frozen), vfx 6, audio 6 (mp3 takes STILL unwired — builder killed), postfx 6 (god-ray stipple, AO halos), sky 4 (REGRESSED — cloud rewrite = conical spike fence; night package praised). lighting/abilities/hud critics died.
- **Wave 4** (`wf_cd5c7899-156`) — **died with 0/29 agents completed** (Fable 5 model limit hit immediately). No fixes landed; nothing lost. The session model was then switched to Opus 5.
- **Wave 5 — running now** (`tools/workflows/wave5.js`, run id `wf_c90dc398-1cd`, task `w9vimwmui`): same fix-first design as wave 4 (stored wave-3 verdicts embedded as `PREJUDGED`), plus: every builder must pass `node tools/gate.mjs` before reporting done, every critic runs the gate and cannot award WIN if it fails, the postfx brief carries the verified TAA non-convergence diagnosis, and the grass brief carries the q=low blob report.
- **GitHub backup live**: `https://github.com/Humpalumps/FPS-RPG` (branch `main`). Revert points: `v0.1.0-stable` (baseline), **`v0.1.1-stable` (baseline + regression gate + pointer-lock fix — use this one)**. Commit between waves; git is orchestrator-only (CLAUDE.md forbids agents from touching it).
- *(previous)* Wave 4 design notes: **fix-first** — the 13 judged pieces start at their builder with the full stored wave-3 verdict (`PREJUDGED` map embedded in the script), then a fresh critic; lighting/abilities/hud go critic-first. Briefs carry targeted direction (sky: rounded fbm masses + blue-noise jitter per TECHNIQUES.md #8, never cone extrusion; enemies: tighten hound band for real melee pressure; audio: wiring the mp3 takes is mandatory; vegetation: use leaf_card/bark/column/aetheryte assets).
- Orchestrator fixes landed earlier: Player.js pre-shield damage event; grass tip roughness decree; wisp glow/meadow decree (see §5b + CLAUDE.md decree block).
- Game state at last verify: 0 errors, blob-free meadow at 15h/17.5h. p99 was 16.4 ms vs 14 budget; builders carry perf gates.
- Not started (later waves): RPG stats/loot/inventory, quests + voiced NPCs (Magnific audio_tts can voice them now), world bosses, story mode.

## 5. Next actions (in order)

1. Wait for `wf_e7ac807f-e3c` (journal: `.claude/projects/.../d286c103-.../subagents/workflows/wf_e7ac807f-e3c/journal.jsonl`). If it dies (usage limit ~4-hourly): collect verdicts from the journal, fold them into prevs, relaunch critic-first as wave 4 — never resume blindly.
2. Asset batch 2 in flight (bark, leaf card ×alpha, rune glyphs ×2, aetheryte/column/handcannon concepts → models3d GLBs). Download results IMMEDIATELY (URL tokens expire), update ASSETS.md, generate remaining ASSET ASKs from builder reports.
3. Between waves: update progress/state.json + shots, run check.mjs + full tour, coherence agent, then next wave.
4. Only once graphics/perf/mechanics are all WIN: RPG systems → world bosses → quests/NPC voice (audio_tts) → story mode.

## 5b. User decrees (2026-08-20, from watching the live game — enforce in every wave, tell every builder/critic)

- **No sparkly white blobs in the meadow, ever.** (Also pinned as a USER DECREE at the top of CLAUDE.md — critics must auto-LOSE any piece whose screenshots show washed-white blobs.) Diagnosed live, three stacked causes: (a) wisp glow parts white-clipping through ACES + 3 spawn wisps perma-aggroing the idle player (bolt trail/impact vfx rain), (b) grass flower-head emissive, and (c) **the persistent one: grass glossy tips** — `roughnessFactor mix(0.78, 0.35, v²)` threw drifting, gust-flashing white specular glints across the whole meadow (immune to every object toggle; confirmed by hiding the grass material — the user spotted it first). Fixes landed by orchestrator (keep, refine, never revert): tip roughness → `mix(0.82, 0.62, v²)` (Grass.js — survived the grass builder's clipmap rewrite), flowers matte (Grass.js), wisp `glow` 2.6→1.1 / `rim` 1.0→0.6 (defs.js), meadow camp → 2 wisps @48-64 m (Enemies.js). Verified clean at hour 15 + 17.5 from spawn after the rewrite. Watch every grass builder round for regressions — the wave-2 grass critic explicitly asked for MORE backlight sheen (gap 1), which is how this reappears.
- Grass sparkles in general are out: no glowing/emissive flower heads by day; night magic = subtle colored lift, not bright points.

## 5c. Regression gate + the jitter/blob/pointer-lock decrees (2026-08-20)

`node tools/gate.mjs` (orchestrator-owned; CLAUDE.md makes it mandatory for builders, and any failure = automatic LOSE for critics). It runs the blob+jitter screenshot suite at **both q=high and q=low** (blobs have shipped at low while high looked clean) plus a real pointer-lock session:
1. **White blobs** — `tools/gate.py` finds connected clusters of near-white pixels (min channel ≥ 232) on meadow shots at 13/15/17.5 h, both with enemies present and cleared. Colored glows pass; washed-white ones fail.
2. **Jitter** — the ONLY valid measurement is with **`game.paused = true`** (world frozen, rendering still running). A static-camera diff is useless: wind/clouds/water make q=low and q=high look equally "jittery" (~5-9). Frozen, the signal is clean: q=low sits flat at ~1.15 (film grain only) while q=high drifted 1.17 → 3.21 and kept climbing. **Diagnosis: the TAA pass is not converging at q=high** (PostFX.js, postfx builder's file — do not let another agent "fix" it elsewhere). It is INTERMITTENT: a later gate run measured 1.5-1.7 with no ramp, so a single passing run does not clear it. The gate fails on either an absolute breach (> 2.0) or a ramping trend.
3. **Pointer lock** — real click-to-start session (no `auto=1`): lock must engage on click AND re-acquire after `exitPointerLock` + click. `Input.lock(canvas)` (static, in `src/core/Input.js`) is now the ONE lock path — it catches `unadjustedMovement` rejection (some mice/drivers reject the promise, which is how the mouse kept escaping) and retries after Chrome's ~1.3 s relock cooldown. HUD start/resume calls it too.

Gotcha found while building it: `PostFX.update()` re-applies `enabled` from `this.q.*` every frame, so runtime `pass.enabled = false` toggles are silently reverted — bisect via `postfx.q.taa/ao/godrays` instead.

## 5d. Why the blob / mouse bugs kept coming back — and the mechanism that stops them (2026-08-20)

**Root cause was structural, not a bad tune.** Each recurrence had a DIFFERENT source (flower-head emissive -> wisp glow -> grass tip specular -> grass rim emissive), because two forces kept regenerating it:
1. *The critic loop rewards glow.* Critics legitimately ask for "backlit sheen", "low-sun rim", "readable flowers", "the field goes black at golden hour". Builders satisfy that the easy way: add emissive. On sub-pixel geometry that is the bug.
2. *Prose rules are followed literally.* A decree naming flowers and roughness did not stop a builder adding a brand-new emissive rim path.

**The physics:** a blade is smaller than a pixel at distance, so any value that can reach the bloom threshold (~1.2) flickers on/off as wind and camera move; bloom smears each flicker into a floating ball. A RELATIVE clamp (`min(x, col*0.75)`) does not fix it - a bright blade colour raises the ceiling too. Hence an ABSOLUTE ceiling.

**Mechanism now in place (three layers, in order of strength):**
- `node tools/invariants.mjs` - source greps, ~1 s, no server: single pointer-lock path (`Input.lock`), grass absolute emissive ceiling <= 0.25, grass tip roughness >= 0.6. **Verified by injecting both regressions: it catches them with the exact reason, and passes when restored.** This is the layer that survives contention and busy waves.
- `tools/blobcheck.py` - blob detection rewritten: ANY hue (the old test was near-white only, so blue aether blobs walked through) and TEMPORAL flash detection across bursts (the old test used single shots, so flashing blobs appeared between frames). Gate now captures 8-frame bursts at 13/15/17.5/23 h, standing and walking, enemies present and cleared.
- CLAUDE.md **architectural law**: ground cover is never emissive; rim/backlight goes in `reflectedLight.directDiffuse` (respects exposure, cannot bloom). Critics are told that asking for more glow on ground cover is asking for the bug back.

Same shape for pointer lock: the fix decayed whenever a builder wrote their own `requestPointerLock` (which can REJECT with `unadjustedMovement`, and which Chrome blocks for ~1.3 s after an exit). Now there is one path, and the invariant check fails the build if anything else calls it.

## 6. Gotchas learned the hard way

- **Bash heredocs > ~5 KB fail on this machine** (`unexpected EOF`). Use the Write tool for anything long; heredocs only for short files.
- `renderer.info` must be reset per frame (`autoReset = false` + `info.reset()` in `Perf.begin`) or draw-call/tri counts are garbage.
- postprocessing's `EffectComposer.addPass(pass, index)` is the supported way to insert the viewmodel overlay passes; splicing `composer.passes` skips initialisation.
- Critics/builders must **look at the PNGs**, not just read the report — a build can be error-free and still look like programmer art.
- Never let two agents own the same file. Cross-system needs go in the report as an ask; the orchestrator wires them.
