# Điều tra memory leak của dev container (`manager-front-app-1`)

Bộ script + quy trình dùng để tìm memory leak của `nuxi dev` chạy trong docker. Đã dùng thành công ngày 2026-10-12.
Kết quả chi tiết ở cuối file.

## Kiến thức nền (quan trọng)

- Container chạy `npm ci && npm run dev` = **dev server**, không phải bản build production.
- Tiến trình `node .../nuxi dev` (RSS lớn nhất) chứa: Vite/Nuxt (main thread) **và Nitro SSR worker là một `worker_thread`**
  nằm trong cùng tiến trình. `process.memoryUsage()` của main thread **không thấy heap của worker** -> phải dùng domain `NodeWorker`
  của inspector (`worker-inspect.mjs`).
- PID trong `docker top` là PID của host/VM, **không dùng được** trong container. Dùng `enable-inspector.sh` (quét `/proc`).
- Image `node:24-slim` không có `ps`/`pgrep`. Node 24 có `fetch` và `WebSocket` global nên các script không cần dependency.
- Mỗi lần recreate container, `npm ci` chạy lại -> mọi patch trong `node_modules` biến mất, `/tmp` trong container cũng mất.

## Các file

| File | Chạy ở đâu | Dùng để |
|---|---|---|
| `enable-inspector.sh` | host | Copy script vào container và bật inspector (`kill -USR1`, cổng 9229 trong container) |
| `main-memory.mjs` | container | `process.memoryUsage()` của main thread (rss/heapUsed/external) |
| `main-heap.mjs` | container | `usage`: heap numbers; hoặc `<file>`: ghi heap snapshot của main thread |
| `main-sampling.mjs` | container | Sampling heap profiler của main thread trong N giây, in top allocation còn sống |
| `worker-inspect.mjs` | container | Như trên nhưng cho **SSR worker**: `mem` / `samp <giây>` / `snap` (ghi `/tmp/w.heapsnapshot`) |
| `analyze-snapshot.mjs` | host | Phân tích `.heapsnapshot`: đếm `vue-router` còn sống, in retaining path từ GC root, dump stack warning của Vue |
| `instrument-vue-ssr.cjs` | container | Patch tạm Vue SSR để log mọi lỗi SSR bị nuốt (`LEAKDBG`) |
| `cpu-profile.mjs` | container | `main\|worker <giây>`: CPU profile (CDP `Profiler`) của main thread hoặc SSR worker, ghi `/tmp/<target>.cpuprofile` và in top self-time |
| `analyze-cpuprofile.mjs` | host | `<file> [topN] [regex]`: xếp hạng theo inclusive time (self + hàm con) từ `.cpuprofile` |

Tải tạo leak: `scripts/selenium/login_session_test.py` (docstring đầu file mô tả các biến môi trường). Cần
`MANAGER_FRONT_PASSWORD`; chạy bằng `.venv/bin/python -u`.

## Quy trình

Lưu ý khi chạy: mỗi bước tải mất vài phút (ghi rõ bên dưới). Thông báo thời gian chờ cho người dùng trước khi chờ.

1. **Xác nhận có leak và nằm ở tiến trình nào** (~7-8 phút cho 4 instance x 400 giây):
   ```sh
   REFRESH_DURATION_SECONDS=400 NUM_INSTANCES=4 .venv/bin/python -u scripts/selenium/login_session_test.py > /tmp/load.log 2>&1 &
   for i in 1 2 3 4 5 6 7 8; do sleep 60; docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' manager-front-app-1; done
   docker exec manager-front-app-1 sh -c 'for d in /proc/[0-9]*; do echo "${d#/proc/} $(grep VmRSS $d/status | tr -s " " | cut -d" " -f2) $(tr "\0" " " < $d/cmdline | cut -c1-80)"; done'
   ```
   Dấu hiệu leak thật: RAM **không giảm** sau khi dừng tải (idle vẫn cao).
2. **Bật inspector**: `scripts/heap-profiling/enable-inspector.sh`
3. **Chia heap JS và native**: `docker exec manager-front-app-1 node /tmp/main-memory.mjs` rồi `node /tmp/worker-inspect.mjs mem`.
   Nếu RSS >> heapUsed của main thì phần còn lại nằm ở worker.
