"""Film d'un trajet (lot H) : images successives à 30 images/s simulées, planche, vidéo et mesures du ressenti.

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/film.py <étiquette> <de>><vers> [<de>><vers> ...]
  ANGLE=<s> : horloge (donc angle de l'anneau) au départ, défaut 30 ; LARGEUR=480 HAUTEUR=300 ; Q=low ;
  PAS=5 : une image sur PAS dans la planche ; ATTENTE=1.5 : secondes passées à la halte avant de partir.
L'horloge de la page est remplacée par une horloge simulée (performance.now) : chaque image avance de 1/30 s,
le vrai rig tourne (lissage, visée bornée, anneau qui tourne), puis la capture est prise. Écrit dans
captures/film-<étiquette>/<de>-<vers>/ : images (jpg), planche.jpg, film.mp4, mesures.json. Mesures par image :
  visée     vitesse angulaire de la direction de visée (°/s), dans le repère du monde ;
  roulis    rotation autour de l'axe de visée (°/s), monde, et dans le repère de l'anneau (qui tourne) ;
  inclin.   angle du haut de l'image avec la verticale du monde (projetée dans l'image), en degrés ;
  image     écart moyen entre deux images successives (0 à 255, réduites à 120x75) : le « changement de cadrage ».
Lot H, 2026-10-02.
"""
import asyncio
import json
import math
import os
import subprocess
import sys

import numpy as np
from playwright.async_api import async_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(os.path.dirname(ICI), 'captures')
URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
L, H = int(os.environ.get('LARGEUR', '480')), int(os.environ.get('HAUTEUR', '300'))
Q = os.environ.get('Q', 'low')
T0 = float(os.environ.get('ANGLE', '30'))
PAS = int(os.environ.get('PAS', '5'))
# MESURE_SEULE=1 : pas d'images (mesures seules, rapide) ; ANGLES=30,40,50 : plusieurs angles de départ
SEULE = os.environ.get('MESURE_SEULE') == '1'
ATTENTE = float(os.environ.get('ATTENTE', '1.5'))
FPS = 30
CACHER_UI = '#app > *:not(#scene), #app .halte, #app .halte * { visibility: hidden !important; }'

HORLOGE = r"""
() => {
  if (window.__horloge) return;
  const vrai = performance.now.bind(performance);
  let t = vrai();
  performance.now = () => t;
  window.__horloge = { avancer: (s) => { t += s * 1000; } };
}
"""

ETAT = r"""
() => {
  const S = window.__station, c = S.camera, st = S.station;
  c.updateMatrixWorld();
  return { p: c.position.toArray(), q: c.quaternion.toArray(), a: st.angleAnneau, ax: st.axeAnneau.toArray(),
    u: S.rig.trajet ? S.rig.trajet.u : 1, enRoute: !!S.rig.trajet, image: S.etat.image, fov: c.fov };
}
"""


def qmul(a, b):
    x1, y1, z1, w1 = a
    x2, y2, z2, w2 = b
    return np.array([w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2])


