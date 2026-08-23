#!/bin/bash
cd /c/Users/ianca/Desktop/fps4
for r in lost shadowfen sunken void dragon; do
  n=$(ls tools/out/fin-$r/*.png 2>/dev/null|wc -l)
  if [ "$n" -ge 3 ]; then echo "$r: cached $n"; continue; fi
  for i in 1 2 3 4; do
    node tools/inspect.mjs --nolock --name fin-$r --script tools/scripts/fin/$r.json --params "at=meadow" >/dev/null 2>&1
    n=$(ls tools/out/fin-$r/*.png 2>/dev/null|wc -l); [ "$n" -ge 3 ] && break
  done
  echo "$r: $n"
done
echo RESTDONE
