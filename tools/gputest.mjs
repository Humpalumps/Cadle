import { chromium } from 'playwright';
for (const mode of [{headless:true, args:['--use-angle=d3d11','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu']},{headless:true, args:['--ignore-gpu-blocklist']},{headless:false,args:[]}]) {
  const b = await chromium.launch({ headless: mode.headless, args: mode.args, channel: undefined });
  const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas>');
  const info = await p.evaluate(() => { const gl = document.getElementById('c').getContext('webgl2'); if(!gl) return 'no webgl2'; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
  console.log(JSON.stringify(mode), '=>', info);
  await b.close();
}
