"""Marge des trajets (lot F) : quelle part de l'écran la structure occupe-t-elle tout près de la caméra ?

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/marge.py [étiquette] [pas]
Pour chaque trajet entre haltes voisines, dans les deux sens, le chemin idéal du rig est échantillonné
(`pas` points, 40 par défaut). À chaque point, la station seule (verre exclu : on voit au travers) est
rendue en profondeur dans une petite image au cadrage du téléphone en portrait (champ élargi comme sur
le site), puis on mesure :
  - proche4 / proche8 : part de l'image occupée par une paroi à moins de 4 m / 8 m ;
  - dmin : distance de la paroi la plus proche dans le champ (m).
Les dix haltes (sans travelling) servent de référence : un intérieur (serre, forge) a des parois
proches par nature. Le défaut que Tom a filmé : en plein trajet, l'écran rempli d'une paroi à 2 m.
Écrit captures/marge-<étiquette>.json et affiche le pire point de chaque trajet. Lot F, 2026-10-02.
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
H = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']

JS = r"""
async ([H, pas]) => {
  const S = window.__station, T = S.THREE, rig = S.rig, cam = S.camera, R = S.renderer, sc = S.scene;
  S.degeler();
  const W = 24, Hh = 52, aspect = 390 / 844;
  const rt = new T.WebGLRenderTarget(W, Hh);
  const mat = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
  const buf = new Uint8Array(W * Hh * 4);
  // la station seule, sans verre
  const caches = [];
  for (const o of sc.children) if (o !== S.station.groupe && o.visible && !o.isLight) { o.visible = false; caches.push(o); }
  S.station.groupe.traverse((o) => {
    // points (pollen de la serre), traits et sprites : pas de taille de point avec le matériau de
    // profondeur, ils salissaient la mesure (faux 100 % sous 4 m)
    if ((o.isPoints || o.isLine || o.isSprite) && o.visible) { o.visible = false; caches.push(o); return; }
    if (!o.isMesh || !o.visible) return;
    const m = o.material, nom = (m && m.name) || '';
    let verre = nom === 'verre' || (m && m.transparent && m.depthWrite === false) || !!(m && m.blending === 2);
    for (let x = o; x && !verre; x = x.parent) if (x.name && x.name.startsWith('verre_')) verre = true;
    if (verre) { o.visible = false; caches.push(o); }
  });
  const fovEcran = (v) => {
    const tanH = Math.tan((v * Math.PI) / 360) * (16 / 9) * 0.6;
    return Math.min(Math.max((Math.atan(tanH / aspect) * 360) / Math.PI, v), 84);
  };
  const near = cam.near, far = cam.far;
  const mesurer = () => {
    cam.fov = fovEcran(rig.lisse.fov); cam.aspect = aspect; cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const av = sc.overrideMaterial, bg = sc.background, cc = R.getClearAlpha();
    sc.overrideMaterial = mat;
    R.setRenderTarget(rt); R.setClearColor(0xffffff, 1); R.clear(); R.render(sc, cam); R.setRenderTarget(null);
    sc.overrideMaterial = av;
    R.readRenderTargetPixels(rt, 0, 0, W, Hh, buf);
    let p4 = 0, p8 = 0, dmin = 1e9;
    for (let i = 0; i < W * Hh; i++) {
      const r = buf[i * 4] / 255, g = buf[i * 4 + 1] / 255, b = buf[i * 4 + 2] / 255, a = buf[i * 4 + 3] / 255;
      // unpackRGBAToDepth de three.js (r186) : profondeur 0..1 ; 1 = rien
      const d = r * (255 / 256) + g * (255 / 256) / 256 + b * (255 / 256) / 65536 + a / 16777216;
      if (d >= 0.9999) continue;
      const zN = d * 2 - 1;
      const z = (2 * near * far) / (far + near - zN * (far - near));
      if (z < 4) p4++;
      if (z < 8) p8++;
      if (z < dmin) dmin = z;
    }
    return { proche4: +(p4 / (W * Hh)).toFixed(3), proche8: +(p8 / (W * Hh)).toFixed(3), dmin: dmin < 1e9 ? +dmin.toFixed(2) : null };
  };
  const res = { haltes: {}, trajets: {} };
  for (let i = 0; i < H.length; i++) {
    S.aller(H[i]); rig.annuler(); rig.reamorcer(); rig.maj(0, 0, { reduit: true, instantane: true });
    res.haltes[H[i]] = mesurer();
  }
  for (const sens of [1, -1]) {
    for (let i = 0; i + 1 < H.length; i++) {
      const [a, b] = sens > 0 ? [i, i + 1] : [i + 1, i];
      S.aller(H[a]); rig.annuler(); rig.reamorcer(); rig.maj(0, 0, { reduit: true, instantane: true });
      rig.demarrer(a, b, 0);
      const duree = rig.trajet.duree, pts = [];
      for (let k = 1; k < pas; k++) {
        rig.maj((k / pas) * duree, 0, { reduit: true, instantane: true });
        const m = mesurer();
        m.u = +(k / pas).toFixed(3);
        pts.push(m);
      }
      rig.annuler();
      res.trajets[H[a] + '>' + H[b]] = pts;
    }
  }
  for (const o of caches) o.visible = true;
  rt.dispose(); mat.dispose();
  return res;
}
"""


async def main():
    etiquette = sys.argv[1] if len(sys.argv) > 1 else 'actuel'
    pas = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': 160, 'height': 100})).new_page()
        err = []
        page.on('pageerror', lambda e: err.append(str(e)))
        page.on('console', lambda m: err.append(m.text) if m.type == 'error' else None)
        await page.goto(URL + '?test=1&q=low&cube=128', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=300000)
        await page.evaluate('window.__station.renderer.setAnimationLoop(null)')
        r = await page.evaluate(JS, [H, pas])
        await nav.close()
    print('haltes (référence) :')
    for k, v in r['haltes'].items():
        print(f'  {k:14s} {v}')
    print('trajets : pire point (u ; part < 4 m ; part < 8 m ; paroi la plus proche)')
    for k, pts in r['trajets'].items():
        coeur = [x for x in pts if 0.12 <= x['u'] <= 0.88] or pts
        pire = max(coeur, key=lambda x: (x['proche4'], x['proche8']))
        dmin = min((x['dmin'] for x in coeur if x['dmin'] is not None), default=None)
        n4 = sum(1 for x in coeur if x['proche4'] > 0.05)
        print(f"  {k:24s} u={pire['u']:.2f} <4m {pire['proche4']:.0%} <8m {pire['proche8']:.0%} ; dmin (12-88 %) {dmin} m ; points à plus de 5 % sous 4 m : {n4}/{len(coeur)}")
    sortie = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'captures', f'marge-{etiquette}.json')
    json.dump(r, open(sortie, 'w'), ensure_ascii=False, indent=0)
    print('erreurs :', len(err), err[:3])


asyncio.run(main())
