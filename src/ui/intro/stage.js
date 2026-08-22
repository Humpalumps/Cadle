import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mulberry32 } from '../../core/Noise.js';
import { makeCanvas, loadTexture } from './env.js';

/**
 * Intro stage: the scene, the lighting rig and the camera choreography for the "sucked into the
 * monitor" loading screen.  (orchestrator)
 *
 * Owns:  scene graph assembly, ALL lights, the camera path, the monitor screen material, the aether
 *        stream particles and the group-level suck-in transform.
 * Uses:  ./room.js      buildRoom({rng, tex})      -> {group, screen, materials, update(t), dispose()}
 *        ./character.js buildCharacter({rng, tex}) -> {group, body, chair, materials, update(t), setSuck(k), dispose()}
 *        Both are optional — if either fails to load the stage still runs (grey-box stand-in), because a
 *        loading screen must never be the thing that stops the game from loading.
 *
 * API:
 *   const stage = await buildStage({ seed, withRoom, withCharacter })
 *   stage.scene / stage.camera
 *   stage.setScreenTexture(tex)      the monitor's backdrop layer (the live game render)
 *   stage.setScreenUITexture(tex)    the title-screen layer over it (alpha canvas: wordmark, load bar, prompt)
 *   stage.setScreenBoost(x)          1 = normal, higher = the screen flaring during the transition
 *   stage.update(t, dt)              idle: slow dolly + room/character idle life
 *   stage.setSuck(k)                 0..1 transition: character pose + travel/stretch toward the screen
 *   stage.fitCameraToScreen(aspect)  camera transform where the screen exactly fills the viewport
 *   stage.orbit(dYaw)                preview-only: swing the camera around the look target
 *   stage.dispose()
 *
 * Coordinates (metres, Y up, -Z into the wall) are shared with room.js / character.js — see SCREEN below.
 *
 * Textures: the intro loads its own small set from public/assets/intro/ (287 KB total) and hands them to
 * both modules as `tex`. This is the ONE documented exception to "load everything through game.assets" —
 * the intro is on screen *while* game.assets is still preloading, so it cannot wait for it. Keep the set
 * tiny (512 px JPG) and keep every material's procedural fallback working when a texture is null.
 */

const _suckTo = new THREE.Vector3();
export const SCREEN = {
  w: 0.868, h: 0.49,                  // 1.4x: it is the loading menu, it has to carry the frame
  pos: new THREE.Vector3(0, 1.21, -0.945),
  tiltX: -0.07,
};

// camera choreography: a slow push-in over the whole load, then the transition takes over
const CAM_A = new THREE.Vector3(0.98, 1.96, 2.28), LOOK_A = new THREE.Vector3(0.05, 1.16, -0.45);
const CAM_B = new THREE.Vector3(1.14, 1.82, 1.86), LOOK_B = new THREE.Vector3(0.07, 1.11, -0.50);
const DOLLY_SECS = 12;   // the player clicks at 5-12 s, so a 30 s dolly never reached the tighter framing

// name -> {url, tile}. Small on purpose: this whole set must land before the first intro frame.
const TEX = {
  hoodie: { url: '/assets/intro/hoodie_knit.jpg', tile: true },
  leather: { url: '/assets/intro/chair_leather.jpg', tile: true },
  plaster: { url: '/assets/intro/wall_plaster.jpg', tile: true },
  wood: { url: '/assets/intro/wood_floor.jpg', tile: true },
  rug: { url: '/assets/intro/rug_indigo.jpg', tile: true },
  posterCrystal: { url: '/assets/intro/poster_crystal.jpg', tile: false },
  posterRuins: { url: '/assets/intro/poster_ruins.jpg', tile: false },
};

/** load the intro texture set; a missing file resolves to null so the module keeps its procedural look */
async function loadIntroTextures() {
  // loadTexture, not THREE.TextureLoader: the latter builds an <img>, which does not exist in the worker.
  const out = {};
  await Promise.all(Object.entries(TEX).map(([name, cfg]) => loadTexture(cfg.url, { tile: cfg.tile })
    .then((t) => { out[name] = t; })
    .catch((e) => { console.warn('[intro] texture missing:', name, e?.message); out[name] = null; })));
  return out;
}

