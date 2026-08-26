#!/bin/bash
# critic run: acquire GPU lock, ONE inspect, release immediately. Three cycles.
cd "C:/Users/ianca/Desktop/fps4/.claude/worktrees/cadle-character-load-perf-ee5b7b" || exit 1
acquire() {
  for i in $(seq 1 90); do
    if mkdir tools/out/gpu.lock 2>/dev/null; then return 0; fi
    if [ -n "$(find tools/out/gpu.lock -maxdepth 0 -mmin +12 2>/dev/null)" ]; then rmdir tools/out/gpu.lock 2>/dev/null; fi
    sleep 20
  done
  return 1
}
run() {
  local name="$1"; local script="$2"
  acquire || { echo "LOCK-FAIL $name"; return 1; }
  node tools/inspect.mjs --nolock --name "$name" --url http://127.0.0.1:5179/ --w 1920 --h 1080 --q high --script "$script" > "tools/out/${name}.runlog" 2>&1
  local rc=$?
  rmdir tools/out/gpu.lock 2>/dev/null
  echo "DONE $name rc=$rc"
}
run crit4-shadowfen tools/scripts/fin/shadowfen.json
run crit4-shadowfen-n tools/scripts/_c4fenA.json
run crit4-shadowfen-d tools/scripts/_c4fenB.json
echo ALLDONE
