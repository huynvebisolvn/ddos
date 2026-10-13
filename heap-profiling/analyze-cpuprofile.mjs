// usage (host): node analyze-cpuprofile.mjs <file.cpuprofile> [topN] [filter]; top functions by inclusive time (self+callees), optionally only names matching /filter/
import fs from 'node:fs'
const [file, topN = '40', filter] = process.argv.slice(2)
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
const self = new Map()
p.samples.forEach((s, i) => self.set(s, (self.get(s) || 0) + p.timeDeltas[i]))
const total = [...self.values()].reduce((a, b) => a + b, 0)
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*(node_modules|src)\//, '')}:${n.callFrame.lineNumber}`
const inc = new Map()
for (const [id, us] of self) {
  const seen = new Set()
  for (let x = id; x; x = parent.get(x)) {
    const k = name(byId.get(x))
    if (!seen.has(k)) { seen.add(k); inc.set(k, (inc.get(k) || 0) + us) }
  }
}
const re = filter && new RegExp(filter)
let rows = [...inc].sort((a, b) => b[1] - a[1])
if (re) rows = rows.filter(([k]) => re.test(k))
for (const [k, v] of rows.slice(0, Number(topN))) console.log(((v / total) * 100).toFixed(1).padStart(5) + '%', k.slice(0, 120))
