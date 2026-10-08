"""Trajets de caméra : douceur (vitesses et accélérations, linéaires et angulaires) et passages dans la structure.

Usage : URL=http://127.0.0.1:4340/ python3.11 tests/camera.py [nombre d'angles de l'anneau, défaut 4] [étiquette]
Simule le rig réel à 60 images/s (lissage et visée bornée compris), l'anneau tournant pendant le trajet,
pour chaque trajet dans les deux sens et pour plusieurs angles de l'anneau au départ. Par trajet (pire cas) :
  visée     vitesse angulaire maximale de la direction de visée (°/s) ; cible lot F : 45, 60 au pire ;
  rotation  vitesse angulaire maximale de la caméra entière, roulis compris (°/s) ;
  roulis    vitesse maximale de rotation autour de l'axe de visée (°/s) ;
  acc.ang   accélération angulaire maximale de la caméra (°/s²) : un « coup » de visée se voit ici ;
  acc       accélération maximale de la position (m/s²) ; à-coup : sa variation (m/s³) ;
  passages  images où la caméra est dans un voxel occupé d'une grille de 1 m (toute la station, anneau
            compris dans son propre repère ; verre, navette et effets exclus) ;
  marge     distance minimale entre la caméra et la structure (m, grille de 1 m), hors 0,4 s aux bouts.
Écrit captures/camera-<étiquette>.json. Lot E (2026-10-01), mesures de douceur et grille fine : lot F.
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

URL = os.environ.get('URL', 'http://127.0.0.1:4340/')
CHROME = os.environ.get('CHROME_PATH') or None  # None : Chromium fourni par Playwright
H = ['approche', 'anneaux', 'quai', 'moyeu', 'anneau', 'serre', 'forge', 'observatoire', 'antennes', 'lever']

GRILLE = r"""
() => {
  const S = window.__station, T = S.THREE, st = S.station;
  const taille = 1.0;
  st.groupe.updateMatrixWorld(true);
  const anneau = st.groupe.getObjectByName('anneau_rotatif');
  const dansAnneau = (o) => { for (let x = o; x; x = x.parent) if (x === anneau) return true; return false; };
  const exclu = (o) => {
    if (o.material && (o.material.name === 'verre' || o.material.transparent && o.material.depthWrite === false)) return true;
    for (let x = o; x; x = x.parent) if (x.name && (x.name.startsWith('verre_') || x.name === 'navette' || x.name === 'effets_station')) return true;
    // lot G : objets du kit animés (astronaute, robot, drones) : ils bougent, contrôlés à part (distance)
    for (let x = o; x; x = x.parent) if (x.userData && (x.userData.kitAnime || x.userData.anime)) return true;
    return false;
  };
  const min = new T.Vector3(-80, -80, -135), max = new T.Vector3(80, 80, 80);
  const nx = Math.ceil((max.x - min.x) / taille), ny = Math.ceil((max.y - min.y) / taille), nz = Math.ceil((max.z - min.z) / taille);
  const fixe = new Uint8Array(nx * ny * nz), tourne = new Uint8Array(nx * ny * nz);
  const idx = (p) => {
    const i = Math.floor((p.x - min.x) / taille), j = Math.floor((p.y - min.y) / taille), k = Math.floor((p.z - min.z) / taille);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return i + nx * (j + ny * k);
  };
  // repère de l'anneau au repos : on retire la rotation courante du pivot
  const invAnneau = new T.Matrix4();
  if (st.pivotAnneau) invAnneau.copy(st.pivotAnneau.matrixWorld).invert();
  const repos = new T.Matrix4();
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), p = new T.Vector3(), e1 = new T.Vector3(), e2 = new T.Vector3();
  const mi = new T.Matrix4(), mw = new T.Matrix4();
  const pas = taille * 0.5;
  let tris = 0;
  st.groupe.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || exclu(o) || !o.visible) return;
    const g = o.geometry, pos = g.attributes.position, ix = g.index;
    const nTri = ix ? ix.count / 3 : pos.count / 3;
    const surAnneau = anneau && dansAnneau(o);
    const grille = surAnneau ? tourne : fixe;
    const inst = o.isInstancedMesh ? o.count : 1;
    for (let s = 0; s < inst; s++) {
      if (o.isInstancedMesh) { o.getMatrixAt(s, mi); mw.multiplyMatrices(o.matrixWorld, mi); } else mw.copy(o.matrixWorld);
      if (surAnneau) mw.premultiply(invAnneau);
      for (let t = 0; t < nTri; t++) {
        const i0 = ix ? ix.getX(t * 3) : t * 3, i1 = ix ? ix.getX(t * 3 + 1) : t * 3 + 1, i2 = ix ? ix.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mw); b.fromBufferAttribute(pos, i1).applyMatrix4(mw); c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
        tris++;
        const n1 = Math.max(1, Math.ceil(a.distanceTo(b) / pas)), n2 = Math.max(1, Math.ceil(a.distanceTo(c) / pas));
        if (n1 * n2 > 60000) continue;
        e1.subVectors(b, a); e2.subVectors(c, a);
        for (let i = 0; i <= n1; i++) for (let j = 0; j <= n2; j++) {
          const u = i / n1, v = j / n2;
          if (u + v > 1.0001) break;
          p.copy(a).addScaledVector(e1, u).addScaledVector(e2, v);
          const q = idx(p); if (q >= 0) grille[q] = 1;
        }
      }
    }
  });
  window.__grille = { min, taille, nx, ny, nz, fixe, tourne, invAnneau };
  let nf = 0, nt = 0; for (let i = 0; i < fixe.length; i++) { nf += fixe[i]; nt += tourne[i]; }
  return { voxels: [nx, ny, nz], fixes: nf, anneau: nt, triangles: tris };
}
"""

SIMULATION = r"""
async ([H, nAngles]) => {
  const S = window.__station, T = S.THREE, rig = S.rig, cam = S.camera, st = S.station, G = window.__grille;
  S.degeler();
  const out = [];
  const dt = 1 / 60;
  const V = () => new T.Vector3();
  const ax = st.axeAnneau.clone().normalize();
  const occupe = (P, ang) => {
    const q0 = (p, g) => {
      const i = Math.floor((p.x - G.min.x) / G.taille), j = Math.floor((p.y - G.min.y) / G.taille), k = Math.floor((p.z - G.min.z) / G.taille);
      if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) return 0;
      return g[i + G.nx * (j + G.ny * k)];
    };
    const pr = P.clone().applyAxisAngle(ax, -ang);
    return q0(P, G.fixe) || q0(pr, G.tourne);
  };
  // distance à la structure : recherche dans un cube de ±5 voxels
  const marge = (P, ang) => {
    const pr = P.clone().applyAxisAngle(ax, -ang);
    let best = 6;
    for (const [p, g] of [[P, G.fixe], [pr, G.tourne]]) {
      const i0 = Math.floor((p.x - G.min.x) / G.taille), j0 = Math.floor((p.y - G.min.y) / G.taille), k0 = Math.floor((p.z - G.min.z) / G.taille);
      for (let k = -5; k <= 5; k++) for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) {
        const ii = i0 + i, jj = j0 + j, kk = k0 + k;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= G.nx || jj >= G.ny || kk >= G.nz) continue;
        if (!g[ii + G.nx * (jj + G.ny * kk)]) continue;
        const cx = G.min.x + (ii + 0.5) * G.taille, cy = G.min.y + (jj + 0.5) * G.taille, cz = G.min.z + (kk + 0.5) * G.taille;
        const d = Math.hypot(cx - p.x, cy - p.y, cz - p.z) - 0.5 * G.taille;
        if (d < best) best = d;
      }
    }
    return Math.max(0, best);
  };
  // lot G : vides animés du kit (astronaute, robot, drones) : distance minimale à l'objectif
  const anim = [];
  st.groupe.traverse((o) => { if (/^kit_/.test(o.name || '') && o.userData && o.userData.anime) anim.push(o); });
  const pA = new T.Vector3();
  for (let k = 0; k < nAngles; k++) {
    for (const sens of [1, -1]) {
      for (let i = 0; i + 1 < H.length; i++) {
        const [a, b] = sens > 0 ? [i, i + 1] : [i + 1, i];
        S.aller(H[a]);
        rig.annuler(); rig.reamorcer();
        let t = 1000 + k * 100;
        rig.maj(t, 0, { reduit: false, instantane: true });
        for (let n = 0; n < 30; n++) { t += dt; st.animer(t, dt, { signal: 0, pixel: 1, camera: null }); rig.maj(t, dt, { reduit: false, instantane: false }); }
        rig.demarrer(a, b, t);
        const duree = rig.trajet.duree;
        const P = [], D = [], U = [], Q = [], A = [];
        let n = 0, fin = -1, kitMin = 999;
        while (n < 60 * 25) {
          t += dt; n++;
          st.animer(t, dt, { signal: 0, pixel: 1, camera: null });
          rig.maj(t, dt, { reduit: false, instantane: false });
          cam.updateMatrixWorld();
          if (S.kit) { S.kit.animer(t, dt, null); st.groupe.updateMatrixWorld(true); }
          for (const o of anim) { o.getWorldPosition(pA); kitMin = Math.min(kitMin, pA.distanceTo(cam.position)); }
          P.push(cam.position.clone()); D.push(cam.getWorldDirection(V())); U.push(V().set(0, 1, 0).applyQuaternion(cam.quaternion));
          Q.push(cam.quaternion.clone()); A.push(st.angleAnneau);
          if (!rig.enRoute && fin < 0) fin = n;
          if (fin >= 0 && n > fin + 60) break;
        }
        // vitesses et accélérations
        const deg = 180 / Math.PI;
        let vmax = 0, rmax = 0, rollmax = 0, aangmax = 0, accmax = 0, jerkmax = 0, passages = 0, margeMin = 99;
        const w = [], vel = [], acc = [];
        for (let m = 1; m < Q.length; m++) {
          const dq = Q[m - 1].clone().invert().multiply(Q[m]);
          const s2 = Math.min(1, Math.hypot(dq.x, dq.y, dq.z)), ang = 2 * Math.asin(s2) * (dq.w < 0 ? -1 : 1);
          const axe = s2 > 1e-9 ? V().set(dq.x, dq.y, dq.z).divideScalar(s2) : V();
          const om = axe.multiplyScalar(ang / dt); // vitesse angulaire dans le repère caméra (rad/s)
          w.push(om);
          rmax = Math.max(rmax, om.length() * deg);
          rollmax = Math.max(rollmax, Math.abs(om.z) * deg);
          vmax = Math.max(vmax, Math.acos(Math.min(1, Math.max(-1, D[m].dot(D[m - 1])))) * deg / dt);
          vel.push(V().subVectors(P[m], P[m - 1]).divideScalar(dt));
        }
        // accélérations lissées sur 3 images (bruit numérique)
        for (let m = 3; m < w.length; m++) aangmax = Math.max(aangmax, V().subVectors(w[m], w[m - 3]).length() / (3 * dt) * deg);
        for (let m = 3; m < vel.length; m++) acc.push(V().subVectors(vel[m], vel[m - 3]).divideScalar(3 * dt));
        for (const x of acc) accmax = Math.max(accmax, x.length());
        for (let m = 3; m < acc.length; m++) jerkmax = Math.max(jerkmax, V().subVectors(acc[m], acc[m - 3]).length() / (3 * dt));
        const bord = 24;
        for (let m = 0; m < P.length; m++) {
          if (occupe(P[m], A[m])) passages++;
          if (m > bord && m < (fin > 0 ? fin : P.length) - bord) margeMin = Math.min(margeMin, marge(P[m], A[m]));
        }
        out.push({ paire: H[a] + '>' + H[b], angle: k, duree: +duree.toFixed(1), visee: Math.round(vmax), rotation: Math.round(rmax), roulis: Math.round(rollmax),
          accAng: Math.round(aangmax), acc: +accmax.toFixed(1), acoup: Math.round(jerkmax), passages, marge: +margeMin.toFixed(1),
          kit: +kitMin.toFixed(1) });
        rig.annuler();
      }
    }
    st.animer(0, 45 / nAngles + 3.7, { signal: 0, pixel: 1, camera: null });
  }
  return out;
}
"""


NAVETTE = r"""
() => {
  // approche de la navette rejouée à 60 images/s : contacts avec la structure (grille de 1 m) et douceur
  // de son orientation (vitesse et accélération angulaires, roulis)
  const S = window.__station, T = S.THREE, st = S.station, G = window.__grille;
  const n = st.trouve('navette');
  if (!n || !st.navette.existe) return null;
  const q0 = (p, g) => {
    const i = Math.floor((p.x - G.min.x) / G.taille), j = Math.floor((p.y - G.min.y) / G.taille), k = Math.floor((p.z - G.min.z) / G.taille);
    if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) return 0;
    return g[i + G.nx * (j + G.ny * k)];
  };
  st.navette.attendre(); st.navette.demarrer();
  const dt = 1 / 60, deg = 180 / Math.PI;
  const p = new T.Vector3(), Q = [], contacts = [];
  let t = 2000;
  for (let m = 0; m <= 16 * 60; m++) {
    t += dt;
    st.animer(t, dt, { signal: 0, pixel: 1, camera: null });
    n.updateMatrixWorld(true);
    n.getWorldPosition(p);
    if (q0(p, G.fixe)) contacts.push(+(m * dt).toFixed(2));
    Q.push(n.getWorldQuaternion(n.quaternion.clone()));
  }
  const w = [];
  let vmax = 0, amax = 0, rollmax = 0, tA = 0;
  for (let m = 1; m < Q.length; m++) {
    const dq = Q[m - 1].clone().invert().multiply(Q[m]);
    const s2 = Math.min(1, Math.hypot(dq.x, dq.y, dq.z)), ang = 2 * Math.asin(s2) * (dq.w < 0 ? -1 : 1);
    const om = s2 > 1e-9 ? new T.Vector3(dq.x, dq.y, dq.z).multiplyScalar(ang / s2 / dt) : new T.Vector3();
    w.push(om);
    vmax = Math.max(vmax, om.length() * deg);
  }
  for (let m = 3; m < w.length; m++) {
    const a = new T.Vector3().subVectors(w[m], w[m - 3]).length() / (3 * dt) * deg;
    if (a > amax) { amax = a; tA = m * dt; }
  }
  return { contacts, rotationMax: Math.round(vmax), accAngMax: Math.round(amax), aT: +tA.toFixed(2) };
}
"""


async def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    etiquette = sys.argv[2] if len(sys.argv) > 2 else 'lotF'
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = await (await nav.new_context(viewport={'width': 160, 'height': 100})).new_page()
        erreurs = []
        page.on('pageerror', lambda e: erreurs.append(str(e)))
        page.on('console', lambda m: erreurs.append(m.text) if m.type == 'error' else None)
        await page.goto(URL + '?test=1&q=low&cube=128', wait_until='load')
        await page.wait_for_function('window.__station && window.__station.etat.pret', timeout=300000)
        kit = await page.evaluate('JSON.parse(JSON.stringify(window.__station.etat.kit || null))')
        await page.evaluate('window.__station.renderer.setAnimationLoop(null)')
        grille = await page.evaluate(GRILLE)
        sim = await page.evaluate(SIMULATION, [H, n])
        navette = await page.evaluate(NAVETTE)
        await nav.close()
    print('grille :', grille)
    print('kit :', kit)
    pires = {}
    for r in sim:
        k = r['paire']
        if k not in pires:
            pires[k] = dict(r)
            continue
        q = pires[k]
        for c in ('visee', 'rotation', 'roulis', 'accAng', 'acc', 'acoup', 'passages'):
            q[c] = max(q[c], r[c])
        q['marge'] = min(q['marge'], r['marge'])
        q['kit'] = min(q.get('kit', 999), r.get('kit', 999))
    print(f"{'trajet':24s} {'durée':>5s} {'visée':>6s} {'rot.':>5s} {'roul.':>5s} {'acc.ang':>7s} {'acc':>5s} {'à-coup':>6s} {'pass.':>5s} {'marge':>5s} {'kit':>5s}")
    for k, r in pires.items():
        print(f"{k:24s} {r['duree']:5.1f} {r['visee']:6d} {r['rotation']:5d} {r['roulis']:5d} {r['accAng']:7d} {r['acc']:5.1f} {r['acoup']:6d} {r['passages']:5d} {r['marge']:5.1f} {r.get('kit', 999):5.1f}")
    print('navette (approche rejouée) :', navette)
    print('erreurs console :', len(erreurs), erreurs[:5])
    json.dump({'grille': grille, 'simulation': sim, 'pires': pires, 'navette': navette}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'captures', f'camera-{etiquette}.json'), 'w'), ensure_ascii=False, indent=1)


asyncio.run(main())
