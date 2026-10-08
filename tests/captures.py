"""Captures de chaque halte avec Playwright (Chromium, WebGL logiciel SwiftShader).

Usage : python3.11 tests/captures.py [bureau|mobile|mobile412|tout] [haltes séparées par des virgules] [requête]
Écrit captures/<format>/<halte>.png et captures/<format>/rapport.json (console, appels de dessin).
Sous SwiftShader, les images par seconde ne veulent rien dire : seules comptent les erreurs.
"""
import asyncio
import json
import os
import sys
import time

from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(os.path.dirname(ICI), 'captures')
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')  # URL=http://127.0.0.1:4341/ pour le serveur de dev
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
HALTES = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']
FORMATS = {
    'bureau': dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1, is_mobile=False, has_touch=False),
    'mobile': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True),
    # Android courant (Samsung Galaxy S2x : 412x915 CSS, DPR 2,625)
    'mobile412': dict(viewport={'width': 412, 'height': 915}, device_scale_factor=2.625, is_mobile=True, has_touch=True),
}


async def capturer(nom, haltes, requete, attente_ms):
    dossier = nom + os.environ.get('SUFFIXE', '')
    os.makedirs(os.path.join(SORTIE, dossier), exist_ok=True)
    async with async_playwright() as p:
        nav = await p.chromium.launch(
            executable_path=CHROME,
            args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        )
        ctx = await nav.new_context(**FORMATS[nom])
        page = await ctx.new_page()
        glb = os.environ.get('GLB')
        if glb:
            donnees = open(glb, 'rb').read()
            async def servir(route):
                await route.fulfill(status=200, body=donnees, headers={'content-type': 'model/gltf-binary', 'content-length': str(len(donnees))})
            await page.route('**/assets/station.glb', servir)
        journal = []
        page.on('console', lambda m: journal.append({'type': m.type, 'texte': m.text}))
        page.on('pageerror', lambda e: journal.append({'type': 'pageerror', 'texte': str(e)}))
        t0 = time.time()
        await page.goto(URL + requete, wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=240000)
        rapport = {'format': nom, 'requete': requete, 'chargement_s': round(time.time() - t0, 1), 'haltes': {}}
        etat0 = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat))')
        rapport['glb'] = etat0['glb']
        rapport['rendu'] = etat0.get('rendu')
        rapport['niveau'] = etat0['niveau']
        rapport['sources'] = etat0['sources']
        rapport['fusion'] = await page.evaluate('window.__station.etat.fusion || null')
        rapport['occupation'] = await page.evaluate('window.__station.etat.occupation || null')
        rapport['navetteCadrage'] = await page.evaluate('window.__station.etat.navetteCadrage || null')
        for h in haltes:
            await page.evaluate(f'window.__station.aller("{h}")')
            await page.wait_for_timeout(attente_ms)
            # compteurs lus après au moins trois images rendues à cette halte
            n0 = await page.evaluate('window.__station.etat.image')
            await page.wait_for_function(f'window.__station.etat.image >= {n0} + 3', timeout=180000)
            etat = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat))')
            chemin = os.path.join(SORTIE, dossier, f'{h}.png')
            await page.screenshot(path=chemin, timeout=180000)
            rapport['haltes'][h] = {k: etat.get(k) for k in ('appels', 'triangles', 'ips', 'dpr', 'soleil', 'navette')}
            print(nom, h, rapport['haltes'][h], flush=True)
        rapport['console'] = journal
        rapport['erreurs'] = [j for j in journal if j['type'] in ('error', 'pageerror')]
        # une passe partielle complète le rapport existant au lieu de l'écraser
        chemin_r = os.path.join(SORTIE, dossier, 'rapport.json')
        if len(haltes) < len(HALTES) and os.path.exists(chemin_r):
            try:
                ancien = json.load(open(chemin_r))
                ancien.get('haltes', {}).update(rapport['haltes'])
                rapport['haltes'] = ancien['haltes']
            except Exception:
                pass
        with open(chemin_r, 'w') as f:
            json.dump(rapport, f, ensure_ascii=False, indent=1)
        print(nom, 'erreurs console :', len(rapport['erreurs']), flush=True)
        for e in rapport['erreurs'][:12]:
            print('  ', e['type'], e['texte'][:300], flush=True)
        await nav.close()


async def trajets(fractions):
    """Captures figées au milieu de chaque trajet (960x600), pour vérifier les chemins de caméra."""
    dossier = 'trajets' + os.environ.get('SUFFIXE', '')
    os.makedirs(os.path.join(SORTIE, dossier), exist_ok=True)
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME,
            args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': 960, 'height': 600})).new_page()
        glb = os.environ.get('GLB')
        if glb:
            donnees = open(glb, 'rb').read()
            async def servir(route):
                await route.fulfill(status=200, body=donnees, headers={'content-type': 'model/gltf-binary'})
            await page.route('**/assets/station.glb', servir)
        journal = []
        page.on('pageerror', lambda e: journal.append(str(e)))
        page.on('console', lambda m: journal.append(m.text) if m.type == 'error' else None)
        await page.goto(URL + '?test=1&q=high&cube=256', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=240000)
        for a, b in zip(HALTES, HALTES[1:]):
            for u in fractions:
                await page.evaluate(f'window.__station.trajet("{a}", "{b}", {u})')
                await page.wait_for_timeout(1500)
                await page.screenshot(path=os.path.join(SORTIE, dossier, f'{a}-{b}-{int(u * 100):02d}.png'), timeout=180000)
                print('trajet', a, b, u, flush=True)
        print('erreurs :', journal[:10], flush=True)
        await nav.close()


async def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'trajets':
        fr = [float(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '0.5').split(',')]
        await trajets(fr)
        return
    quoi = sys.argv[1] if len(sys.argv) > 1 else 'bureau'
    haltes = sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else HALTES
    requete = sys.argv[3] if len(sys.argv) > 3 else '?test=1&q=high&cube=512'
    attente = int(os.environ.get('ATTENTE_MS', '3500'))
    for nom in (['bureau', 'mobile'] if quoi == 'tout' else [quoi]):
        await capturer(nom, haltes, requete, attente)


asyncio.run(main())
