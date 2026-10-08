"""Captures reproductibles (lot F) : haltes et trajets à horloge figée, pour comparer deux versions pixel à pixel.

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/lotF.py <étiquette> <bureau|tel> [haltes|trajets|tout|points] [ui]
  POINTS="approche>anneaux@0.9;serre>forge@0.15" ajoute des points de trajet (seuls avec « points »).
  - haltes : les dix haltes, caméra posée sans respiration ni travelling, horloge figée à T = 30 s ;
  - trajets : les points de trajet de la liste TRAJETS ci-dessous ;
  - ui : garder l'interface (cartes) ; sans ce mot, seule la scène 3D est capturée (comparaison exacte).
Écrit captures/lotF-<étiquette>/<format>-<nom>.png et <format>.json (appels, triangles, rendu, erreurs).
bureau = 1440x900, niveau haut ; tel = 390x844 (DPR 2, tactile), niveau bas (celui d'un téléphone).
Lot F, 2026-10-02.
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(os.path.dirname(ICI), 'captures')
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
HALTES = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']
T = float(os.environ.get('HORLOGE', '30'))
# points de trajet regardés dans le clip de Tom (passages qui frôlaient la structure)
TRAJETS = [(a, b, u) for (a, b) in zip(HALTES, HALTES[1:]) for u in (0.3, 0.6)]
FORMATS = {
    'bureau': (dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1), '?test=1&q=high&cube=512'),
    'tel': (dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True), '?test=1&q=low&cube=512'),
}
CACHER_UI = '#app > *:not(#scene), #app .halte, #app .halte * { visibility: hidden !important; }'


async def main():
    etiquette, fmt = sys.argv[1], sys.argv[2]
    quoi = sys.argv[3] if len(sys.argv) > 3 else 'tout'
    avec_ui = 'ui' in sys.argv[4:]
    filtre = os.environ.get('SEULEMENT')  # noms séparés par des virgules
    dossier = os.path.join(SORTIE, 'lotF-' + etiquette)
    os.makedirs(dossier, exist_ok=True)
    opts, requete = FORMATS[fmt]
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(**opts)).new_page()
        journal = []
        page.on('console', lambda m: journal.append({'type': m.type, 'texte': m.text}) if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: journal.append({'type': 'pageerror', 'texte': str(e)}))
        await page.goto(URL + requete, wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=300000)
        if not avec_ui:
            await page.add_style_tag(content=CACHER_UI)
        rapport = {'url': URL, 'format': fmt, 'horloge': T, 'images': {}}
        rapport['rendu'] = await page.evaluate('window.__station.etat.rendu')
        rapport['niveau'] = await page.evaluate('window.__station.etat.niveau')
        plan = []
        if quoi in ('haltes', 'tout'):
            plan += [('halte', h, None, None) for h in HALTES]
        if quoi in ('trajets', 'tout'):
            plan += [('trajet', a, b, u) for (a, b, u) in TRAJETS]
        # POINTS="approche>anneaux@0.9;serre>forge@0.15" : points de trajet en plus (ou seuls avec quoi=points)
        for x in filter(None, os.environ.get('POINTS', '').split(';')):
            ab, u = x.split('@')
            a, b = ab.split('>')
            plan.append(('trajet', a, b, float(u)))
        for genre, a, b, u in plan:
            nom = a if genre == 'halte' else f'{a}-{b}-{int(round(u * 100)):02d}'
            if filtre and nom not in filtre.split(','):
                continue
            if genre == 'halte':
                await page.evaluate(f'(() => {{ const S = window.__station; S.figer({T}); S.aller("{a}"); S.figer({T}); }})()')
            else:
                await page.evaluate(f'(() => {{ const S = window.__station; S.figer({T}); S.trajet("{a}", "{b}", {u}); }})()')
            n0 = await page.evaluate('window.__station.etat.image')
            await page.wait_for_function(f'window.__station.etat.image >= {n0} + 2', timeout=300000)
            if avec_ui:
                await page.wait_for_timeout(2600)
            etat = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat))')
            await page.screenshot(path=os.path.join(dossier, f'{fmt}-{nom}.png'), timeout=300000)
            rapport['images'][nom] = {k: etat.get(k) for k in ('appels', 'triangles', 'dpr')}
            print(fmt, nom, rapport['images'][nom], flush=True)
        rapport['erreurs'] = [j for j in journal if j['type'] in ('error', 'pageerror')]
        rapport['avertissements'] = [j for j in journal if j['type'] == 'warning'][:20]
        chemin = os.path.join(dossier, f'{fmt}.json')
        if filtre and os.path.exists(chemin):
            try:
                ancien = json.load(open(chemin))
                ancien['images'].update(rapport['images'])
                rapport['images'] = ancien['images']
            except Exception:
                pass
        json.dump(rapport, open(chemin, 'w'), ensure_ascii=False, indent=1)
        print(fmt, 'rendu', rapport['rendu'], 'erreurs console :', len(rapport['erreurs']), [e['texte'][:200] for e in rapport['erreurs'][:5]], flush=True)
        await nav.close()


asyncio.run(main())
