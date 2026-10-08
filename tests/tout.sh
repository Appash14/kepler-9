#!/bin/bash
# Vérification complète : build, puis captures (une commande lourde à la fois, sous le verrou commun).
# Usage : tests/tout.sh [chemin du glb à tester à la place de public/assets/station.glb]
set -u
cd "$(dirname "$0")/.."
VERROU="$(dirname "$0")/../.lourd.lock"
PY="${PY:-python3}"
GLB_TEST="${1:-}"
echo "== build"; flock "$VERROU" npx vite build 2>&1 | grep -E "error|Error|built|app-|index-" || exit 1
# sans argument : le site charge public/assets/station.glb tel quel (cas réel)
GLBV=()
[ -n "$GLB_TEST" ] && GLBV=(GLB="$GLB_TEST")
if true; then
  echo "== trajets (glb)"; env "${GLBV[@]}" SUFFIXE=-glb flock "$VERROU" timeout 2400 $PY tests/captures.py trajets 0.3,0.6 2>&1 | grep -E "^trajet|erreurs|Error" | tail -3
  echo "== bureau (glb)"; env "${GLBV[@]}" SUFFIXE=-glb ATTENTE_MS=4000 flock "$VERROU" timeout 2400 $PY tests/captures.py bureau 2>&1 | grep -E "^bureau|Error|  " | tail -14
  echo "== mobile (glb)"; env "${GLBV[@]}" SUFFIXE=-glb ATTENTE_MS=4000 flock "$VERROU" timeout 2400 $PY tests/captures.py mobile 2>&1 | grep -E "^mobile|Error|  " | tail -14
  # pire cas d'un téléphone : niveau bas, DPR 1, mediump, profondeur 16 bits (voir main.js)
  echo "== téléphone pire cas (412x915)"; env "${GLBV[@]}" SUFFIXE=-pirecas ATTENTE_MS=4000 flock "$VERROU" timeout 2400 $PY tests/captures.py mobile412 "" "?test=1&test-mobile=1&cube=640" 2>&1 | grep -E "^mobile412|Error|  " | tail -14
fi
echo "== caméra (douceur, passages sur grille de 1 m, navette)"; flock "$VERROU" timeout 1800 $PY tests/camera.py 4 2>&1 | tail -22
echo "== travelling à l'arrêt"; flock "$VERROU" timeout 900 $PY tests/travelling.py 2>&1 | tail -11
echo "== pixels NaN (rectangles noirs du bloom)"; flock "$VERROU" timeout 900 $PY tests/nan.py 2>&1 | tail -3
echo "== bureau (espace réservé)"; ATTENTE_MS=4000 flock "$VERROU" timeout 2400 $PY tests/captures.py bureau "" "?test=1&q=high&cube=512&sansglb=1" 2>&1 | grep -E "^bureau|Error|  " | tail -14
echo "== robustesse"; flock "$VERROU" timeout 1200 $PY tests/robustesse.py 2>&1 | tail -40
echo "== fin"
