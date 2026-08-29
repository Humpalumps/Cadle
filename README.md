# Cadle

A browser FPS-RPG in Three.js. Ten regions, one broken sky, no download and no
account — it starts in a tab. Live at **[cadle.gg](https://cadle.gg)**.

The target is Destiny 2's moment-to-moment feel with Final Fantasy XIV's light:
90–105° FOV, sprint-slide-double-jump with real momentum, per-archetype recoil,
hit markers and damage numbers, over a 2048 m² world of ten biomes you can walk
between — each with its own ground, silhouette, bestiary, weather of light and
score. 140 fps on a desktop GPU at `q=high`, and every gun, impact and note is
generated in code rather than played back.

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:5173  — the marketing site
                     # http://127.0.0.1:5173/play/  — the game
```

Node 22, a WebGL2 browser, Chromium recommended. Nothing loads until you press
Play: landing on `/play/` builds no renderer and no world, only the title screen.

Useful URL parameters: `?q=low|medium|high|ultra`, `&seed=N`, `&at=<region>` to
spawn in one of the ten regions, `&hour=H` to freeze the clock, `&debug=1`.

## Audio

You will hear synthesised weapons, impacts and music. That is the shipping path
in this repository, not a degraded mode — the recorded takes are excluded for
licensing reasons (see [NOTICE](NOTICE)) and every recipe in `src/audio/sfx.js`
and `src/audio/music.js` synthesises what it needs when no take is present.

To use your own recordings, drop mp3s into `public/assets/sfx/` and
`public/assets/music/` and add `public/assets/audio.json`:

```json
{
  "sfx": ["shot-handcannon-1", "shot-handcannon-2", "explosion-1"],
  "music": ["field-theme", "night-theme"],
  "musicDeferred": ["wood-theme", "frost-theme"]
}
```

`src/core/Assets.js` reads that manifest if it is there and ignores the recorded
path entirely if it is not.

## Layout

```
src/render/     renderer, sky, lighting, post-processing
src/world/      terrain, biomes, water, grass, vegetation, landmarks
src/player/     controller, camera, weapons, abilities
src/enemies/    creatures, AI, spawner            src/combat/  hit resolution
src/rpg/        quests, progression, loot         src/audio/   synthesis
src/ui/         HUD, menus                        src/site/    cadle.gg
tools/          the harness: headless capture, regression gates, perf probes
```

`CLAUDE.md` is the working contract — architecture, file ownership, the
performance budget and the world layout. Each file's header comment is the
contract for that system.

## Checks

```bash
node tools/invariants.mjs   # source guardrails (also CI)
node tools/check.mjs        # syntax + import resolution
node tools/curvecheck.mjs   # xp curve, quest content, drop rates
node tools/gate.mjs         # full visual regression gate — needs a GPU and the dev server
```

## Licence

Code is MIT ([LICENSE](LICENSE)). The asset files are **not** covered by it and
the recorded audio is not in this repository at all — [NOTICE](NOTICE) explains
both.