4. **Sampling** (cần tải chạy song song; sampler chạy N giây rồi in kết quả, **một phiên inspector duy nhất** vì ngắt kết nối là dừng sampling):
   ```sh
   (docker exec manager-front-app-1 node /tmp/worker-inspect.mjs samp 150 > /tmp/wk.out 2>&1 &)   # đợi ~150 giây
   REFRESH_DURATION_SECONDS=150 NUM_INSTANCES=4 .venv/bin/python -u scripts/selenium/login_session_test.py > /tmp/load.log 2>&1
   ```
   `main-sampling.mjs <giây>` làm tương tự cho main thread. Lần điều tra này: main thread -> `vite-plugin-inspect`,
   worker -> `createRouter`/`tokensToParser` (vue-router) bị giữ lại.
5. **Tìm ai giữ đối tượng (retainer)**: lấy snapshot khi heap còn nhỏ (recreate container, chạy tải ~45 giây rồi snapshot), vì
   `JSON.parse` giới hạn chuỗi ~512MB:
   ```sh
   docker exec manager-front-app-1 node /tmp/worker-inspect.mjs snap
   docker cp manager-front-app-1:/tmp/w.heapsnapshot /tmp/w.heapsnapshot
   node --max-old-space-size=6000 scripts/heap-profiling/analyze-snapshot.mjs /tmp/w.heapsnapshot
   ```
   Snapshot ~100-300MB; đừng chụp khi heap đã nhiều trăm MB trong container giới hạn ~3.8GB (dễ OOM).
6. **Bắt lỗi SSR bị nuốt**: copy + chạy `instrument-vue-ssr.cjs` trong container, `touch src/server/api/health.ts` để Nitro reload worker,
   chạy tải, rồi `docker logs manager-front-app-1 2>&1 | grep -a LEAKDBG`. Kiểm tra patch an toàn trước bằng `VUE_DIR=<bản copy>`.
7. **Sửa -> verify**: recreate container sạch (`docker compose up -d --force-recreate app`), warm-up bằng `curl http://localhost:3000/`
   (lần đăng nhập Selenium đầu tiên khi cold start có thể thất bại, chạy lại), lặp lại bước 1.

Gotcha của inspector: `HeapProfiler.getSamplingHeapProfile` không tồn tại ở Node này, profile được trả về bởi `stopSampling`.

## Điều tra CPU

Sau `enable-inspector.sh`, chạy profiler (dài hơn tải ~30 giây vì pha login không spam) cùng lúc với tải, mỗi target một lần:
```sh
(docker exec manager-front-app-1 node /tmp/cpu-profile.mjs worker 170 > /tmp/cpu-worker.out 2>&1 &)
TEST_DURATION_SECONDS=140 NUM_INSTANCES=4 TABS_PER_INSTANCE=5 selenium/.venv/bin/python -u selenium/login_session_test.py
docker cp manager-front-app-1:/tmp/worker.cpuprofile /tmp/ && node heap-profiling/analyze-cpuprofile.mjs /tmp/worker.cpuprofile 40
```
Lặp lại với `main`; đợi profiler trước chạy xong (file `.cpuprofile` xuất hiện) rồi mới chạy cái sau. `.cpuprofile` mở được bằng Chrome DevTools (Performance) hoặc speedscope.

## Kết quả điều tra 2026-10-12

Nguyên nhân gốc:
1. `@vue/server-renderer` 3.5.13 (chỉ dev): `renderComponentVNode`/`renderComponentSubTree` gọi `pushWarningContext` nhưng không
   `popWarningContext` trong `finally`. Mỗi lỗi setup/render SSR để lại vnode trong `stack` của runtime-core, giữ cả app và router.
   Bản `main` upstream chưa sửa. Không ảnh hưởng production.
2. Lỗi SSR đến từ việc mất Nuxt context sau `await` (`useCookie`/`useRuntimeConfig` -> "A composable that requires access to
   the Nuxt instance was called outside..."). Nuxt nuốt lỗi nên log không hiện.
3. Phụ: `vite-plugin-inspect` (kèm devtools) giữ bản ghi theo request.

Đã sửa:
- `nuxt.config.ts`: `experimental.asyncContext: true`; devtools tắt bằng env `DISABLE_DEVTOOLS=true` (đặt trong `docker-compose.yml`).
- `src/composables/useAccessPermisstion.ts`: `checkPagePermission` gọi `optionSetting()` trước `await`.
- `docker-compose.yml`: `MALLOC_ARENA_MAX=2` (giảm nhẹ RSS, không bắt buộc).

Kết quả (4 instance, 7 phút): đỉnh RAM 3.15GB và không giảm -> 2.05GB, về 1.68GB khi idle.
