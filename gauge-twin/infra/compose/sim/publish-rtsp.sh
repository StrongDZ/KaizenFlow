#!/bin/sh
# Publishes every $VIDEO_DIR/<machine_id>/video.mp4 as an endless RTSP stream
# $RTSP_BASE_URL/<machine_id>. The video is stream-copied, never re-encoded,
# so the camera feed is exactly what the renderer produced.
set -eu

: "${RTSP_BASE_URL:?RTSP_BASE_URL is required}"
: "${VIDEO_DIR:?VIDEO_DIR is required}"

pids=""
stop() {
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  pkill -x ffmpeg 2>/dev/null || true
  exit 0
}
trap stop TERM INT

publish() {
  machine="$1"
  video="$2"
  while true; do
    # -re paces the file at its native frame rate; -stream_loop -1 repeats it
    # with continuous timestamps.
    ffmpeg -nostdin -hide_banner -loglevel warning \
      -re -stream_loop -1 -i "$video" \
      -c copy -f rtsp -rtsp_transport tcp "$RTSP_BASE_URL/$machine" || true
    echo "ffmpeg for $machine exited, restarting in 2 s" >&2
    sleep 2
  done
}

count=0
for video in "$VIDEO_DIR"/*/video.mp4; do
  [ -f "$video" ] || continue
  machine="$(basename "$(dirname "$video")")"
  publish "$machine" "$video" &
  pids="$pids $!"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "no videos found in $VIDEO_DIR (run make render first)" >&2
  exit 1
fi
echo "publishing $count stream(s) to $RTSP_BASE_URL"
wait
