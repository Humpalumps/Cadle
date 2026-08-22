#!/bin/bash
# retry wrapper: the box's headless chromium dies sporadically mid-run
name=$1; shift
for i in 1 2 3 4; do
  powershell.exe -NoProfile -Command "Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1
  node tools/inspect.mjs --nolock --name "$name" "$@" > /tmp/run-$name.txt 2>&1
  if ! grep -q "has been closed" tools/out/$name/report.json; then tail -6 /tmp/run-$name.txt; exit 0; fi
  echo "retry $i (browser died)"
done
tail -4 /tmp/run-$name.txt; exit 1
