#!/bin/bash
# Split gate: the blob half and the jitter half, each independently retryable.
# HARD-FAILS on a short capture. A truncated run must never reach the checkers —
# blobcheck.py on an empty directory prints a pass, and gate.py's "blob shots clean"
# is vacuous when there are no blob shots. That is how a busy box fakes a green gate.
cd /c/Users/ianca/Desktop/fps4
q=$1
BLOB_MIN=88
JIT_MIN=6
ok=1
for i in 1 2 3 4 5 6; do
  node tools/inspect.mjs --nolock --name gate-$q-blob --q $q --script tools/scripts/gate-blob.json --url http://127.0.0.1:5173/ >/dev/null 2>&1
  n=$(ls tools/out/gate-$q-blob/burst-blob-* 2>/dev/null | wc -l)
  echo "blob attempt $i: $n/$BLOB_MIN frames"
  [ "$n" -ge "$BLOB_MIN" ] && break
done
if [ "$n" -lt "$BLOB_MIN" ]; then
  echo "BLOB LEG INCOMPLETE ($n/$BLOB_MIN) — NOT CHECKED, NOT A PASS"; ok=0
else
  python tools/blobcheck.py tools/out/gate-$q-blob burst-blob- || ok=0
fi
for i in 1 2 3 4 5 6; do
  node tools/inspect.mjs --nolock --name gate-$q-jit --q $q --script tools/scripts/gate-jit.json --url http://127.0.0.1:5173/ >/dev/null 2>&1
  m=$(ls tools/out/gate-$q-jit/burst-jit-* 2>/dev/null | wc -l)
  echo "jit attempt $i: $m/$JIT_MIN frames"
  [ "$m" -ge "$JIT_MIN" ] && break
done
if [ "$m" -lt "$JIT_MIN" ]; then
  echo "JIT LEG INCOMPLETE ($m/$JIT_MIN) — NOT CHECKED, NOT A PASS"; ok=0
else
  python tools/gate.py tools/out/gate-$q-jit || ok=0
fi
[ "$ok" = "1" ] && echo "SPLIT-$q-GREEN" || echo "SPLIT-$q-NOT-GREEN"
echo "SPLIT-$q-DONE"
