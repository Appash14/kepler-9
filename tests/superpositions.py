"""Détecteur de faces coplanaires qui se recouvrent (z-fighting garanti) dans un glb non compressé.

Usage : python3.11 tests/superpositions.py ../blender/sortie/station-brut.glb [tolérance en m, défaut 0.003]
        FILTRE=nom_objet NDET=8 pour détailler les paires d'un objet.
Pour chaque paire de triangles quasi coplanaires (normales parallèles ou opposées, plans à moins de la
tolérance) dont les projections se recouvrent sur plus de 0.01 m², on cumule par paire d'objets.
« même sens » : les deux faces regardent du même côté, le scintillement se voit forcément s'il n'y a
rien devant. « opposés » : en général deux solides qui se touchent (faces internes, invisibles), sauf
pour des plaques ouvertes (les bouchons de l'anneau étaient de ce type). Lot E, 2026-10-01.
"""
import json, struct, sys
from collections import defaultdict
import numpy as np

chemin = sys.argv[1]
TOL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.003
b = open(chemin, 'rb').read()
L = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + L])
off = 20 + L
L2 = struct.unpack('<I', b[off:off + 4])[0]
BIN = b[off + 8: off + 8 + L2]

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def acc(i):
    a = j['accessors'][i]
    bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']])
    n = NC[a['type']]
    o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0)
    if stride and stride != dt.itemsize * n:
        raw = np.frombuffer(BIN, dtype=np.uint8, count=stride * a['count'], offset=o).reshape(a['count'], stride)
        arr = raw[:, :dt.itemsize * n].copy().view(dt).reshape(a['count'], n)
    else:
        arr = np.frombuffer(BIN, dtype=dt, count=a['count'] * n, offset=o).reshape(a['count'], n)
    arr = arr.astype(np.float64)
    if a.get('normalized'):
        arr = arr / {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[a['componentType']]
    return arr


def trs(nd):
    if 'matrix' in nd:
        return np.array(nd['matrix'], dtype=np.float64).reshape(4, 4).T
    t = nd.get('translation', [0, 0, 0]); r = nd.get('rotation', [0, 0, 0, 1]); s = nd.get('scale', [1, 1, 1])
    x, y, z, w = r
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4); M[:3, :3] = R * np.array(s); M[:3, 3] = t
    return M


tris, noms = [], []


