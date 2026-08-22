#!/bin/bash
cd /c/Users/ianca/Desktop/fps4
q=$1
for i in 1 2 3 4 5; do
  node tools/inspect.mjs --nolock --name gate-$q --q $q --script tools/gate-steps.json --url http://127.0.0.1:5173/ >/dev/null 2>&1
  n=$(ls tools/out/gate-$q/burst-jit-* 2>/dev/null | wc -l)
  echo "attempt $i: jit frames $n"
  [ "$n" -ge 2 ] && break
done
python tools/gate.py tools/out/gate-$q
python tools/blobcheck.py tools/out/gate-$q burst-blob-
echo "LEG-$q-DONE"
