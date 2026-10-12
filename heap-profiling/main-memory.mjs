const t = await (await fetch('http://127.0.0.1:9229/json')).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (m) => { const d = JSON.parse(m.data); console.log(JSON.stringify(d.result?.result?.value ?? d)); process.exit(0) }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(Object.fromEntries(Object.entries(process.memoryUsage()).map(([k,v])=>[k,Math.round(v/1048576)+"MB"])))', returnByValue: true } }))
