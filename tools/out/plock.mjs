import { chromium } from 'playwright';
const URL = 'http://127.0.0.1:5179/?q=low&seed=1337';
const b = await chromium.launch({ args: ['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(URL, { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => !!window.__game || !!document.querySelector('canvas'), null, { timeout: 30000 });
await p.evaluate(() => window.__game?.intro?.skip?.());
await p.waitForFunction(() => window.__game?.game?.started === true || !!document.getElementById('start'), null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
const click = () => p.mouse.click(640, 360);
await click(); await p.waitForTimeout(500);
let locked = await p.evaluate(() => !!document.pointerLockElement);
if (!locked) { await click(); await p.waitForTimeout(800); locked = await p.evaluate(() => !!document.pointerLockElement); }
console.log('ENGAGE:', locked ? 'OK' : 'FAIL');
let relocked = false;
if (locked) {
  await p.evaluate(() => document.exitPointerLock());
  await p.waitForTimeout(1600);
  await click(); await p.waitForTimeout(800);
  relocked = await p.evaluate(() => !!document.pointerLockElement);
  console.log('RE-ACQUIRE:', relocked ? 'OK' : 'FAIL');
}
await b.close();
process.exit(locked && relocked ? 0 : 1);
