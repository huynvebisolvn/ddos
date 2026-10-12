// usage (on host): node --max-old-space-size=6000 analyze-snapshot.mjs file.heapsnapshot
// finds vue-router instances and prints the shortest retaining path from GC roots for a few of them
import fs from 'node:fs'
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const m = snap.snapshot.meta
const nf = m.node_fields, ef = m.edge_fields
const NF = nf.length, EF = ef.length
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings
const nType = m.node_types[0], eType = m.edge_types[0]
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iEC = nf.indexOf('edge_count'), iSize = nf.indexOf('self_size')
const eiType = ef.indexOf('type'), eiName = ef.indexOf('name_or_index'), eiTo = ef.indexOf('to_node')
const N = nodes.length / NF
const first = new Uint32Array(N + 1)
for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += nodes[i * NF + iEC] }
first[N] = edges.length / EF
const edgeName = (e) => { const t = eType[edges[e * EF + eiType]]; const v = edges[e * EF + eiName]; return t === 'element' || t === 'hidden' ? `[${v}]` : strings[v] }
const nodeName = (n) => `${nType[nodes[n * NF + iType]]}:${strings[nodes[n * NF + iName]]}`
// routers: objects having property edges addRoute + beforeEach + currentRoute
const routers = []
for (let n = 0; n < N; n++) {
  if (nType[nodes[n * NF + iType]] !== 'object') continue
  let a = 0
  for (let e = first[n]; e < first[n + 1]; e++) {
    const t = eType[edges[e * EF + eiType]]
    if (t !== 'property') continue
    const nm = strings[edges[e * EF + eiName]]
    if (nm === 'addRoute' || nm === 'beforeEach' || nm === 'currentRoute') a++
  }
  if (a === 3) routers.push(n)
}
console.log('routers alive:', routers.length)
// BFS from root skipping weak edges
const parent = new Int32Array(N).fill(-1), pedge = new Int32Array(N).fill(-1)
const q = [0]; parent[0] = 0
for (let h = 0; h < q.length; h++) {
  const n = q[h]
  for (let e = first[n]; e < first[n + 1]; e++) {
    if (eType[edges[e * EF + eiType]] === 'weak') continue
    const to = edges[e * EF + eiTo] / NF
    if (parent[to] === -1) { parent[to] = n; pedge[to] = e; q.push(to) }
  }
}
const seen = new Set()
let shown = 0
for (const r of routers) {
  const path = []
  for (let n = r; n !== 0 && parent[n] !== -1; n = parent[n]) path.push(`${nodeName(n)} <-[${edgeName(pedge[n])}]-`)
  const key = path.slice(0, 12).map((p) => p.replace(/\d+/g, '#')).join('|')
  if (seen.has(key)) continue
  seen.add(key)
  console.log('--- router node', r, 'path len', path.length)
  console.log(path.slice(0, 25).join('\n'))
  if (++shown >= 3) break
}

// dump Vue warning-context stack: array reached via a 'stack' property edge from a Context
const prop = (n, name) => { for (let e = first[n]; e < first[n + 1]; e++) if (edgeName(e) === name) return edges[e * EF + eiTo] / NF; return -1 }
const str = (n) => (n < 0 ? '?' : strings[nodes[n * NF + iName]])
for (let n = 0; n < N; n++) {
  for (let e = first[n]; e < first[n + 1]; e++) {
    if (eType[edges[e * EF + eiType]] === 'context' && strings[edges[e * EF + eiName]] === 'stack') {
      const arr = edges[e * EF + eiTo] / NF
      if (nodeName(arr) !== 'object:Array') continue
      const cnt = []
      const holder = arr
      for (let k = first[holder]; k < first[holder + 1]; k++) {
        if (eType[edges[k * EF + eiType]] !== 'element') continue
        const vn = edges[k * EF + eiTo] / NF
        const type = prop(vn, 'type')
        cnt.push(str(prop(type, '__file')) !== '?' ? str(prop(type, '__file')) : str(prop(type, 'name')) + '/' + str(prop(type, '__name')))
      }
      const freq = {}
      cnt.forEach((c) => (freq[c] = (freq[c] || 0) + 1))
      console.log('stack array node', arr, 'len', cnt.length, Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12))
    }
  }
}
