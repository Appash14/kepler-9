#!/bin/bash
# Montages du lot H dans captures/lotH-avant-apres/ :
#   trajet-<de>-<vers>.jpg : le même trajet filmé à 30 i/s (tests/film.py), avant en haut, après en bas, une image
#                            toutes les 0,5 s ; film-<de>-<vers>-avant.mp4 et -apres.mp4 : les films entiers
#   antennes-bureau.jpg, antennes-tel.jpg : pont radio avant | après (captures à horloge figée)
# Usage : tests/lotH_montages.sh <dossier film avant> <dossier film après> [captures avant] [captures après]
set -u
cd "$(dirname "$0")/.."
AV=${1:-captures/film-avant}
AP=${2:-captures/film-apres}
CAV=${3:-captures/lotH-avant}
CAP=${4:-captures/lotH-apres}
O=captures/lotH-avant-apres
mkdir -p "$O"
ligne() { # dossier titre sortie : une image toutes les 15 (0,5 s), 240x150, étiquetées
  local d=$1 t=$2 s=$3 args=() n k
  n=$(ls "$d"/*.jpg | wc -l)
  for ((k = 0; k < n; k += 15)); do
    args+=(-label "$(awk -v k=$k 'BEGIN { printf "%.1f s", k / 30 }')" "$(printf '%s/%04d.jpg' "$d" $k)")
  done
  montage "${args[@]}" -tile 12x -geometry 240x150+2+2 -background '#070b16' -fill '#efe6d2' -pointsize 11 \
    -title "$t" miff:- > "$s"
}
for tr in anneau-serre serre-anneau moyeu-anneau anneau-moyeu; do
  [ -f "$AV/$tr/0000.jpg" ] && [ -f "$AP/$tr/0000.jpg" ] || continue
  ligne "$AV/$tr" "${tr/-/ vers } : avant (lot G)" /tmp/lotH-av.miff
  ligne "$AP/$tr" "${tr/-/ vers } : après (lot H)" /tmp/lotH-ap.miff
  convert /tmp/lotH-av.miff /tmp/lotH-ap.miff -background '#070b16' -append -quality 80 "$O/trajet-$tr.jpg"
  cp -f "$AV/$tr/film.mp4" "$O/film-$tr-avant.mp4" 2>/dev/null
  cp -f "$AP/$tr/film.mp4" "$O/film-$tr-apres.mp4" 2>/dev/null
  rm -f /tmp/lotH-av.miff /tmp/lotH-ap.miff
done
for f in bureau tel; do
  for h in antennes serre anneau; do
    [ -f "$CAV/$f-$h.png" ] && [ -f "$CAP/$f-$h.png" ] || continue
    if [ $f = bureau ]; then g=x450; else g=x600; fi
    convert \( "$CAV/$f-$h.png" -resize $g \) \( "$CAP/$f-$h.png" -resize $g \) +append -quality 82 "$O/$h-$f.jpg"
  done
done
ls -la "$O"
