"""Travelling à l'arrêt : la caméra qui glisse à chaque halte ne doit jamais entrer dans la structure.
Usage : URL=http://127.0.0.1:4340/ python3.11 tests/travelling.py
Pour chaque halte : rig posé, puis 90 s simulées (respiration pleine), test du voxel occupé et
amplitude du mouvement (m). 2026-10-02.
Lot F : contrôle aussi sur la grille fine de 1 m (grille1m = instants passés dans un voxel occupé).
"""
import asyncio, json, os
from playwright.async_api import async_playwright
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
H = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']
JS = r"""
async (H) => {
  const S = window.__station, rig = S.rig, cam = S.camera, occ = S.occupation, T = S.THREE;
  S.degeler && S.degeler();
  const res = {};
  for (let i = 0; i < H.length; i++) {
    S.aller(H[i]); rig.annuler(); rig.reamorcer(); rig.maj(0, 0, { reduit: false, instantane: true });
    rig.etat.tArrivee = 0; rig.etat.respiration = 1;
    const p0 = cam.position.clone(); let maxd = 0; const touche = [], fin = [];
    const G = window.__grille, ax = S.station.axeAnneau.clone().normalize();
    const q0 = (p, g) => {
      const i = Math.floor((p.x - G.min.x) / G.taille), j = Math.floor((p.y - G.min.y) / G.taille), k = Math.floor((p.z - G.min.z) / G.taille);
      if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) return 0;
      return g[i + G.nx * (j + G.ny * k)];
    };
    const fine = (p) => q0(p, G.fixe) || q0(p.clone().applyAxisAngle(ax, -S.station.angleAnneau), G.tourne);
    for (let k = 0; k <= 900; k++) {
      const t = k * 0.1;
      rig.maj(t, 0.1, { reduit: false, instantane: false });
      rig.etat.respiration = 1;
      maxd = Math.max(maxd, cam.position.distanceTo(p0));
      if (occ && occ.occupe(cam.position, false)) touche.push(+t.toFixed(1));
      if (fine(cam.position)) fin.push(+t.toFixed(1));
    }
    res[H[i]] = { deplacement_max_m: +maxd.toFixed(2), dans_structure_s: touche.slice(0, 8), n: touche.length, grille1m: fin.length };
  }
  return res;
}
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        err = []
        pg.on('pageerror', lambda e: err.append(str(e)))
        await pg.goto(URL + '?test=1', wait_until='load')
        await pg.wait_for_function('window.__station && window.__station.rig && window.__station.occupation', timeout=240000)
        # grille fine de 1 m (celle de tests/camera.py) : la grille de 3 m marque la serre et l'observatoire
        # occupés dès la pose ; la grille fine dit si le travelling entre vraiment dans la structure
        import re
        grille = re.search(r'GRILLE = r"""(.*?)"""', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'camera.py')).read(), re.S).group(1)
        await pg.evaluate('(' + grille + ')()')
        r = await pg.evaluate(JS, H)
        for k, v in r.items():
            print(f'{k:14s} {v}')
        print('erreurs page :', len(err), err[:3])
        await b.close()
asyncio.run(main())
