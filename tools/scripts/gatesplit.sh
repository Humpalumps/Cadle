#!/bin/bash
cd /c/Users/ianca/Desktop/fps4
q=$1
for i in 1 2 3 4 5 6; do
  node tools/inspect.mjs --nolock --name gate-$q-blob --q $q --script tools/scripts/gate-blob.json --url http://127.0.0.1:5173/ >/dev/null 2>&1
  n=$(ls tools/out/gate-$q-blob/burst-blob-* 2>/dev/null | wc -l)
  echo "blob attempt $i: $n frames"
  [ "$n" -ge 88 ] && break
done
python tools/blobcheck.py tools/out/gate-$q-blob burst-blob-
for i in 1 2 3 4 5 6; do
  node tools/inspect.mjs --nolock --name gate-$q-jit --q $q --script tools/scripts/gate-jit.json --url http://127.0.0.1:5173/ >/dev/null 2>&1
  n=$(ls tools/out/gate-$q-jit/burst-jit-* 2>/dev/null | wc -l)
  echo "jit attempt $i: $n frames"
  [ "$n" -ge 6 ] && break
done
python tools/gate.py tools/out/gate-$q-jit
echo "SPLIT-$q-DONE"