def visite(i, Mp, chemin_nom):
    nd = j['nodes'][i]
    M = Mp @ trs(nd)
    nom = nd.get('name', f'n{i}')
    if 'mesh' in nd:
        inst = [np.eye(4)]
        ext = nd.get('extensions', {}).get('EXT_mesh_gpu_instancing')
        if ext:
            at = ext['attributes']
            T = acc(at['TRANSLATION']) if 'TRANSLATION' in at else None
            Rq = acc(at['ROTATION']) if 'ROTATION' in at else None
            S = acc(at['SCALE']) if 'SCALE' in at else None
            n = len(T if T is not None else Rq if Rq is not None else S)
            inst = []
            for k in range(n):
                inst.append(trs({'translation': list(T[k]) if T is not None else [0, 0, 0], 'rotation': list(Rq[k]) if Rq is not None else [0, 0, 0, 1], 'scale': list(S[k]) if S is not None else [1, 1, 1]}))
        for p in j['meshes'][nd['mesh']]['primitives']:
            if p.get('mode', 4) != 4:
                continue
            P = acc(p['attributes']['POSITION'])
            I = acc(p['indices']).astype(np.int64).reshape(-1) if 'indices' in p else np.arange(len(P))
            mat = j['materials'][p['material']]['name'] if 'material' in p else '?'
            for k, Mi in enumerate(inst):
                W = (M @ Mi)
                Pw = (np.c_[P, np.ones(len(P))] @ W.T)[:, :3]
                tris.append(Pw[I].reshape(-1, 3, 3))
                noms.extend([f'{nom}[{mat}]' + (f'#{k}' if len(inst) > 1 else '')] * (len(I) // 3))
    for c in nd.get('children', []):
        visite(c, M, nom)


for s in j['scenes'][j.get('scene', 0)]['nodes']:
    visite(s, np.eye(4), '')
T = np.concatenate(tris)
noms = np.array(noms)
print('triangles', len(T))
e1 = T[:, 1] - T[:, 0]; e2 = T[:, 2] - T[:, 0]
N = np.cross(e1, e2)
aire = np.linalg.norm(N, axis=1) / 2
ok = aire > 1e-4
T, N, aire, noms = T[ok], N[ok], aire[ok], noms[ok]
N = N / np.linalg.norm(N, axis=1)[:, None]
# signe canonique : la plus grande composante positive
k = np.argmax(np.abs(N), axis=1)
sg = np.sign(N[np.arange(len(N)), k])
Nc = N * sg[:, None]
D = np.einsum('ij,ij->i', Nc, T[:, 0])
print('triangles non dégénérés', len(T))

# seaux : normale quantifiée (0.05) et distance (TOL*2) ; on teste aussi le seau voisin en distance
cle_n = np.round(Nc / 0.05).astype(np.int64)
cle_d = np.floor(D / (TOL * 2)).astype(np.int64)
seaux = defaultdict(list)
for i in range(len(T)):
    seaux[(cle_n[i, 0], cle_n[i, 1], cle_n[i, 2], cle_d[i])].append(i)


def clip(poly, a, b):
    # garde la partie à gauche de a->b (polygone convexe, sens trigo)
    out = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        cp = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        cq = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        if cp >= 0:
            out.append(p)
        if (cp >= 0) != (cq >= 0):
            t = cp / (cp - cq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def aire2(poly):
    s = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]; x1, y1 = poly[(i + 1) % len(poly)]
        s += x0 * y1 - x1 * y0
    return s / 2


def inter(t1, t2):
    if aire2(t1) < 0: t1 = t1[::-1]
    if aire2(t2) < 0: t2 = t2[::-1]
    poly = list(t1)
    for i in range(3):
        if not poly:
            return 0.0
        poly = clip(poly, t2[i], t2[(i + 1) % 3])
    return abs(aire2(poly)) if len(poly) >= 3 else 0.0


paires = defaultdict(lambda: [0, 0.0, [], 0, 0])
vus = set()
for cle, lst in seaux.items():
    voisins = list(lst)
    c2 = (cle[0], cle[1], cle[2], cle[3] + 1)
    if c2 in seaux:
        voisins = voisins + seaux[c2]
    if len(voisins) < 2:
        continue
    idx = np.array(voisins)
    n0 = Nc[idx[0]]
    u = np.cross(n0, [1, 0, 0] if abs(n0[0]) < 0.9 else [0, 1, 0]); u /= np.linalg.norm(u)
    v = np.cross(n0, u)
    P2 = np.stack([T[idx] @ u, T[idx] @ v], axis=-1)  # (m, 3, 2)
    lo = P2.min(axis=1); hi = P2.max(axis=1)
    ordre = np.argsort(lo[:, 0])
    m = len(idx)
    for a_ in range(m):
        ia = ordre[a_]
        for b_ in range(a_ + 1, m):
            ib = ordre[b_]
            if lo[ib, 0] >= hi[ia, 0] - 1e-6:
                break
            if lo[ib, 1] >= hi[ia, 1] - 1e-6 or lo[ia, 1] >= hi[ib, 1] - 1e-6:
                continue
            gi, gj = idx[ia], idx[ib]
            if (gi, gj) in vus:
                continue
            vus.add((gi, gj))
            if abs(D[gi] - D[gj]) > TOL or abs(np.dot(Nc[gi], Nc[gj])) < 0.999:
                continue
            ar = inter([tuple(x) for x in P2[ia]], [tuple(x) for x in P2[ib]])
            if ar > 0.01 and ar > 0.05 * min(aire[gi], aire[gj]):
                k2 = tuple(sorted((noms[gi], noms[gj])))
                paires[k2][0] += 1
                paires[k2][1] += ar
                paires[k2][2].append(((T[gi].mean(axis=0) + T[gj].mean(axis=0)) / 2, N[gi], ar, aire[gi], aire[gj], np.dot(N[gi], N[gj]) > 0))
                if np.dot(N[gi], N[gj]) > 0: paires[k2][3] += 1
                else: paires[k2][4] += 1

res = sorted(paires.items(), key=lambda kv: -kv[1][1])
print('paires d\'objets en recouvrement :', len(res))
import os
FILTRE = os.environ.get('FILTRE', '')
for (a, b2), (n, ar, pts, meme, opp) in res[:60]:
    if FILTRE and FILTRE not in a and FILTRE not in b2: continue
    P = np.array([p[0] for p in pts])
    print(f'{ar:9.2f} m² {n:5d} p. meme_sens={meme} opposes={opp}  {a} <-> {b2}  zone x[{P[:,0].min():.0f},{P[:,0].max():.0f}] y[{P[:,1].min():.0f},{P[:,1].max():.0f}] z[{P[:,2].min():.0f},{P[:,2].max():.0f}]')
    det = [p for p in pts if p[5]]
    det.sort(key=lambda p: -p[2])
    for p in det[:int(os.environ.get('NDET', '8'))]:
        print('     même sens : centre', np.round(p[0], 2), 'normale', np.round(p[1], 2), 'recouvrement', round(p[2], 2), 'aires', round(p[3], 2), round(p[4], 2))