// Optional generated body (Magnific/Tripo, see ASSETS.md). When present it REPLACES the procedural
// body from character.js — that module still supplies the chair, the idle timing and the suck pose hooks.
// Missing file => the procedural body stays. Tunable live from the harness via stage.fitGuy(...).
const GUY_URL = '/assets/intro/guy.glb';
// Solved against the desk and the chair by eye in intro.html (__intro.stage.fitGuy / setChair), not
// derived: he is one rigid mesh, so "hands on the desk" and "back in the chair" are a placement problem.
const GUY_FIT = { height: 1.46, x: -0.15, y: 0.0, z: -0.12, rotY: Math.PI, rotZ: 0 };
const GUY_CHAIR = [-0.15, 0, 0.04];        // character.js measured the chair against its own body

async function loadGuy() {
  try {
    // meshopt-compressed (4.5 MB -> 1.3 MB); the decoder is a ~30 KB module bundled with the app, no
    // side files to host. Compressed offline with: npx @gltf-transform/cli optimize in.glb out.glb
    //   --compress meshopt --simplify true --simplify-error 0.002 --texture-compress false
    // The BYTES come from the inline <script> in index.html, which kicks the fetch off during HTML parse
    // (~5 ms) instead of here (~350 ms, behind the intro textures and the room/chair build). It used to be
    // a <link rel="preload" as="fetch"> reused by a fetch() here, but the preload never matched — Chrome
    // logged "credentials mode does not match" and downloaded all 443 KB a second time, every cold load.
    // The fallback keeps intro.html (which has no such script) working.
    const buf = await (globalThis.__guyGlb ?? fetch(GUY_URL).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.arrayBuffer();
    }));
    const tB = performance.now();
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(buf, '');
    console.info(`[intro] body: bytes at ${Math.round(tB)} ms, parsed at ${Math.round(performance.now())} ms`);
    return gltf.scene;
  } catch (e) { console.warn('[intro] generated body unavailable:', e?.message); return null; }
}

/** scale/park a raw generated mesh so it sits on the floor at the seat, facing the monitor */
function fitGuy(g, f) {
  g.scale.setScalar(1); g.position.set(0, 0, 0); g.rotation.set(0, f.rotY, f.rotZ || 0);
  g.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(g);
  const size = b.getSize(new THREE.Vector3());
  const k = f.height / Math.max(size.y, 1e-4);
  g.scale.setScalar(k);
  g.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(g);
  const c = b2.getCenter(new THREE.Vector3());
  g.position.set(f.x - c.x, f.y - b2.min.y, f.z - c.z);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.updateMatrixWorld(true);
  return g;
}

const smoothstep = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };

function greyBoxScreen() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), new THREE.MeshBasicMaterial());
  m.position.copy(SCREEN.pos); m.rotation.x = SCREEN.tiltX; m.name = 'screen';
  return m;
}

