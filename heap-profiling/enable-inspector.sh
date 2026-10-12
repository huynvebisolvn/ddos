#!/bin/sh
# Enables the Node inspector (port 9229, container-local) on the `nuxi dev` process of the dev container.
# usage: scripts/heap-profiling/enable-inspector.sh [container]   (default: manager-front-app-1)
# Also copies the helper scripts to /tmp inside the container.
C="${1:-manager-front-app-1}"
DIR="$(cd "$(dirname "$0")" && pwd)"
for f in main-heap.mjs main-memory.mjs main-sampling.mjs worker-inspect.mjs; do
  docker cp "$DIR/$f" "$C:/tmp/$f"
done
# host PIDs from `docker top` differ from in-container PIDs, so scan /proc inside the container
docker exec "$C" sh -c '
  for d in /proc/[0-9]*; do
    if tr "\0" " " < $d/cmdline | grep -q "^node /app/node_modules/.bin/nuxi dev"; then P=${d#/proc/}; fi
  done
  [ -n "$P" ] || { echo "nuxi dev process not found"; exit 1; }
  kill -USR1 $P
  echo "inspector enabled on pid $P (ws://127.0.0.1:9229 inside the container)"
'
