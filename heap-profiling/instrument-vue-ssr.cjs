// Temporary debug instrumentation of Vue's SSR code inside the dev container (NOT for commit; `npm ci` on container recreate undoes it).
// Logs "LEAKDBG ..." for every SSR error that Nuxt/Vue normally swallows: setup/render throws and every Vue handleError call.
// usage: docker cp scripts/heap-profiling/instrument-vue-ssr.cjs manager-front-app-1:/tmp/ && docker exec manager-front-app-1 node /tmp/instrument-vue-ssr.cjs
//        then `touch src/server/api/health.ts` so Nitro reloads the SSR worker, then grep the container logs for LEAKDBG.
const fs = require('fs')
const dir = process.env.VUE_DIR || '/app/node_modules/@vue'

const patch = (file, edits) => {
  let s = fs.readFileSync(`${dir}/${file}`, 'utf8')
  for (const [from, to] of edits) {
    if (!s.includes(from)) throw new Error(`${file}: anchor not found: ${from.slice(0, 60)}`)
    s = s.replace(from, to)
  }
  fs.writeFileSync(`${dir}/${file}`, s)
}

const handleErrorHead = 'function handleError(err, instance, type, throwInDev = true) {'
const handleErrorLog = `${handleErrorHead} console.error("LEAKDBG handleError type=" + type, instance && instance.type && instance.type.__file, err && (err.stack || err.message || err));`

patch('server-renderer/dist/server-renderer.cjs.js', [
  [
    `  pushWarningContext(vnode);
  const res = setupComponent(
    instance,
    true
    /* isSSR */
  );
  popWarningContext();`,
    `  pushWarningContext(vnode);
  let res;
  try {
    res = setupComponent(instance, true);
  } catch (e) {
    console.error("LEAKDBG setupComponent threw", vnode.type && (vnode.type.__file || vnode.type.name), e && e.stack);
    throw e;
  }
  popWarningContext();`
  ],
  [
    `      } finally {
        setCurrentRenderingInstance(prev);
      }
    } else if (instance.render`,
    `      } catch (e) {
        console.error("LEAKDBG ssrRender threw", instance.type && (instance.type.__file || instance.type.name), e && e.stack);
        throw e;
      } finally {
        setCurrentRenderingInstance(prev);
      }
    } else if (instance.render`
  ],
  [handleErrorHead, handleErrorLog]
])
patch('runtime-core/dist/runtime-core.cjs.js', [[handleErrorHead, handleErrorLog]])
console.log('patched')
