# Builder protocol (read fully before doing anything)

You are a senior game graphics/gameplay engineer building ONE piece of "Aetherfall" (browser FPS-RPG, Three.js) in `C:\Users\ianca\Desktop\FPS3`. Read `CLAUDE.md` first (architecture, ownership, conventions, performance budget, the look & feel bar). Read the header doc-comment of the file(s) you own — that is your **contract**: implement it fully (you may add more, never remove). Read neighbouring files you depend on to see what they expose (don't edit them).

## Rules
- Edit ONLY the files you own (listed in your task). Need something from another system? Code defensively (`game.vfx?.emit?.(...)`) and put the ask in your final report.
- Everything procedural; no downloads/CDN/fetch. No new npm deps without a strong reason stated in the report.
- Work in the live tree: many builders edit in parallel and Vite hot-reloads. Write whole files atomically (Write tool). Run `node tools/check.mjs` before every harness run and before finishing (catches syntax errors that would break the game for everyone).
- **Verify on the running game, not in your head**: `node tools/inspect.mjs --nolock --name build-<piece>-<n> --steps '<json>'` (see the header of `tools/inspect.mjs` for steps). Then Read the PNGs (`python tools/sheet.py tools/out/build-<piece>-<n> 3 640` → Read `sheet.png`, plus the key full-size shots) and `report.json` (errors, perf). Iterate until it looks and measures the way the bar demands. Do the FINAL perf check without `--nolock` (exclusive run): frame mean/p95/p99, draw calls, tris, memMB stable.
- If the harness reports an error from a file you don't own (another builder mid-edit), wait ~30 s and retry (up to 5×). Don't fix their files; mention it in the report.
- Performance is a feature: respect your system's ms budget (CLAUDE.md), pool allocations, instance/batch, LOD, scale with `game.quality` / `game.renderer.qualityPreset`.
- Determinism: seeded randomness via `core/Noise.js` (`mulberry32(game.seed + offset)`, `hash2`, `fbm`).
- Keep `?auto=1` automation and `window.__game` working. If critics should be able to trigger things in your system (e.g. spawn an enemy, equip weapon 2, force time), expose a method on your system object and mention it in your report (the orchestrator wires it into `window.__game`).
- When done, the piece must look/feel like the real thing — Destiny 2 for feel, FF14 for look. Ask yourself: would a blind panel pick ours? If not, you're not done; keep going (within your time).
- Final message = a concise report (≤ 25 lines): what you built, how to trigger/inspect it (exact `__game`/system calls), perf numbers you measured, asks for other systems/orchestrator, known gaps. No fluff.

## Models and hero assets — the pipeline is not optional (added 2026-08-26)

If your task involves a creature, an NPC, or a landmark, **read `docs/CREATURE-PIPELINE.md` and
`docs/ORNAMENT-STANDARD.md` before you write geometry**, and run the `img2threejs` skill properly.

- **No GLB ever reaches the runtime.** concept image → Tripo GLB (structural reference) → the
  `img2threejs` skill → procedural Three.js code. Only the code ships. `tools/invariants.mjs` rule
  (n) fails the build on a `GLTFLoader` import or a `.glb` string in code. A provenance *comment*
  naming what you rebuilt from is wanted — say it.
- **Do not improvise the conversion.** The skill is a gated pipeline: state gate (`forge/next.py`),
  pre-spec assessment + quality contract, a **detail inventory** where every identity-defining
  feature must map to a `component.localFeatures` / `material.localOverrides` entry (prose does not
  count), staged build passes, then turntable (four azimuths, never one frame), self-intersection,
  interior-difference and per-feature fidelity gates with a bounded correction loop. That loop is
  the thing that catches "smooth cylinder where the reference has a fluted column" — which shipped
  three times before anyone ran it.
- **`python3` works now.** It did not, which is why earlier builders bailed to hand-rolled
  primitives after their first pasted command printed "Python was not found". Shims live at
  `C:\Users\ianca\bin\python3` (Git Bash) and `python3.cmd` (cmd/PowerShell). Run skill scripts from
  the skill root: `C:/Users/ianca/.claude/skills/img2threejs`. The skill is stdlib-only; nothing to
  install.
- **Massing is not detail.** A hero asset is judged at THREE distances and must be captured at all
  three before you report done: silhouette at 200 m, ornament hierarchy at 40 m (is the cornice
  actually carved? are the columns actually fluted?), material truth at 8 m (veining, chipped
  edges, dirt in the crevices). Put the shots beside the reference render and score yourself
  honestly. "Improved" is not "done".
- **Creatures additionally** keep the existing `src/enemies/` contract — same `BODIES` entry point,
  same bone names and animate hooks, same LOD ladder, `Enemies.warm()` still builds one of each at
  boot — and fit roughly 3.5k tris at LOD0, because up to 72 are alive at once.
