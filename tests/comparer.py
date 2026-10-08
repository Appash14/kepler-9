"""Non-régression image par image (lot F) : compare deux passes de tests/lotF.py et monte les avant/après.

Usage : python3.11 tests/comparer.py <dossier avant> <dossier après> <format> [sortie]
Pour chaque image présente des deux côtés : écart moyen (0 à 255), part des pixels qui changent de plus de
12 niveaux, et luminosité moyenne avant/après. Écrit <sortie>/<format>-<nom>.jpg (avant | après | écarts
amplifiés x4) et <sortie>/<format>-ecarts.json.
"""
import json
import os
import subprocess
import sys

import numpy as np


def lire(png):
    taille = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], capture_output=True, text=True).stdout.strip().split(',')
    w, h = int(taille[0]), int(taille[1])
    brut = subprocess.run(['ffmpeg', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    return np.frombuffer(brut, np.uint8).reshape(h, w, 3)


def main():
    avant, apres, fmt = sys.argv[1], sys.argv[2], sys.argv[3]
    sortie = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(apres), 'lotF-avant-apres')
    os.makedirs(sortie, exist_ok=True)
    res = {}
    for f in sorted(os.listdir(apres)):
        if not (f.startswith(fmt + '-') and f.endswith('.png')) or not os.path.exists(os.path.join(avant, f)):
            continue
        a, b = lire(os.path.join(avant, f)).astype(np.int16), lire(os.path.join(apres, f)).astype(np.int16)
        if a.shape != b.shape:
            continue
        d = np.abs(a - b).max(axis=2)
        nom = f[len(fmt) + 1:-4]
        res[nom] = {'ecart_moyen': round(float(np.abs(a - b).mean()), 2), 'pixels_changes_pct': round(float((d > 12).mean() * 100), 2),
                    'luminosite_avant': round(float(a.mean()), 1), 'luminosite_apres': round(float(b.mean()), 1)}
        carte = np.clip(d * 4, 0, 255).astype(np.uint8)
        carte = np.stack([carte, carte // 3, carte // 3], axis=2)
        mont = np.concatenate([a.astype(np.uint8), b.astype(np.uint8), carte], axis=1)
        h, w = mont.shape[:2]
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-i', '-',
                        '-vf', f'scale={min(w, 2160)}:-2', '-q:v', '4', os.path.join(sortie, f'{fmt}-{nom}.jpg')], input=mont.tobytes())
        print(f"{nom:28s} écart moyen {res[nom]['ecart_moyen']:6.2f}  pixels changés {res[nom]['pixels_changes_pct']:6.2f} %  luminosité {res[nom]['luminosite_avant']} -> {res[nom]['luminosite_apres']}")
    json.dump(res, open(os.path.join(sortie, f'{fmt}-ecarts.json'), 'w'), ensure_ascii=False, indent=1)


main()
