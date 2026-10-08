"""Micro-saccades (lot H) : ce qui arrive au GPU pendant les trajets, et les pics de durée d'image.

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/saccades.py <étiquette> [LARGEUR=480 HAUTEUR=300 Q=high]
Chargement réel (pas de ?test : kit progressif, ouverture), avec ?saccades=1 (ni résolution dynamique ni repli,
SwiftShader est lent). Le parcours entier est joué (approche -> lever, un geste par halte) ; à chaque image : durée
réelle, programmes de shaders, textures et géométries connus du GPU (renderer.info). Par trajet :
  prog / tex / géo  programmes compilés, textures et géométries envoyées pendant le trajet (une saccade chacun) ;
  pic               durée de la plus longue image / médiane des images du trajet (pic relatif, SwiftShader).
Écrit captures/saccades-<étiquette>.json. Lot H, 2026-10-02.
"""
import asyncio
import json
import os
import statistics
import sys

from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
L, H = int(os.environ.get('LARGEUR', '480')), int(os.environ.get('HAUTEUR', '300'))
Q = os.environ.get('Q', 'high')
HALTES = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']

ENREG = r"""
() => {
  window.__mes = [];
  let prec = performance.now();
  const S = window.__station;
  const f = (t) => {
    const e = S.etat;
    window.__mes.push([+(t - prec).toFixed(1), e.enRoute ? 1 : 0, e.halte, e.programmes || 0, e.textures || 0, e.geometries || 0, e.image]);
    prec = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}
"""


async def main():
    etiquette = sys.argv[1]
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': L, 'height': H}, device_scale_factor=1)).new_page()
        erreurs = []
        page.on('pageerror', lambda e: erreurs.append(str(e)))
        page.on('console', lambda m: erreurs.append(m.text) if m.type == 'error' else None)
        await page.goto(URL + f'?q={Q}&saccades=1', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=400000)
        await page.evaluate(ENREG)
        # fin de l'ouverture (glissement jusqu'à l'approche)
        await page.wait_for_function('!window.__station.etat.enRoute', timeout=900000, polling=500)
        await page.wait_for_timeout(1500)
        reperes = []
        for i in range(1, len(HALTES)):
            n0 = await page.evaluate('window.__mes.length')
            await page.evaluate(f'window.__station.aller("{HALTES[i]}", {{ anime: true }})')
            await page.wait_for_function('window.__station.etat.enRoute', timeout=60000, polling=100)
            await page.wait_for_function(f'!window.__station.etat.enRoute && window.__station.etat.halte === "{HALTES[i]}"', timeout=1800000, polling=200)
            n1 = await page.evaluate('window.__mes.length')
            reperes.append((HALTES[i - 1], HALTES[i], n0, n1))
            # à l'arrêt comme quelqu'un qui lit la carte : 16 images (environ 4 s du temps de la page, pas de 0,25 s)
            im = await page.evaluate('window.__station.etat.image')
            await page.wait_for_function(f'window.__station.etat.image >= {im} + 16', timeout=600000, polling=200)
            print('trajet', HALTES[i - 1], '>', HALTES[i], 'images', n1 - n0, flush=True)
        mes = await page.evaluate('window.__mes')
        await nav.close()
    bilan = []
    for de, vers, n0, n1 in reperes:
        i0 = next((k for k in range(n0, n1) if mes[k][1] == 1), None)
        if i0 is None:
            continue
        tr = [m for m in mes[i0:n1] if m[1] == 1]
        base = mes[i0 - 1] if i0 > 0 else tr[0]
        if len(tr) < 3:
            continue
        # la première image du trajet compte : le départ (reflets de la halte d'arrivée) se fait juste avant elle
        dts = [m[0] for m in tr]
        med = statistics.median(dts)
        d = {'trajet': f'{de}>{vers}', 'images': len(tr), 'mediane_ms': round(med, 1), 'max_ms': round(max(dts), 1),
             'pic': round(max(dts) / med, 2), 'images_lentes': sum(1 for x in dts if x > 2.5 * med),
             'programmes': tr[-1][3] - base[3], 'textures': tr[-1][4] - base[4], 'geometries': tr[-1][5] - base[5]}
        bilan.append(d)
        print(f"{d['trajet']:24s} images {d['images']:4d}  médiane {d['mediane_ms']:7.1f} ms  max {d['max_ms']:7.1f} ms  pic x{d['pic']:5.2f}  lentes {d['images_lentes']:3d}  prog +{d['programmes']}  tex +{d['textures']}  géo +{d['geometries']}")
    print('erreurs console :', len(erreurs), erreurs[:3])
    json.dump({'url': URL, 'taille': [L, H], 'q': Q, 'bilan': bilan, 'mesures': mes, 'erreurs': erreurs[:10]},
              open(os.path.join(ICI, '..', 'captures', f'saccades-{etiquette}.json'), 'w'), ensure_ascii=False)


asyncio.run(main())
