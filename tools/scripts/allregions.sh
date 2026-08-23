#!/bin/bash
cd /c/Users/ianca/Desktop/fps4
for r in forest tundra celestial dragon infernal lost shadowfen sunken void; do
  bash tools/scripts/run.sh "fin-$r" --script "tools/scripts/fin/$r.json" --params "at=meadow" >/dev/null 2>&1
  echo "$r: $(ls tools/out/fin-$r/*.png 2>/dev/null | wc -l) shots"
done
echo ALLDONE
