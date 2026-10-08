#!/bin/bash
# Montages du lot G dans captures/lotG-avant-apres/ :
#   bureau-<halte>.jpg, tel-<halte>.jpg : avant | après | écarts amplifiés (tests/comparer.py), + *-ecarts.json
#   cycles-<halte>.jpg : rendu Cycles sur GPU (blender/rendus/lotG, kit compris) | site avant | site après
#   planche-bureau.jpg, planche-tel.jpg : les dix haltes après le lot G
set -u
cd "$(dirname "$0")/.."
PY="${PY:-python3}"
O=captures/lotG-avant-apres
mkdir -p "$O"
$PY tests/comparer.py captures/lotG-avant captures/lotG-apres bureau "$O" | tail -12
$PY tests/comparer.py captures/lotG-avant captures/lotG-apres tel "$O" | tail -12
R=../blender/rendus/lotG
for h in approche quai moyeu anneau serre forge observatoire antennes lever; do
  [ -f "$R/$h.png" ] || continue
  convert \( "$R/$h.png" -resize x450 \) \( captures/lotG-avant/bureau-$h.png -resize x450 \) \( captures/lotG-apres/bureau-$h.png -resize x450 \) +append -quality 82 "$O/cycles-$h.jpg"
done
H="approche anneaux quai moyeu anneau serre forge observatoire antennes lever"
convert $(for h in $H; do echo captures/lotG-apres/bureau-$h.png; done) -resize 480x300! miff:- | montage - -tile 5x2 -geometry +2+2 -background '#070b16' -quality 80 "$O/planche-bureau.jpg"
convert $(for h in $H; do echo captures/lotG-apres/tel-$h.png; done) -resize 195x422! miff:- | montage - -tile 10x1 -geometry +2+2 -background '#070b16' -quality 80 "$O/planche-tel.jpg"
ls -la "$O" | tail -5
