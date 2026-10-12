// usage (inside container): node main-heap.mjs 9229 usage | <out.heapsnapshot>  (main thread of the nuxi process; `usage` = heap numbers only)
import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
let id = 0; const pend = new Map(); let w
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'HeapProfiler.addHeapSnapshotChunk') w?.write(d.params.chunk); else if (d.id && pend.has(d.id)) pend.get(d.id)(d.result) }
await new Promise(r => ws.onopen = r)
const send = (method, params={}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
console.log(await send('Runtime.getHeapUsage'))
if (out !== 'usage') { await send('HeapProfiler.collectGarbage'); console.log(await send('Runtime.getHeapUsage')); w = fs.createWriteStream(out); await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); w.end() }
ws.close()
