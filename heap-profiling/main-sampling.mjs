// usage (inside container): node main-sampling.mjs 9229 <seconds>; sample live allocations of the main thread for N seconds in one inspector session (run the load test meanwhile)
const [port, secs] = process.argv.slice(2)
const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pend.has(d.id)) pend.get(d.id)(d)
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pend.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
console.log(JSON.stringify(await send('HeapProfiler.startSampling', { samplingInterval: 32768 })))
await new Promise((r) => setTimeout(r, Number(secs) * 1000))
await send('HeapProfiler.collectGarbage')
const res = await send('HeapProfiler.stopSampling')
if (!res.result) {
  console.log(JSON.stringify(res))
  process.exit(1)
}
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
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15)) {
  console.log((v.size / 1048576).toFixed(1) + 'MB', k, '\n    ', v.stack.slice(0, 400))
}
ws.close()
