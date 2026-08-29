#!/bin/bash
cd "C:/Users/ianca/Desktop/fps4/.claude/worktrees/cadle-character-load-perf-ee5b7b" || exit 1
for i in $(seq 1 90); do
  if mkdir tools/out/gpu.lock 2>/dev/null; then break; fi
  if [ -n "$(find tools/out/gpu.lock -maxdepth 0 -mmin +12 2>/dev/null)" ]; then rmdir tools/out/gpu.lock 2>/dev/null; fi
  sleep 20
done
node tools/inspect.mjs --nolock --name crit4-shadowfen-h --url http://127.0.0.1:5179/ --w 1920 --h 1080 --q high --script tools/scripts/_c4fenC.json > tools/out/crit4-shadowfen-h.runlog 2>&1
rc=$?
rmdir tools/out/gpu.lock 2>/dev/null
echo "DONE crit4-shadowfen-h rc=$rc"