export async function buildStage({ seed = 7, withRoom = true, withCharacter = true } = {}) {
  RectAreaLightUniformsLib.init();
  const t0 = performance.now();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050a);
  scene.fog = new THREE.FogExp2(0x090a16, 0.10);          // thin haze so the monitor light has body

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.02, 60);
  camera.position.copy(CAM_A);
  camera.lookAt(LOOK_A);

  // ---------------------------------------------------------------- modules (never fatal)
  const rng = mulberry32(seed);
  // Kicked off BEFORE the awaits below: meshopt decode and the two embedded WebP images (createImageBitmap,
  // off-thread) then overlap the texture load and the room/chair build instead of queueing behind them.
  const guyReady = withCharacter ? loadGuy() : Promise.resolve(null);
  const tex = await loadIntroTextures();
  // import.meta.glob rather than a static import: the room/character modules are optional by design, and
  // a bare `import './room.js'` makes their absence a build error instead of a missing prop.
  const MODS = import.meta.glob('./*.js');
  const load = async (n) => (MODS[`./${n}.js`] ? MODS[`./${n}.js`]() : Promise.reject(new Error(`${n}.js not present`)));
  let room = null, character = null;
  if (withRoom) {
    try { room = (await load('room')).buildRoom({ rng, tex }); scene.add(room.group); }
    catch (e) { console.warn('[intro] room module unavailable:', e?.message); }
  }
  if (withCharacter) {
    try { character = (await load('character')).buildCharacter({ rng, tex }); scene.add(character.group); }
    catch (e) { console.warn('[intro] character module unavailable:', e?.message); }
  }
  // NOT awaited. The room is the loading screen and has to paint as early as possible; the model's bytes
  // were already in flight before this function ran (see loadGuy), and when it still is not ready, an
  // empty chair for a moment beats a dark page. There is only ever ONE body — the procedural one in
  // character.js is hidden up front and only comes back if this download fails — so
  // this can fade in without the two-characters-popping problem the cross-fade used to have.
  let guy = null, guyHolder = null, guyFade = -1;
  if (!room) {                                            // stand-in so the shot still composes
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x23242e, roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 8), mat); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.6), mat); wall.position.set(0, 1.3, -1.1); wall.receiveShadow = true;
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.04, 0.75), mat); desk.position.set(0, 0.725, -0.675); desk.castShadow = desk.receiveShadow = true;
    g.add(floor, wall, desk, greyBoxScreen());
    room = { group: g, screen: g.children[3], materials: [mat], update() {}, dispose() {} };
    scene.add(g);
  }

  // ---------------------------------------------------------------- the monitor screen
  const screen = room.screen ?? greyBoxScreen();
  if (!screen.parent) scene.add(screen);
  // toneMapped basic: the screen is a light source, ACES keeps it from clipping to a white slab and the
  // bloom pass picks up the >1 headroom as a soft halo. Colour carries the boost, never the texture.
  const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, fog: false });
  screen.material = screenMat;
  screen.renderOrder = 2;

  // The monitor is showing the GAME'S START SCREEN: the live world renders on `screen` as the menu
  // backdrop, and this second quad sits 2 mm in front carrying the title / load bar / prompt with alpha —
  // exactly how a real game's title screen is composited over an in-game vista.
  const screenUIMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, toneMapped: true, fog: false, depthWrite: false,
  });
  // A HAIR larger than the panel, never smaller: an inset quad puts its own edge inside the lit panel and
  // the antialiaser renders that near-coincident boundary as a dashed line right round the screen (this
  // was the "white edges on the monitor" bug). Oversized by 0.4% it tucks under the bezel instead.
  const screenUI = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w * 1.004, SCREEN.h * 1.004), screenUIMat);
  screen.getWorldPosition(screenUI.position);
  screenUI.quaternion.copy(screen.getWorldQuaternion(new THREE.Quaternion()));
  screenUI.translateZ(0.0012);
  screenUI.renderOrder = 3;
  screenUI.visible = false;              // no map yet = an opaque white quad over the screen
  scene.add(screenUI);

  // ---------------------------------------------------------------- lights (all of them live here)
  // The panel plane, as a clipping plane: during the dive the body is clipped against it, so whatever has
  // crossed the glass genuinely vanishes into the monitor instead of piling up in front of it.
  const SCREEN_N = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), SCREEN.tiltX);
  const screenClip = new THREE.Plane(SCREEN_N.clone(), -SCREEN_N.dot(SCREEN.pos));

  // 0.98, not 1.08: an emitter wider than the panel rakes the monitor's own bezel from the side and lit
  // an 11 mm strip into a bright line around the screen.
  const rect = new THREE.RectAreaLight(0x9b8bff, 11, SCREEN.w * 0.98, SCREEN.h * 0.98);
  rect.position.set(SCREEN.pos.x, SCREEN.pos.y, SCREEN.pos.z + 0.012);
  rect.lookAt(0, 1.02, 0.6);
  // EXPERIMENT: not added — the spot below carries the monitor wash instead

  // RectAreaLight cannot cast shadows — this spot rides along to throw his shadow back onto the chair/wall
  const spot = new THREE.SpotLight(0x9b8bff, 17.0, 7, 1.22, 1.0, 1.18);   // TUNE 2: flatter decay to kill the desk hotspot
  spot.position.set(0, 1.15, -0.86);
  spot.target.position.set(0, 0.92, 0.5);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0012; spot.shadow.normalBias = 0.022;
  spot.shadow.camera.near = 0.2; spot.shadow.camera.far = 7;
  scene.add(spot, spot.target);

  // moonlight through the window on the left wall — the cool rim that separates him from the dark
  const moon = new THREE.DirectionalLight(0x7290da, 0.8);
  moon.position.set(-5.0, 3.4, 1.4); moon.target.position.set(0.25, 0.95, 0.1);
  // The spot already throws his shadow onto the chair and the wall, which is the shadow the shot needs.
  // A second shadow-casting light adds a depth-program variant for every casting material.
  moon.castShadow = false;
  moon.shadow.mapSize.set(1024, 1024);
  const sc = moon.shadow.camera; sc.left = -2.6; sc.right = 2.6; sc.top = 2.6; sc.bottom = -2.6; sc.near = 0.5; sc.far = 12;
  moon.shadow.bias = -0.0016; moon.shadow.normalBias = 0.03;
  scene.add(moon, moon.target);

  // `warm` (a second warm point at 1.55,1.80,0.50) is GONE, folded into `rim` below. Point-light count is
  // unrolled into every shader in the scene, so each one is paid for in compile time on the first frame,
  // and two warm sources 1.4 m apart on the same side of the room were doing one job.

  // Warm spill from the doorway behind his right shoulder. This is the shot's rim light: the monitor
  // lights his FRONT, so without this he is a black silhouette on a violet wall. Warm against the cool
  // screen is also what separates him from the background.
  // desaturated on purpose: at 0xffb07a it was the ONLY light on his back, and it turned a cool-grey
  // hoodie khaki. Warm enough to separate him from the violet wall, neutral enough to keep the garment grey.
  // carries `warm`'s job too now: pulled forward and up between the two old positions, and brighter to
  // cover the fill it used to add.
  const rim = new THREE.PointLight(0xffe0cc, 2.9, 8.0, 2);
  rim.position.set(1.55, 1.90, 1.25);
  scene.add(rim);

  // `rimCool` (window-side cool point) is GONE: the moon is a directional from the same side and the
  // hemisphere's sky colour is already cool, so his left edge still is not pure black.

  // ambient: enough that shadow-side surfaces sit around sRGB 30-45, never at zero. Sky tint pushed a
  // touch cooler and brighter to replace rimCool's fill on the window side.
  scene.add(new THREE.HemisphereLight(0x5a628a, 0x4d3b28, 4.6));   // 39% of the frame was pure black; the references have none   // near-neutral: only the monitor is violet

  // (No volumetric light cone. A BackSide cone big enough to read from 0.7 m away subtends ~50 deg of
  // the frame and silhouettes as a hard translucent wedge; the dust motes in the monitor's light and the
  // bias glow on the wall carry the atmosphere instead.)

  // ---------------------------------------------------------------- aether stream (transition only)
  // Seeded in a CONE from him to the screen, not scattered through the room: this has to read as a
  // stream INTO the monitor. Hard square points read as dead pixels, so they get a soft radial sprite.
  const N = 230;
  const ORIGIN = new THREE.Vector3(0, 1.02, 0.34);      // roughly his chest
  const pPos = new Float32Array(N * 3), pSeed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.pow(rng(), 0.7);                     // bunched toward the screen end
    const a = rng() * Math.PI * 2, r = (0.06 + 0.30 * u) * Math.sqrt(rng());
    const cx = SCREEN.pos.x + (ORIGIN.x - SCREEN.pos.x) * u;
    const cy = SCREEN.pos.y + (ORIGIN.y - SCREEN.pos.y) * u;
    const cz = SCREEN.pos.z + (ORIGIN.z - SCREEN.pos.z) * u;
    pSeed[i * 3] = cx + Math.cos(a) * r;
    pSeed[i * 3 + 1] = cy + Math.sin(a) * r;
    pSeed[i * 3 + 2] = cz + (rng() - 0.5) * 0.12;
    pPos[i * 3] = pSeed[i * 3]; pPos[i * 3 + 1] = pSeed[i * 3 + 1]; pPos[i * 3 + 2] = pSeed[i * 3 + 2];
  }
  const streamGeo = new THREE.BufferGeometry();
  streamGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const moteCv = makeCanvas(32, 32);
  {
    const c = moteCv.getContext('2d');
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(190,165,255,.55)'); g.addColorStop(1, 'rgba(140,110,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 32, 32);
  }
  const moteTex = new THREE.CanvasTexture(moteCv);
  const streamMat = new THREE.PointsMaterial({
    color: 0x9d7bff, size: 0.030, map: moteTex, transparent: true, opacity: 0, sizeAttenuation: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: true,
  });
  const stream = new THREE.Points(streamGeo, streamMat);
  stream.frustumCulled = false; stream.renderOrder = 4;
  scene.add(stream);

  // ---------------------------------------------------------------- suck pivot
  // The character's body is built in absolute world coordinates, so it is re-parented into a pivot at
  // its own centre whose -Z aims at the screen. Scaling that pivot's Z stretches him along the travel
  // axis (the body carries the inverse rotation, so he stays upright and the scale shears into a smear).
  let pivot = null, pivotBase = null, bodyMats = null;
  /** put `obj` inside a pivot aimed at the screen, so scaling the pivot's Z smears him along the travel
   *  axis. Called again if the generated body arrives after the procedural one was already bound. */
  function bindSuck(obj) {
    if (!obj) return;
    // fade only what actually flies into the screen — `character.materials` is EVERY material that module
    // made, and fading that list takes the chair with him and leaves an empty room behind.
    bodyMats = new Set();
    obj.traverse((o) => { const m = o.material; if (m) for (const mm of Array.isArray(m) ? m : [m]) bodyMats.add(mm); });
    // Anchor the pivot at the LEADING end of the body (the point nearest the screen), not its centre:
    // scaling Z about the centre smears him equally toward the screen and away from it, and because the
    // screen sits well above a seated bbox centre that axis tilts upward — he stretched out of frame
    // instead of into the monitor.
    const box = new THREE.Box3().setFromObject(obj);
    const c0 = box.getCenter(new THREE.Vector3());
    const dir = SCREEN.pos.clone().sub(c0).normalize();
    const ext = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const reach = Math.abs(dir.x) * ext.x + Math.abs(dir.y) * ext.y + Math.abs(dir.z) * ext.z;
    const c = c0.clone().addScaledVector(dir, reach * 0.35);
    pivot = new THREE.Group();
    pivot.position.copy(c);
    pivot.lookAt(SCREEN.pos);
    obj.position.sub(c).applyQuaternion(pivot.quaternion.clone().invert());
    obj.quaternion.copy(pivot.quaternion).invert();
    // transparent NOW, not when the fade starts: flipping it mid-dive relinks the whole character's
    // shader programs on the single frame that must not stutter.
    for (const m of bodyMats) { m.transparent = true; m.needsUpdate = true; }
    pivot.add(obj);
    scene.add(pivot);
    pivotBase = c.clone();
  }
  // ---------------------------------------------------------------- first-frame cost control
  // stage.js owns ALL lights (see the header), and room.js adds four of its own: a violet keyboard glow,
  // a crystal glow, and two fairy-string lights. Every one of them is unrolled into every shader in the
  // scene and paid for in compile time on the first painted frame. The bulbs and the crystal are emissive
  // GEOMETRY, so they still glow with the lights gone — what is lost is the wash they threw, and one warm
  // point below replaces the pair of fairy lights with a single source at their midpoint.
  if (room?.group) {
    const strays = [];
    room.group.traverse((o) => { if (o.isLight) strays.push(o); });
    for (const l of strays) l.parent?.remove(l);
    if (strays.length) {
      // TWO, not one. A single light cannot stand in for three sources spread across the ceiling: short
      // range left the corners black (ceiling -22), and widening its reach to fix that lit the whole room
      // instead (body +7, ceiling still -16). Two lights on the string, kept deliberately short-range so
      // the wash stays in the top third of the frame and does not wander down onto the rug.
      const fairyA = new THREE.PointLight(0xffa860, 3.1, 4.4, 2);
      fairyA.position.set(-0.55, 2.16, 0.60);
      const fairy = new THREE.PointLight(0xffa860, 3.1, 4.4, 2);
      fairy.position.set(1.15, 2.16, 0.60);
      scene.add(fairyA);
      scene.add(fairy);
    }
  }

  // Materials flagged transparent while fully opaque get their own shader program for no visual reason —
  // and the transparent pass sorts them per frame forever after. Free to merge into the opaque bucket.
  for (const grp of [room?.group, character?.group]) grp?.traverse?.((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m && m.transparent && m.opacity >= 1 && !m.alphaMap && !(m.alphaTest > 0)) { m.transparent = false; m.needsUpdate = true; }
    }
  });

  let guyBaseY = 0, chairHolder = null;
  if (character?.body) character.body.visible = false;     // one body only; restored below if the load fails
  guyReady.then((g) => {
    if (!g) {
      console.warn('[intro] generated body unavailable — falling back to the procedural one');
      if (character?.body) character.body.visible = true;
      bindSuck(character?.body || null);
      return;
    }
    guy = g;
    // the pivot overwrites its child's quaternion, so the model goes inside a holder and the HOLDER is
    // what gets re-parented — otherwise the fitted rotation/scale dies the moment the pivot binds
    guyHolder = new THREE.Group();
    guyHolder.add(guy);
    fitGuy(guy, GUY_FIT);
    guyBaseY = guy.position.y;
    // The only lights that reach his back are warm, so a neutral albedo renders khaki — measured against
    // the reference plate the garment was 10x too saturated. A gentle in-gamut cool tint, not a hack.
    guy.traverse((o) => { const m = o.material; if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.color?.setRGB(0.88, 0.95, 1.08); });
    scene.add(guyHolder);
    if (character?.body) character.body.visible = false;               // one body only, never a swap
    if (character?.chair) {
      // Do NOT write character.chair.position here: character.js's setSuck() rewrites it from its own
      // CHAIR_PIVOT constant on every call, so the chair silently snaps back and he ends up sitting
      // beside it. Offset a parent group instead — the module keeps full control of the local transform.
      const base = character.chair.position.clone();
      const holder = new THREE.Group();
      holder.position.set(GUY_CHAIR[0] - base.x, GUY_CHAIR[1] - base.y, GUY_CHAIR[2] - base.z);
      (character.group ?? scene).add(holder);
      holder.add(character.chair);
      chairHolder = holder;
    }
    // The cross-fade is for a LATE body only. dt is clamped to 50 ms upstream (Intro._frame) so a 0.4 s
    // fade costs 8 RENDERED frames — and during boot those frames are seconds apart (material compiles,
    // then the world build on the same thread). He now parses at ~300 ms against a first paint at ~2 s,
    // so fading him would show a semi-transparent body with the chair and desk visible through it for
    // several seconds: the "silhouette in the chair" bug. Arrive before the first frame => arrive solid.
    const late = painted;
    guy.traverse((o) => { const m = o.material; if (m) for (const mm of Array.isArray(m) ? m : [m]) { mm.transparent = true; mm.opacity = late ? 0 : 1; } });
    guyFade = late ? 0 : -1;
    bindSuck(guyHolder);
    api.guy = guy;
  });
  // (api.guy is assigned below once the object literal exists)

  // ---------------------------------------------------------------- state
  let suck = 0, screenBoost = 1, screenDim = 1, dolly = 0, camFree = false, clipOn = false, lightsFull = true;
  let painted = false;                 // set by update(): has a frame been drawn yet?
  const _look = new THREE.Vector3();
  let orbitYaw = 0, orbitTarget = LOOK_B.clone();

  const api = {
    scene, camera, room, character, guy: null, guyReady, screen, screenMat, screenUI, screenUIMat, rect, spot, stream, tex,
    buildMs: 0,

    /** @param dim grade the backdrop down (a menu backdrop is never shown at full exposure — the title
     *  has to read over it). 1 = as-is. */
    setScreenTexture(tex, dim = 1) {
      if (screenMat.map !== tex) { screenMat.map = tex; screenMat.needsUpdate = true; }
      screenDim = dim;
      screenMat.color.setScalar(screenBoost * screenDim);
    },
    /** the title-screen layer drawn over whatever the monitor is showing (alpha canvas) */
    setScreenUITexture(tex) {
      if (screenUIMat.map !== tex) { screenUIMat.map = tex; screenUIMat.needsUpdate = true; }
      screenUI.visible = !!tex;
      screenUIMat.opacity = 1;
    },
    /** Dive controls. The title layer has heavy scrims on it — leave it up as the camera fills the frame
     *  with the screen and the "portal" is a dark rectangle. Fade it out and ungrade the backdrop. */
    setScreenGrade(dim, uiAlpha) {
      screenDim = dim;
      screenMat.color.setScalar(screenBoost * screenDim);
      screenUIMat.opacity = uiAlpha;
      screenUI.visible = uiAlpha > 0.002 && !!screenUIMat.map;
    },
    /** 1 = normal desktop brightness; the transition drives this up to ~5 as the portal opens */
    setScreenBoost(x) {
      // HARD CAP. ACES cannot hold a >2x multiply on an already-bright meadow: the portal — the one image
      // the whole sequence builds toward — clipped to a blank white card. Cap the multiply and let bloom
      // carry the flare, so the vale stays visible through the doorway. (Same decree as the meadow blobs:
      // saturate the colour, cap the intensity.)
      screenBoost = Math.min(x, 2.0);
      screenMat.color.setScalar(screenBoost * screenDim);
      screenUIMat.color.setScalar(Math.min(screenBoost, 1.6));
      rect.intensity = 11 * Math.min(x, 2.0);
      spot.intensity = 7.0 * Math.min(x, 2.0);
    },

    update(t, dt) {
      painted = true;
      room?.update?.(t);
      character?.update?.(t);
      if (guyFade >= 0 && guyFade < 1) {                  // he landed after the first frame; ease him in
        guyFade = Math.min(1, guyFade + dt / 0.4);
        const o = guyFade;
        guy.traverse((n) => { const m = n.material; if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.opacity = o; });
      }
      if (guy && suck < 0.001) {                          // the generated body has no rig — breathe it
        guy.position.y = guyBaseY + Math.sin(t * 1.35) * 0.006;
        guy.rotation.z = GUY_FIT.rotZ + Math.sin(t * 0.41) * 0.004;
      }
      // idle: a very slow push-in with a hair of handheld float. Never fast enough to read as movement,
      // just enough that the frame is never dead.
      if (!camFree) {
        dolly = smoothstep(t / DOLLY_SECS);
        camera.position.lerpVectors(CAM_A, CAM_B, dolly);
        _look.lerpVectors(LOOK_A, LOOK_B, dolly);
        if (orbitYaw) {   // preview only: absolute swing around the look target, not a per-frame spin
          const dx = camera.position.x - _look.x, dz = camera.position.z - _look.z;
          const r = Math.hypot(dx, dz), a = Math.atan2(dx, dz) + orbitYaw;
          camera.position.x = _look.x + Math.sin(a) * r;
          camera.position.z = _look.z + Math.cos(a) * r;
        }
        camera.position.x += Math.sin(t * 0.37) * 0.006 + Math.sin(t * 0.83) * 0.002;
        camera.position.y += Math.sin(t * 0.29 + 1.7) * 0.005;
        camera.lookAt(_look);
      }
      if (suck > 0) {
        // particles rush the screen, accelerating; they respawn from their seed ring
        const arr = streamGeo.attributes.position.array;
        const pull = (0.9 + suck * 6.5) * dt;
        for (let i = 0; i < N; i++) {
          const j = i * 3;
          let dx = SCREEN.pos.x - arr[j], dy = SCREEN.pos.y - arr[j + 1], dz = SCREEN.pos.z - arr[j + 2];
          const d = Math.hypot(dx, dy, dz) || 1e-4;
          if (d < 0.09) { arr[j] = pSeed[j]; arr[j + 1] = pSeed[j + 1]; arr[j + 2] = pSeed[j + 2]; continue; }
          const s = pull * (0.35 + 1.4 / d) / d;
          arr[j] += dx * s; arr[j + 1] += dy * s; arr[j + 2] += dz * s;
        }
        streamGeo.attributes.position.needsUpdate = true;
      }
    },

    /** 0..1 — the whole "pulled into the monitor" move. Pose is the character module's; travel is ours. */
    setSuck(k) {
      suck = k;
      character?.setSuck?.(k);
      streamMat.opacity = Math.min(1, k * 2.4) * 0.55;
      if (!pivot) return;
      const e = k * k * (1.9 - 0.9 * k);                 // ease-in: slow grab, fast finish
      // Travel PAST the screen, not to it, so the trailing end also crosses the clip plane and he is
      // consumed by the rectangle instead of piling up against it.
      _suckTo.copy(SCREEN.pos).addScaledVector(SCREEN_N, -0.55);
      pivot.position.lerpVectors(pivotBase, _suckTo, Math.min(e * 1.02, 1));
      // Gentle: a 3.2x smear on a rigid unrigged mesh turns arms into flat shadeless spikes long before
      // he reaches the glass. Keep him readable as a person and let the warp and the motes carry speed.
      pivot.scale.set(1 - 0.15 * e, 1 - 0.15 * e, 1 + 1.6 * e);
      // Clipping does the work of removing him; the fade is only the last wisp.
      if (bodyMats && !clipOn && k > 0.001) {
        clipOn = true;
        for (const m of bodyMats) { m.clippingPlanes = [screenClip]; m.clipShadows = true; m.needsUpdate = true; }
      } else if (bodyMats && clipOn && k <= 0.001) {
        clipOn = false;
        for (const m of bodyMats) { m.clippingPlanes = null; m.needsUpdate = true; }
      }
      const fade = k < 0.90 ? 1 : 1 - (k - 0.90) / 0.10;
      if (bodyMats) for (const m of bodyMats) m.opacity = Math.max(0, fade);
      pivot.visible = fade > 0.001;
    },

    /** camera transform where the screen plane exactly fills a viewport of the given aspect */
    fitCameraToScreen(aspect) {
      const vFov = camera.fov * Math.PI / 180;
      const dH = (SCREEN.h / 2) / Math.tan(vFov / 2);
      const dW = (SCREEN.w / 2) / (Math.tan(vFov / 2) * aspect);
      const d = Math.max(dH, dW) * 1.001;
      const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), SCREEN.tiltX);
      const pos = SCREEN.pos.clone().addScaledVector(n, d);
      return { pos, look: SCREEN.pos.clone() };
    },

    /** Progressive lighting. Every material compiles against NUM_POINT_LIGHTS / NUM_SPOT_LIGHTS /
     *  NUM_RECT_AREA_LIGHTS etc, so the full rig makes the first render one long compile stall on a blank
     *  page. The room paints against a cheap rig (spot + warm rim + hemisphere) and the rest — the
     *  monitor's rect-area light, the moon, and the props' point lights — switch on a frame later, once
     *  there is already a picture on screen. `visible = false` is enough: three does not count hidden
     *  lights toward the shader permutation. */
    setLightsFull(on) {
      rect.visible = on; moon.visible = on;   // rimCool is gone; room.js's own lights are pruned at build
      lightsFull = on;
    },
    get lightsFull() { return lightsFull; },

    setCameraFree(v) { camFree = v; },
    /** harness: move the chair under him (character.js measured it against the procedural body) */
    setChair(x, y, z) {
      if (!chairHolder || !character?.chair) return false;
      const base = new THREE.Vector3(...GUY_CHAIR).sub(chairHolder.position);   // recover the module's own base
      chairHolder.position.set(x - base.x, y - base.y, z - base.z);
      return true;
    },
    /** harness: re-park the generated body, e.g. fitGuy({height:1.34, x:0, y:0, z:0.3, rotY:0}) */
    fitGuy(f) {
      if (!guy) return null;
      Object.assign(GUY_FIT, f || {});
      fitGuy(guy, GUY_FIT);
      guyBaseY = guy.position.y;
      return { ...GUY_FIT };
    },
    orbit(dYaw) { orbitYaw += dYaw; },                    // preview only

    dispose() {
      room?.dispose?.(); character?.dispose?.();
      spot.shadow.dispose(); moon.shadow.dispose();     // depth render targets; scene.traverse cannot see them
      streamGeo.dispose(); streamMat.dispose(); moteTex.dispose(); screenMat.dispose(); screenUI.geometry.dispose(); screenUIMat.dispose();
      for (const t of Object.values(tex)) t?.dispose?.();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        const m = o.material; if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) { mm.map?.dispose?.(); mm.dispose?.(); }
      });
      scene.clear();
    },
  };
  api.setLightsFull(true);      // EXPERIMENT: full rig from frame one, now that the LTC path is gone
  api.buildMs = performance.now() - t0;
  api.setSuck(0);
  return api;
}