def qinv(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def qrot(q, v):
    p = np.array([v[0], v[1], v[2], 0.0])
    return qmul(qmul(q, p), qinv(q))[:3]


def qaxe(ax, ang):
    s = math.sin(ang / 2)
    return np.array([ax[0] * s, ax[1] * s, ax[2] * s, math.cos(ang / 2)])


def vitesse_ang(q0, q1, dt):
    """vitesse angulaire (rad/s) dans le repère de la caméra : x tangage, y lacet, z roulis"""
    dq = qmul(qinv(q0), q1)
    if dq[3] < 0:
        dq = -dq
    s = min(1.0, float(np.linalg.norm(dq[:3])))
    if s < 1e-12:
        return np.zeros(3)
    ang = 2 * math.asin(s)
    return dq[:3] / s * ang / dt


def inclinaison(q, haut_ref):
    """angle (degrés) entre le haut de l'image et la verticale de référence projetée dans l'image"""
    v = qrot(q, [0, 0, -1])
    up = qrot(q, [0, 1, 0])
    right = qrot(q, [1, 0, 0])
    h = np.array(haut_ref, dtype=float)
    h = h - v * h.dot(v)
    if np.linalg.norm(h) < 1e-6:
        return float('nan')
    return math.degrees(math.atan2(h.dot(right), h.dot(up)))


def gris(chemin):
    out = subprocess.run(['convert', chemin, '-resize', '120x75!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.uint8).astype(np.float32)


def mesurer(etats, dossier):
    dt = 1 / FPS
    ax = np.array(etats[0]['ax'])
    series = []
    prec_img = None
    for k, e in enumerate(etats):
        q = np.array(e['q'])
        rq = qmul(qaxe(ax, -e['a']), q)  # orientation dans le repère de l'anneau
        img = None if SEULE else gris(os.path.join(dossier, f'{k:04d}.jpg'))
        d = {'t': round(k * dt, 3), 'u': round(e['u'], 4), 'p': e['p'], 'q': e['q'], 'a': e['a'],
             'inclin': round(inclinaison(q, [0, 1, 0]), 2)}
        if k > 0:
            q0 = np.array(etats[k - 1]['q'])
            rq0 = qmul(qaxe(ax, -etats[k - 1]['a']), q0)
            w = vitesse_ang(q0, q, dt)
            wr = vitesse_ang(rq0, rq, dt)
            v0 = qrot(q0, [0, 0, -1])
            v1 = qrot(q, [0, 0, -1])
            d['visee'] = round(math.degrees(math.acos(max(-1.0, min(1.0, float(v0.dot(v1)))))) / dt, 2)
            d['roulis'] = round(math.degrees(w[2]), 2)
            d['roulisAnneau'] = round(math.degrees(wr[2]), 2)
            d['rotation'] = round(math.degrees(float(np.linalg.norm(w))), 2)
            d['rotationAnneau'] = round(math.degrees(float(np.linalg.norm(wr))), 2)
            d['vitesse'] = round(float(np.linalg.norm(np.array(e['p']) - np.array(etats[k - 1]['p']))) / dt, 2)
            if img is not None:
                d['image'] = round(float(np.abs(img - prec_img).mean()), 2)
        prec_img = img
        series.append(d)
    en_route = [s for s in series[1:] if s['u'] < 1 or s is series[1]]
    def pire(c):
        vals = [abs(s[c]) for s in series[1:] if c in s]
        return round(max(vals), 1) if vals else 0
    # accélération angulaire (°/s²) lissée sur 3 images
    w = [np.array([s.get('rotation', 0)]) for s in series]
    roul = np.array([s.get('roulis', 0) for s in series[1:]])
    inc = np.array([s['inclin'] for s in series])
    inc_d = np.unwrap(np.radians(inc))
    resume = {
        'images': len(series), 'duree_s': round(len(series) / FPS, 2),
        'visee_max': pire('visee'), 'rotation_max': pire('rotation'), 'roulis_max': pire('roulis'),
        'roulis_anneau_max': pire('roulisAnneau'), 'rotation_anneau_max': pire('rotationAnneau'),
        'vitesse_max': pire('vitesse'), 'image_max': pire('image'),
        'image_moy': round(float(np.mean([s['image'] for s in series[1:]])), 2) if not SEULE else 0,
        'roulis_total': round(float(np.sum(np.abs(roul)) / FPS), 1),
        'inclin_debut': round(float(inc[0]), 1), 'inclin_fin': round(float(inc[-1]), 1),
        'inclin_parcours': round(float(np.degrees(inc_d.max() - inc_d.min())), 1),
        'acc_roulis_max': round(float(np.max(np.abs(np.diff(roul[::1])))) * FPS, 1) if len(roul) > 2 else 0,
        'duree_trajet': next((e['duree'] for e in etats if e.get('duree')), None),
        'tour_deg': next((round(math.degrees(e['total']), 1) for e in etats if e.get('total') is not None), None),
    }
    return series, resume


PAS_JS = r"""
async (avec) => {
  const S = window.__station;
  window.__horloge.avancer(1 / 30);
  S.boucle();
  const c = S.camera, st = S.station;
  c.updateMatrixWorld();
  const e = { p: c.position.toArray(), q: c.quaternion.toArray(), a: st.angleAnneau, ax: st.axeAnneau.toArray(),
    u: S.rig.trajet ? S.rig.trajet.u : 1, enRoute: !!S.rig.trajet, image: S.etat.image, fov: c.fov };
  if (avec) e.jpg = S.renderer.domElement.toDataURL('image/jpeg', 0.84);
  return e;
}
"""


RAPIDE_JS = r"""
async ([de, vers, T0, attente]) => {
  // mesures seules : le rig et l'animation de la station pas à pas, sans rendu (comme tests/camera.py)
  const S = window.__station, rig = S.rig, st = S.station, cam = S.camera;
  const dt = 1 / 30, H = S.haltes;
  S.renderer.setAnimationLoop(null);
  S.figer(T0); S.aller(de); S.figer(T0);
  rig.annuler(); rig.reamorcer();
  let t = T0;
  st.fixerAngle(T0);
  rig.maj(t, 0, { reduit: false, instantane: true });
  for (let n = 0; n < attente * 30; n++) { t += dt; st.animer(t, dt, { signal: 0, pixel: 1, camera: null }); rig.maj(t, dt, { reduit: false, instantane: false }); }
  rig.demarrer(H.indexOf(de), H.indexOf(vers), t);
  const out = [];
  let fin = -1;
  for (let n = 0; n < 30 * 30; n++) {
    t += dt;
    st.animer(t, dt, { signal: 0, pixel: 1, camera: null });
    rig.maj(t, dt, { reduit: false, instantane: false });
    cam.updateMatrixWorld();
    out.push({ p: cam.position.toArray(), q: cam.quaternion.toArray(), a: st.angleAnneau, ax: st.axeAnneau.toArray(),
      u: rig.trajet ? rig.trajet.u : 1, enRoute: !!rig.trajet, duree: rig.trajet ? rig.trajet.duree : null,
      total: rig.trajet && rig.trajet.tourTotal != null ? rig.trajet.tourTotal : null });
    if (!rig.enRoute && fin < 0) fin = n;
    if (fin >= 0 && n > fin + 15) break;
  }
  return out;
}
"""


async def filmer(page, de, vers, dossier):
    if SEULE:
        os.makedirs(dossier, exist_ok=True)
        return await page.evaluate(RAPIDE_JS, [de, vers, T0, ATTENTE])
    import base64
    os.makedirs(dossier, exist_ok=True)
    for f in os.listdir(dossier):
        if f.endswith('.jpg'):
            os.remove(os.path.join(dossier, f))
    # boucle d'animation arrêtée : une image par pas, rendue à la demande (horloge simulée)
    await page.evaluate('window.__station.renderer.setAnimationLoop(null)')
    await page.evaluate(f'(() => {{ const S = window.__station; S.figer({T0}); S.aller("{de}"); S.figer({T0}); S.degeler(); }})()')
    for _ in range(int(ATTENTE * FPS)):
        await page.evaluate(PAS_JS, False)
    await page.evaluate(f'window.__station.aller("{vers}", {{ anime: true }})')
    etats = []
    k = 0
    apres = -1
    while True:
        e = await page.evaluate(PAS_JS, not SEULE)
        if not SEULE:
            with open(os.path.join(dossier, f'{k:04d}.jpg'), 'wb') as f:
                f.write(base64.b64decode(e.pop('jpg').split(',', 1)[1]))
        etats.append(e)
        k += 1
        if not e['enRoute'] and apres < 0:
            apres = k
        if apres >= 0 and k >= apres + 15:
            break
        if k > FPS * 30:
            break
    return etats


def planche(dossier, n, titre):
    choix = list(range(0, n, PAS))
    if choix[-1] != n - 1:
        choix.append(n - 1)
    args = ['montage']
    for k in choix:
        args += ['-label', f'{k / FPS:.1f} s', os.path.join(dossier, f'{k:04d}.jpg')]
    args += ['-tile', '8x', '-geometry', '240x150+2+2', '-background', '#070b16', '-fill', '#efe6d2', '-pointsize', '11',
             '-title', titre, '-quality', '80', os.path.join(dossier, 'planche.jpg')]
    subprocess.run(args, check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(dossier, '%04d.jpg'),
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', os.path.join(dossier, 'film.mp4')], check=True)


async def main():
    etiquette = sys.argv[1]
    paires = [x.split('>') for x in sys.argv[2:]]
    racine = os.path.join(SORTIE, 'film-' + etiquette)
    os.makedirs(racine, exist_ok=True)
    bilan = {}
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': L, 'height': H}, device_scale_factor=1)).new_page()
        erreurs = []
        page.on('pageerror', lambda e: erreurs.append(str(e)))
        page.on('console', lambda m: erreurs.append(m.text) if m.type == 'error' else None)
        await page.goto(URL + f'?test=1&q={Q}&cube=256', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=300000)
        await page.add_style_tag(content=CACHER_UI)
        await page.evaluate(HORLOGE)
        global T0
        angles = [float(x) for x in os.environ.get('ANGLES', str(T0)).split(',')]
        for T0 in angles:
            for de, vers in paires:
                nom = f'{de}-{vers}' + ('' if len(angles) == 1 else f'-{int(T0)}')
                dossier = os.path.join(racine, nom)
                etats = await filmer(page, de, vers, dossier)
                series, resume = mesurer(etats, dossier)
                if not SEULE:
                    planche(dossier, len(etats), f'{de} vers {vers} ({etiquette}), horloge {T0:g} s, une image sur {PAS} à 30 i/s')
                json.dump({'resume': resume, 'series': series}, open(os.path.join(dossier, 'mesures.json'), 'w'), ensure_ascii=False)
                bilan[nom] = resume
                print(nom, json.dumps(resume, ensure_ascii=False), flush=True)
        await nav.close()
    chemin = os.path.join(racine, 'bilan.json')
    ancien = {}
    try:
        ancien = json.load(open(chemin)).get('bilan', {})
    except Exception:
        pass
    ancien.update(bilan)
    json.dump({'url': URL, 'bilan': ancien, 'erreurs': erreurs[:10]}, open(chemin, 'w'), ensure_ascii=False, indent=1)
    print('erreurs console :', len(erreurs), erreurs[:3])


asyncio.run(main())
