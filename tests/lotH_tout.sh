#!/bin/bash
# Lot H : vérifications, une commande lourde à la fois sous le verrou commun.
# Usage : URL=http://127.0.0.1:4343/ AVANT=http://127.0.0.1:4344/ tests/lotH_tout.sh [étapes]
# étapes (virgules) : films camera travelling superpositions robustesse nan captures montages
#   films       : anneau vers serre et retour, filmés à 30 i/s (horloge 30 s), version testée -> captures/film-apres
#   captures    : serre, anneau, antennes, bureau 1440x900 et téléphone 390x844 (version testée -> lotF-H-apres) ;
#                 pont radio de la version d'avant (AVANT -> lotF-H-avant)
set -u
cd "$(dirname "$0")/.."
V="$(dirname "$0")/../.lourd.lock"
PY="${PY:-python3}"
ETAPES=",${1:-films,camera,travelling,superpositions,robustesse,nan,captures,montages},"
export URL="${URL:-http://127.0.0.1:4343/}"
AVANT="${AVANT:-http://127.0.0.1:4344/}"
a() { case "$ETAPES" in *",$1,"*) return 0;; *) return 1;; esac; }
if a films; then echo "== films (30 i/s, horloge 30 s)"; flock "$V" timeout 3600 env ANGLE=30 $PY tests/film.py apres 'anneau>serre' 'serre>anneau' 2>&1 | tail -4; fi
if a camera; then echo "== caméra (douceur, passages sur grille de 1 m, kit animé, navette)"; flock "$V" timeout 3600 $PY tests/camera.py 4 lotH-apres 2>&1 | tail -26; fi
if a travelling; then echo "== travelling à l'arrêt"; flock "$V" timeout 1200 $PY tests/travelling.py 2>&1 | tail -12; fi
if a superpositions; then echo "== faces superposées (glb brut)"; flock "$V" timeout 1200 $PY tests/superpositions.py ../blender/sortie/station-brut.glb 2>&1 | tail -12; fi
if a robustesse; then echo "== robustesse"; flock "$V" timeout 1200 $PY tests/robustesse.py 2>&1 | tail -20; fi
if a nan; then echo "== pixels NaN"; flock "$V" timeout 900 $PY tests/nan.py 2>&1 | tail -3; fi
if a captures; then
  echo "== captures"
  for f in bureau tel; do
    flock "$V" timeout 3600 env SEULEMENT=serre,anneau,antennes $PY tests/lotF.py H-apres $f haltes 2>&1 | tail -4
    flock "$V" timeout 3600 env URL="$AVANT" SEULEMENT=antennes $PY tests/lotF.py H-avant $f haltes 2>&1 | tail -2
  done
fi
if a montages; then echo "== montages"; bash tests/lotH_montages.sh captures/film-avant captures/film-apres captures/lotF-H-avant captures/lotF-H-apres 2>&1 | tail -12; fi
sync
echo "== fin"
