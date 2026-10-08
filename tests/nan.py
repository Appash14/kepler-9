"""Rectangles noirs du bloom (lot F) : un pixel NaN dans la scène doit rester invisible.

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/nan.py [dossier de sortie]
À la halte « serre », horloge figée, on pose devant la caméra deux petits carrés (environ 8 px) dont le
shader rend NaN : l'un avec un matériau three.js (sortie assainie par le garde-fou des matériaux),
l'autre avec un ShaderMaterial maison (seul le garde-fou du bloom le retient). On compte les pixels
noirs purs de l'image finale, avec et sans les carrés. Sans garde-fou, le bloom étale chaque NaN en un
rectangle noir de plusieurs centaines de pixels de côté, comme dans le clip de Tom.
"""
import asyncio
import os
import subprocess
import sys

import numpy as np
from playwright.async_api import async_playwright

URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
W, H = 960, 600

POSER = r"""
(mode) => {
  const S = window.__station, sc = S.scene, cam = S.camera;
  for (const n of ['nan_a', 'nan_b']) { const o = sc.getObjectByName(n); if (o) sc.remove(o); }
  if (mode === 'sans') return 'sans';
  // classes prises sur des objets déjà dans la scène (le crochet de test n'expose pas tout three.js)
  let modele = null, maison = null;
  sc.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (!modele && o.material.isMeshStandardMaterial && !o.isInstancedMesh) modele = o;
    if (!maison && o.material.isShaderMaterial && o.name === 'anneaux_geante') maison = o;
  });
  const geoCarre = (centre, droite, haut, d) => {
    const g = new modele.geometry.constructor();
    const P = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]].map(([a, b]) => centre.clone().addScaledVector(droite, a * d).addScaledVector(haut, b * d));
    const arr = new Float32Array(P.flatMap((p) => [p.x, p.y, p.z]));
    const nrm = new Float32Array(P.flatMap(() => [0, 0, 1]));
    const uv = new Float32Array(P.flatMap(() => [0, 0]));
    const BA = maison.geometry.attributes.position.constructor;
    g.setAttribute('position', new BA(arr, 3)); g.setAttribute('normal', new BA(nrm, 3)); g.setAttribute('uv', new BA(uv, 2));
    return g;
  };
  const V = S.THREE.Vector3;
  const dir = new V(); cam.getWorldDirection(dir);
  const droite = new V().crossVectors(dir, cam.up).normalize(), haut = new V().crossVectors(droite, dir).normalize();
  const d = 5, demi = Math.tan(cam.fov * Math.PI / 360) * d * 0.014;
  const cA = cam.position.clone().addScaledVector(dir, d).addScaledVector(droite, -d * 0.25);
  const cB = cam.position.clone().addScaledVector(dir, d).addScaledVector(droite, d * 0.25);
  const mA = modele.material.clone();
  mA.onBeforeCompile = (sh) => {
    sh.uniforms.uZero = { value: 0 };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uZero;')
      .replace('#include <dithering_fragment>', 'gl_FragColor = vec4(vec3(uZero / uZero), 1.0);\n#include <dithering_fragment>');
  };
  mA.customProgramCacheKey = () => 'test-nan-a';
  const a = new modele.constructor(geoCarre(cA, droite, haut, demi), mA);
  const mB = maison.material.clone();
  mB.uniforms = { uZero: { value: 0 } };
  mB.vertexShader = 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  mB.fragmentShader = 'uniform float uZero; void main(){ gl_FragColor = vec4(vec3(uZero / uZero), 1.0); }';
  mB.transparent = false; mB.depthWrite = true;
  const b = new modele.constructor(geoCarre(cB, droite, haut, demi), mB);
  a.name = 'nan_a'; b.name = 'nan_b'; a.frustumCulled = false; b.frustumCulled = false; a.renderOrder = 50; b.renderOrder = 50;
  sc.add(a, b);
  return 'avec';
}
"""


def noirs(png):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    im = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    m = im.max(axis=2) < 6
    ys, xs = np.nonzero(m)
    boite = f'x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}' if len(xs) else '-'
    return int(m.sum()), boite


async def main():
    sortie = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'captures', 'lotF-nan')
    os.makedirs(sortie, exist_ok=True)
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': W, 'height': H})).new_page()
        err = []
        page.on('pageerror', lambda e: err.append(str(e)))
        await page.goto(URL + '?test=1&q=high&cube=256', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=300000)
        await page.add_style_tag(content='#app > *:not(#scene), #app .halte, #app .halte * { visibility: hidden !important; }')
        await page.evaluate('(() => { const S = window.__station; S.figer(30); S.aller("serre"); S.figer(30); })()')
        res = {}
        for mode in ('sans', 'avec'):
            await page.evaluate(POSER, mode)
            n0 = await page.evaluate('window.__station.etat.image')
            await page.wait_for_function(f'window.__station.etat.image >= {n0} + 3', timeout=300000)
            chemin = os.path.join(sortie, f'serre-{mode}-nan.png')
            await page.screenshot(path=chemin, timeout=180000)
            res[mode] = noirs(chemin)
            print(mode, 'pixels noirs purs :', res[mode][0], 'boîte :', res[mode][1], flush=True)
        rendu = await page.evaluate('window.__station.etat.rendu')
        print('rendu :', rendu)
        print('pixels noirs ajoutés par les deux NaN :', res['avec'][0] - res['sans'][0], '(un carré fait environ 8 x 8 = 64 px)')
        print('erreurs page :', len(err), err[:3])
        await nav.close()


asyncio.run(main())
