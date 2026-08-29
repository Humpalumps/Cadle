import io, re

def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ---------------------------------------------------------------- CLAUDE.md
# Take origin/main's whole block (four rules this branch never had: the creature-GLB route change, the
# img2threejs gate, the tiered tri budget, the three-distance acceptance) and keep only ONE thing from
# ours: the documented asset-loader exception, which main still points at the intro this branch deleted.
p = 'CLAUDE.md'
s = rd(p)
a = s.index('<<<<<<< HEAD')
m = s.index('\n=======\n', a)
b = s.index('>>>>>>> origin/main\n', m)
theirs = s[m + len('\n=======\n'):b]
old = ('**One documented exception: the intro loading screen** (`src/ui/intro/stage.js`) loads its own '
       '287 KB set from `public/assets/intro/` — it is on screen *while* `game.assets` is still preloading, '
       'so it cannot wait for it; see ASSETS.md.')
new = ('**One documented exception: the title screen** (`src/ui/Menu.js` / `menu/backdropWorker.js`) fetches '
       'its single backdrop still, `public/assets/ui/menu_vista.jpg` — it is on screen *while* `game.assets` '
       'is still preloading, so it cannot wait for it; see ASSETS.md.')
assert old in theirs, 'CLAUDE.md: intro-exception sentence not found'
theirs = theirs.replace(old, new)
s = s[:a] + theirs + s[b + len('>>>>>>> origin/main\n'):]
wr(p, s)
print('CLAUDE.md resolved, markers left:', s.count('<<<<<<<') + s.count('>>>>>>>'))
