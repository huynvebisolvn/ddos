// usage (host): node --max-old-space-size=8000 compare-interceptors.mjs A.heapsnapshot B.heapsnapshot
// Both snapshots must come from the same process: node ids are stable there, so a handler present in both was never released.
import fs from 'node:fs'

const handlers = (file) => {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { node_fields: nf, edge_fields: ef, node_types, edge_types } = snap.snapshot.meta
  const NF = nf.length, EF = ef.length
  const { nodes, edges, strings } = snap
  const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iId = nf.indexOf('id'), iEC = nf.indexOf('edge_count')
  const eiType = ef.indexOf('type'), eiName = ef.indexOf('name_or_index'), eiTo = ef.indexOf('to_node')
  const N = nodes.length / NF
  const first = new Uint32Array(N + 1)
  for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += nodes[i * NF + iEC] }
  first[N] = edges.length / EF
  const prop = (n, name) => {
    for (let e = first[n]; e < first[n + 1]; e++) {
      const t = edge_types[0][edges[e * EF + eiType]]
      if ((t === 'property' || t === 'context') && strings[edges[e * EF + eiName]] === name) return edges[e * EF + eiTo] / NF
    }
    return -1
  }
  const kind = new Map()
  for (let e = 0; e < edges.length / EF; e++) {
    if (edge_types[0][edges[e * EF + eiType]] !== 'property') continue
    const nm = strings[edges[e * EF + eiName]]
    if (nm === 'request' || nm === 'response') kind.set(edges[e * EF + eiTo] / NF, nm)
  }
  const out = { request: [], response: [] }
  for (let n = 0; n < N; n++) {
    if (!kind.has(n)) continue
    const h = prop(n, 'handlers')
    if (h < 0) continue
    for (let k = first[h]; k < first[h + 1]; k++) {
      if (edge_types[0][edges[k * EF + eiType]] !== 'element') continue
      const el = edges[k * EF + eiTo] / NF
      if (node_types[0][nodes[el * NF + iType]] !== 'object') continue
      const fn = prop(el, 'fulfilled')
      out[kind.get(n)].push({ id: nodes[el * NF + iId], fn: fn < 0 ? '?' : strings[nodes[fn * NF + iName]] })
    }
  }
  return out
}

const [fa, fb] = process.argv.slice(2)
const A = handlers(fa)
const B = handlers(fb)
for (const kind of ['request', 'response']) {
  const idsB = new Set(B[kind].map((h) => h.id))
  const kept = A[kind].filter((h) => idsB.has(h.id)).length
  console.log(`${kind}: A=${A[kind].length} B=${B[kind].length} new in B=${B[kind].length - kept}; A handlers still alive in B: ${kept}/${A[kind].length}`)
}
