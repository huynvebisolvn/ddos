// usage (inside container): node cpu-profile.mjs <main|worker> <SECONDS>; records a CPU profile of the nuxi main thread or the nitro SSR worker (via NodeWorker) while the load test runs, writes /tmp/<target>.cpuprofile and prints top self-time functions
import fs from 'node:fs'
const [target, secs] = process.argv.slice(2)
const t = await (await fetch('http://127.0.0.1:9229/json')).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0, inner = 0, sessionId
const pend = new Map()
const innerPend = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'NodeWorker.attachedToWorker') sessionId = d.params.sessionId
  else if (d.method === 'NodeWorker.receivedMessageFromWorker') {
    const x = JSON.parse(d.params.message)
    if (x.id && innerPend.has(x.id)) innerPend.get(x.id)(x)
  } else if (d.id && pend.has(d.id)) pend.get(d.id)(d)
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const wsend = (method, params = {}) => new Promise((r) => { const i = ++inner; innerPend.set(i, r); send('NodeWorker.sendMessageToWorker', { sessionId, message: JSON.stringify({ id: i, method, params }) }) })
if (target === 'worker') {
  await send('NodeWorker.enable', { waitForDebuggerOnStart: false })
  await new Promise((r) => setTimeout(r, 500))
  if (!sessionId) { console.log('no worker attached'); process.exit(1) }
}
const call = target === 'worker' ? wsend : send
await call('Profiler.enable')
await call('Profiler.setSamplingInterval', { interval: 1000 })
await call('Profiler.start')
await new Promise((r) => setTimeout(r, Number(secs) * 1000))
const res = await call('Profiler.stop')
if (!res.result) { console.log(JSON.stringify(res)); process.exit(1) }
const { nodes, samples, timeDeltas } = res.result.profile
fs.writeFileSync(`/tmp/${target}.cpuprofile`, JSON.stringify(res.result.profile))

const byId = new Map(nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of nodes) for (const c of n.children || []) parent.set(c, n.id)
const selfUs = new Map()
samples.forEach((s, i) => selfUs.set(s, (selfUs.get(s) || 0) + timeDeltas[i]))
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*node_modules\//, 'nm/')}:${n.callFrame.lineNumber}`

const total = [...selfUs.values()].reduce((a, b) => a + b, 0)
const agg = new Map()
for (const [nid, us] of selfUs) {
  const n = byId.get(nid)
  const k = name(n)
  const e = agg.get(k) || { us: 0, stack: '' }
  e.us += us
  if (!e.stack) {
    const chain = []
    for (let p = parent.get(nid), d = 0; p && d < 6; p = parent.get(p), d++) chain.push(name(byId.get(p)))
    e.stack = chain.join(' <- ')
  }
  agg.set(k, e)
}
const pct = (us) => ((us / total) * 100).toFixed(1) + '%'
console.log(`sampled ${(total / 1e6).toFixed(1)}s`)
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].us - a[1].us).slice(0, 25)) {
  console.log(pct(v.us), k, '\n    ', v.stack.slice(0, 400))
}
process.exit(0)
