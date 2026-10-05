#!/bin/sh
# Reads an RTSP stream for a while and checks that packet timestamps never go
# backwards or jump, in particular across the point where the looped file
# restarts.
# Usage: check-rtsp.sh <machine_id> <seconds> <video-length-seconds>
set -eu

machine="${1:?usage: check-rtsp.sh <machine_id> <seconds> <video-length-seconds>}"
seconds="${2:?seconds to read}"
length="${3:?length of the looped video in seconds}"
url="${RTSP_BASE_URL:-rtsp://mediamtx:8554}/$machine"

packets="$(mktemp)"
trap 'rm -f "$packets"' EXIT

ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
  -show_entries packet=pts_time,flags -of csv=p=0 \
  -read_intervals "%+$seconds" "$url" >"$packets"

awk -F, -v machine="$machine" -v video_len="$length" '
  $1 == "N/A" { next }
  {
    pts = $1 + 0
    if (n == 0) first = pts
    if (n > 0) {
      step = pts - last
      if (step <= 0) { backwards++; if (!shown++) printf "  pts went from %.3f to %.3f\n", last, pts }
      if (step > max_step) max_step = step
    }
    if ($2 ~ /K/) keyframes++
    last = pts; n++
  }
  END {
    span = last - first
    loops = int(span / video_len)
    printf "%s: %d packets over %.1f s, %d keyframes, largest step %.3f s, %d loop point(s) crossed\n",
      machine, n, span, keyframes, max_step, loops
    if (n == 0)        { print "FAIL: no packets read"; exit 1 }
    if (backwards > 0) { printf "FAIL: timestamps went backwards %d time(s)\n", backwards; exit 1 }
    if (max_step > 1)  { print "FAIL: timestamp jump larger than 1 s"; exit 1 }
    if (loops < 1)     { print "FAIL: the read did not cross a loop point"; exit 1 }
    print "OK"
  }' "$packets"
