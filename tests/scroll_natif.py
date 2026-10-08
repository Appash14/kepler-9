"""Scroll natif tactile, molette, haltes, ancres, resize et mouvement réduit.
URL=http://127.0.0.1:4346/ python3.11 tests/scroll_natif.py
"""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
OUT = Path(__file__).resolve().parent.parent / 'captures' / 'scroll-natif'
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
READ = '''() => ({top: document.scrollingElement.scrollTop, height: document.scrollingElement.scrollHeight,
  viewport: document.documentElement.clientHeight, halte: window.__station.halte,
  route: window.__station.etat.enRoute, canvas: getComputedStyle(document.querySelector('#scene')).position,
  touchAction: getComputedStyle(document.querySelector('#app')).touchAction,
  overflow: [document.documentElement, document.body].map(e => getComputedStyle(e).overflowY)})'''
async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    result = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        ctx = await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL+'?test=1&q=low&cube=128')
        await page.wait_for_function('window.__station?.etat.pret',timeout=240000)
        await page.wait_for_timeout(1500)
        result['before'] = await page.evaluate(READ)
        await page.screenshot(path=str(OUT/'avant-scroll.png'),timeout=120000)
        cdp = await ctx.new_cdp_session(page)
        # Vrai geste tactile dans Chromium, aucun scrollTo pour la preuve.
        await cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':190,'y':710}]})
        for y in range(670,149,-40):
            await cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':190,'y':y}]})
            await page.wait_for_timeout(40)
        await cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
        await page.wait_for_function('document.scrollingElement.scrollTop > 100',timeout=10000)
        result['touch'] = await page.evaluate(READ)
        await page.screenshot(path=str(OUT/'apres-scroll.png'),timeout=120000)
        assert result['touch']['top'] > result['before']['top']
        assert result['touch']['canvas'] == 'fixed'
        assert result['touch']['touchAction'] != 'none'
        assert all(x != 'hidden' for x in result['touch']['overflow'])
        await page.wait_for_function('window.__station.halte !== "approche" && !window.__station.etat.enRoute',timeout=180000)
        result['arrival'] = await page.evaluate(READ)
        # API et rail doivent réaligner le document, puis permettre le retour par molette.
        await page.evaluate('window.__station.aller("serre")')
        await page.wait_for_timeout(400)
        result['direct'] = await page.evaluate(READ)
        print(json.dumps(result), flush=True)
        assert result['direct']['top'] > result['touch']['top']
        await page.mouse.move(190,400)
        await page.mouse.wheel(0,-1000)
        await page.wait_for_function("top => document.scrollingElement.scrollTop < top", arg=result['direct']['top'], timeout=30000)
        result['wheel'] = await page.evaluate(READ)
        assert result['wheel']['top'] < result['direct']['top']
        await ctx.close()
        ctx = await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce')
        page = await ctx.new_page()
        page.on('pageerror',lambda e: errors.append(str(e)))
        await page.goto(URL+'?test=1&q=low&cube=128#serre')
        await page.wait_for_function('window.__station?.etat.pret',timeout=240000)
        result['anchor'] = await page.evaluate(READ)
        assert result['anchor']['halte'] == 'serre' and result['anchor']['top'] > 0
        await page.set_viewport_size({'width':390,'height':720})
        await page.wait_for_timeout(600)
        assert await page.evaluate('window.__station.halte') == 'serre'
        await page.locator('.rail a[data-halte="lever"]').click()
        await page.wait_for_function('window.__station.halte === "lever"',timeout=30000)
        await page.wait_for_function('getComputedStyle(document.querySelector(".fondu")).opacity === "0"',timeout=90000)
        await page.keyboard.press('Home')
        await page.wait_for_function('window.__station.halte === "approche"',timeout=30000)
        await page.wait_for_function('getComputedStyle(document.querySelector(".fondu")).opacity === "0"',timeout=90000)
        result['home'] = await page.evaluate(READ)
        assert result['home']['top'] == 0
        await page.keyboard.press('End')
        await page.wait_for_function('window.__station.halte === "lever"',timeout=30000)
        await page.wait_for_function('getComputedStyle(document.querySelector(".fondu")).opacity === "0"',timeout=90000)
        result['end'] = await page.evaluate(READ)
        assert abs(result['end']['height']-result['end']['viewport']-result['end']['top']) <= 1
        await page.goto(URL+'?lite=1')
        assert await page.locator('.halte').count() == 10
        assert await page.evaluate('document.scrollingElement.scrollHeight > innerHeight')
        assert not errors, errors
        result['errors'] = errors
        await browser.close()
    (OUT/'rapport.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))
asyncio.run(main())
