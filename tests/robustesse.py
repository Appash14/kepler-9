"""Robustesse : version texte, navigateur sans WebGL, mouvement réduit, JavaScript coupé.

Usage : python3.11 tests/robustesse.py
Écrit captures/robustesse/*.png et captures/robustesse/rapport.json.
"""
import asyncio
import json
import os

from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(os.path.dirname(ICI), 'captures', 'robustesse' + os.environ.get('SUFFIXE', ''))
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')  # URL=... pour un autre serveur
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']


async def page_neuve(p, args, **ctx):
    nav = await p.chromium.launch(executable_path=CHROME, args=args)
    contexte = await nav.new_context(viewport={'width': 1440, 'height': 900}, **ctx)
    page = await contexte.new_page()
    journal = []
    page.on('console', lambda m: journal.append({'type': m.type, 'texte': m.text}))
    page.on('pageerror', lambda e: journal.append({'type': 'pageerror', 'texte': str(e)}))
    return nav, page, journal


async def main():
    os.makedirs(SORTIE, exist_ok=True)
    res = {}
    async with async_playwright() as p:
        # 1. version texte demandée
        nav, page, j = await page_neuve(p, GL)
        await page.goto(URL + '?lite=1&repli=choix')
        await page.wait_for_timeout(1500)
        res['texte'] = await page.evaluate('''() => ({
            classe: document.getElementById('app').className,
            haltesVisibles: [...document.querySelectorAll('.halte')].filter(e => e.offsetHeight > 0).length,
            raison: document.querySelector('.repli-raison').textContent.trim(),
            canvasAffiche: getComputedStyle(document.getElementById('scene')).display })''')
        await page.screenshot(path=os.path.join(SORTIE, 'version-texte.png'))
        res['texte']['erreurs'] = [x for x in j if x['type'] in ('error', 'pageerror')]
        await nav.close()

        # 2. navigateur sans WebGL : repli automatique
        nav, page, j = await page_neuve(p, ['--disable-webgl', '--disable-3d-apis', '--disable-gpu'])
        await page.goto(URL)
        await page.wait_for_timeout(1500)
        res['sansWebGL'] = await page.evaluate('''() => ({
            classe: document.getElementById('app').className,
            haltesVisibles: [...document.querySelectorAll('.halte')].filter(e => e.offsetHeight > 0).length,
            raison: document.querySelector('.repli-raison').textContent.trim() })''')
        await page.screenshot(path=os.path.join(SORTIE, 'sans-webgl.png'))
        res['sansWebGL']['erreurs'] = [x for x in j if x['type'] in ('error', 'pageerror')]
        await nav.close()

        # 3. JavaScript coupé : le carnet se lit tel quel
        nav, page, j = await page_neuve(p, GL, java_script_enabled=False)
        await page.goto(URL)
        await page.wait_for_timeout(800)
        res['sansJS'] = {'haltesVisibles': await page.locator('.halte').count()}
        await page.screenshot(path=os.path.join(SORTIE, 'sans-js.png'), full_page=False)
        await nav.close()

        # 4. mouvement réduit : navigation par fondu, sans trajet de caméra
        nav, page, j = await page_neuve(p, GL, reduced_motion='reduce')
        await page.goto(URL + '?test=1&q=low&cube=256')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=240000)
        await page.evaluate('window.__station.aller("anneaux", { anime: true })')
        await page.wait_for_timeout(500)
        en_route = await page.evaluate('window.__station.etat.enRoute')
        await page.wait_for_timeout(6000)
        res['mouvementReduit'] = {
            'halteApres': await page.evaluate('window.__station.halte'),
            'trajetCameraPendantLeFondu': en_route,
        }
        await page.screenshot(path=os.path.join(SORTIE, 'mouvement-reduit.png'), timeout=180000)
        res['mouvementReduit']['erreurs'] = [x for x in j if x['type'] in ('error', 'pageerror')]
        await nav.close()

    with open(os.path.join(SORTIE, 'rapport.json'), 'w') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))


asyncio.run(main())
