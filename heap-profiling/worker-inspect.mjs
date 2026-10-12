// usage (inside container): node worker-inspect.mjs mem | samp <SECONDS> | snap (writes /tmp/w.heapsnapshot); inspects the first nitro worker thread of the nuxi process via NodeWorker domain
const [mode, secs] = process.argv.slice(2)
const t = await (await fetch('http://127.0.0.1:9229/json')).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0, inner = 0, sessionId
import fs from 'node:fs'
const out = mode === 'snap' ? fs.createWriteStream('/tmp/w.heapsnapshot') : null
const pend = new Map()
const innerPend = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'NodeWorker.attachedToWorker') sessionId = d.params.sessionId
  else if (d.method === 'NodeWorker.receivedMessageFromWorker') {
    const x = JSON.parse(d.params.message)
    if (x.method === 'HeapProfiler.addHeapSnapshotChunk') out.write(x.params.chunk)
    if (x.id && innerPend.has(x.id)) innerPend.get(x.id)(x)
  } else if (d.id && pend.has(d.id)) pend.get(d.id)(d)
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const wsend = (method, params = {}) => new Promise((r) => { const i = ++inner; innerPend.set(i, r); send('NodeWorker.sendMessageToWorker', { sessionId, message: JSON.stringify({ id: i, method, params }) }) })
await send('NodeWorker.enable', { waitForDebuggerOnStart: false })
await new Promise((r) => setTimeout(r, 500))
if (!sessionId) { console.log('no worker attached'); process.exit(1) }
const mem = async () => console.log((await wsend('Runtime.evaluate', { expression: 'JSON.stringify(Object.fromEntries(Object.entries(process.memoryUsage()).map(([k,v])=>[k,Math.round(v/1048576)+"MB"])))', returnByValue: true })).result.result.value)
await mem()
if (mode === 'snap') {
  await wsend('HeapProfiler.collectGarbage')
  await wsend('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await new Promise((r) => out.end(r))
}
if (mode === 'samp') {
  await wsend('HeapProfiler.startSampling', { samplingInterval: 32768 })
  await new Promise((r) => setTimeout(r, Number(secs) * 1000))
  await wsend('HeapProfiler.collectGarbage')
  const res = await wsend('HeapProfiler.stopSampling')
  const agg = new Map()
  const walk = (n, stack) => {
    const cf = n.callFrame
    const s = [...stack, `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*node_modules\//, 'nm/')}:${cf.lineNumber}`]
    if (n.selfSize) {
      const k = s[s.length - 1]
      const e = agg.get(k) || { size: 0, stack: s.slice(-6).reverse().join(' <- ') }
      e.size += n.selfSize
      agg.set(k, e)
    }
    n.children.forEach((c) => walk(c, s))
  }
  walk(res.result.profile.head, [])
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 12)) console.log((v.size / 1048576).toFixed(1) + 'MB', k, '\n    ', v.stack.slice(0, 380))
  await mem()
}
process.exit(0)
