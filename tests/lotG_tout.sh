#!/bin/bash
# Lot G : toutes les vérifications, une commande lourde à la fois sous le verrou commun.
# Usage : URL=http://127.0.0.1:4343/ tests/lotG_tout.sh [étiquette, défaut apres] [étapes, défaut toutes]
# étapes : build camera travelling superpositions robustesse nan bureau tel poids (séparées par des virgules)
set -u
cd "$(dirname "$0")/.."
V="$(dirname "$0")/../.lourd.lock"
PY="${PY:-python3}"
E="${1:-apres}"
ETAPES=",${2:-build,camera,travelling,superpositions,robustesse,nan,bureau,tel,poids},"
OUT="${OUT:-.lotG/dist}"
export URL="${URL:-http://127.0.0.1:4343/}"
a() { case "$ETAPES" in *",$1,"*) return 0;; *) return 1;; esac; }
if a build; then echo "== build ($OUT)"; flock "$V" npx vite build --outDir "$OUT" --emptyOutDir 2>&1 | grep -E "rror|built|app-" ; fi
if a camera; then echo "== caméra (douceur, passages sur grille de 1 m, kit animé, navette)"; flock "$V" timeout 2400 $PY tests/camera.py 4 "lotG-$E" 2>&1 | tail -26; fi
if a travelling; then echo "== travelling à l'arrêt"; flock "$V" timeout 1200 $PY tests/travelling.py 2>&1 | tail -12; fi
if a superpositions; then echo "== faces superposées (glb brut)"; flock "$V" timeout 1200 $PY tests/superpositions.py ../blender/sortie/station-brut.glb 2>&1 | tail -12; fi
if a robustesse; then echo "== robustesse"; flock "$V" timeout 1200 $PY tests/robustesse.py 2>&1 | tail -20; fi
if a nan; then echo "== pixels NaN"; flock "$V" timeout 900 $PY tests/nan.py 2>&1 | tail -3; fi
if a bureau; then echo "== captures bureau"; flock "$V" timeout 3600 $PY tests/lotG.py "$E" bureau haltes 2>&1 | tail -12; fi
if a tel; then echo "== captures téléphone"; flock "$V" timeout 3600 $PY tests/lotG.py "$E" tel haltes 2>&1 | tail -12; fi
if a poids; then echo "== poids transféré"; flock "$V" timeout 1800 $PY tests/lotG.py "$E" bureau poids 2>&1 | tail -3; flock "$V" timeout 1800 $PY tests/lotG.py "$E" tel poids 2>&1 | tail -3; fi
echo "== fin"
