"""Captures et mesures du lot G (kit IA, lumière précalculée, reflets) : haltes à horloge figée (anneau
compris : figer() fixe aussi son angle), bureau 1440x900 au niveau haut et téléphone 390x844 au niveau bas.

Usage : URL=http://127.0.0.1:4343/ python3.11 tests/lotG.py <étiquette> <bureau|tel> [haltes|poids] [ui]
  haltes : les dix haltes (scène seule, cartes cachées sauf « ui »), appels de dessin et triangles par halte ;
  poids  : chargement réel (sans ?test) : octets transférés jusqu'à la première image, puis quand tous les
           objets du kit sont arrivés (CDP, encodedDataLength).
Écrit captures/lotG-<étiquette>/<format>-<halte>.png et <format>.json. Lot G, 2026-10-02.
"""
import asyncio
import json
import os
import sys
import time

from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(os.path.dirname(ICI), 'captures')
URL = os.environ.get('URL', 'http://127.0.0.1:4343/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
HALTES = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']
T = float(os.environ.get('HORLOGE', '30'))
FORMATS = {
    'bureau': (dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1), 'q=high&cube=512'),
    'tel': (dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True), 'q=low&cube=512'),
}
CACHER_UI = '#app > *:not(#scene), #app .halte, #app .halte * { visibility: hidden !important; }'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']


async def main():
    etiquette, fmt = sys.argv[1], sys.argv[2]
    quoi = sys.argv[3] if len(sys.argv) > 3 else 'haltes'
    avec_ui = 'ui' in sys.argv[4:]
    filtre = os.environ.get('SEULEMENT')
    dossier = os.path.join(SORTIE, 'lotG-' + etiquette)
    os.makedirs(dossier, exist_ok=True)
    opts, requete = FORMATS[fmt]
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=ARGS)
        ctx = await nav.new_context(**opts)
        page = await ctx.new_page()
        journal = []
        page.on('console', lambda m: journal.append({'type': m.type, 'texte': m.text}) if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: journal.append({'type': 'pageerror', 'texte': str(e)}))
        octets = {'total': 0, 'fichiers': {}}
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Network.enable')
        urls = {}
        cdp.on('Network.responseReceived', lambda e: urls.__setitem__(e['requestId'], e['response']['url']))
        def fini(e):
            octets['total'] += e.get('encodedDataLength', 0)
            u = urls.get(e['requestId'], '?').split('?')[0].rsplit('/', 1)[-1]
            octets['fichiers'][u] = octets['fichiers'].get(u, 0) + e.get('encodedDataLength', 0)
        cdp.on('Network.loadingFinished', fini)
        rapport = {'url': URL, 'format': fmt, 'horloge': T, 'images': {}}
        if quoi == 'poids':
            t0 = time.time()
            await page.goto(URL + '?' + requete, wait_until='load')
            await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=600000)
            rapport['premiere_image'] = {'octets': octets['total'], 's': round(time.time() - t0, 1)}
            await page.wait_for_function('window.__station.etat.kit && window.__station.etat.kit.pret', timeout=600000)
            await page.wait_for_timeout(1500)
            rapport['tout'] = {'octets': octets['total'], 's': round(time.time() - t0, 1)}
            # SwiftShader rend la page si lente que l'attente côté Python arrive après le chargement différé :
            # on compte côté page (Resource Timing) ce qui était arrivé à l'instant où la première image est prête
            rapport['resource_timing'] = await page.evaluate('''() => {
              const tP = window.__station.etat.tPret, R = performance.getEntriesByType('resource'), N = performance.getEntriesByType('navigation')[0];
              const somme = (f) => R.filter(f).reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0);
              const doc = N ? (N.transferSize || N.encodedBodySize || 0) : 0;
              return { tPret: tP, avant_premiere_image: doc + somme((r) => r.responseEnd <= tP), total: doc + somme(() => true),
                apres: R.filter((r) => r.responseEnd > tP).map((r) => r.name.split('/').pop()) };
            }''')
            print(fmt, 'resource_timing', json.dumps({k: v for k, v in rapport['resource_timing'].items() if k != 'apres'}), len(rapport['resource_timing']['apres']), 'fichiers après', flush=True)
            rapport['fichiers'] = dict(sorted(octets['fichiers'].items(), key=lambda kv: -kv[1]))
            rapport['etat'] = await page.evaluate('JSON.parse(JSON.stringify({kit: window.__station.etat.kit, lumiere: window.__station.etat.lumiere, reflets: window.__station.etat.reflets, niveau: window.__station.etat.niveau}))')
            print(fmt, 'poids', json.dumps({k: rapport[k] for k in ('premiere_image', 'tout')}), flush=True)
        else:
            await page.goto(URL + '?test=1&' + requete, wait_until='load')
            await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=600000)
            rapport['chargement_octets'] = octets['total']
            if not avec_ui:
                await page.add_style_tag(content=CACHER_UI)
            rapport['rendu'] = await page.evaluate('window.__station.etat.rendu')
            rapport['niveau'] = await page.evaluate('window.__station.etat.niveau')
            rapport['kit'] = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat.kit || null))')
            rapport['lumiere'] = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat.lumiere || null))')
            for h in HALTES:
                if filtre and h not in filtre.split(','):
                    continue
                await page.evaluate(f'(() => {{ const S = window.__station; S.figer({T}); S.aller("{h}"); S.figer({T}); }})()')
                n0 = await page.evaluate('window.__station.etat.image')
                await page.wait_for_function(f'window.__station.etat.image >= {n0} + 2', timeout=600000)
                if avec_ui:
                    await page.wait_for_timeout(2600)
                etat = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat))')
                await page.screenshot(path=os.path.join(dossier, f'{fmt}-{h}.png'), timeout=600000)
                rapport['images'][h] = {k: etat.get(k) for k in ('appels', 'triangles', 'dpr')}
                print(fmt, h, rapport['images'][h], flush=True)
        rapport['erreurs'] = [j for j in journal if j['type'] in ('error', 'pageerror')]
        rapport['avertissements'] = [j for j in journal if j['type'] == 'warning'][:20]
        chemin = os.path.join(dossier, f'{fmt}{"-poids" if quoi == "poids" else ""}.json')
        if filtre and os.path.exists(chemin):
            try:
                ancien = json.load(open(chemin))
                ancien['images'].update(rapport['images'])
                rapport['images'] = ancien['images']
            except Exception:
                pass
        json.dump(rapport, open(chemin, 'w'), ensure_ascii=False, indent=1)
        print(fmt, 'erreurs console :', len(rapport['erreurs']), [e['texte'][:200] for e in rapport['erreurs'][:5]],
              'avertissements :', len(rapport['avertissements']), flush=True)
        await nav.close()


asyncio.run(main())
