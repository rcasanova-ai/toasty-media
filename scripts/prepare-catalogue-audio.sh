#!/usr/bin/env bash
# Prepare Toasty Asset Catalogue audio.
#
# Standard (preprocess, not runtime):
#   container/codec  Ogg Vorbis (libvorbis q=5)
#   sample rate      48000 Hz
#   channels         stereo (mono upmix / multi-channel downmix)
#   loudness         EBU R128 loudnorm I=-16 LUFS, TP=-1.5 dBTP, LRA=11
#
# Run from the repo root after placing originals under /tmp/toasty-sounds (see comments in
# assets/catalogue/catalogue.json). This script is the repeatable prep path; it is not a runtime
# dependency of Studio.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/catalogue/audio"
mkdir -p "$OUT"

normalize() {
  local in="$1" out="$2"
  local trim="${3:-}"
  local fade="${4:-}"
  local af="aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11"
  if [[ -n "$fade" ]]; then
    af="${af},afade=t=out:st=${fade}:d=0.25"
  fi
  local args=(-y -i "$in")
  if [[ -n "$trim" ]]; then
    args+=(-t "$trim")
  fi
  ffmpeg -hide_banner -loglevel error "${args[@]}" -af "$af" -c:a libvorbis -q:a 5 "$out"
  echo "wrote $out"
}

KENNEY_IFACE=/tmp/toasty-sounds/kenney-iface/kenney-interface-sounds-master/addons/kenney_interface_sounds
KENNEY_JINGLE=/tmp/toasty-sounds/kenney-jingles/OGG
RAW=/tmp/toasty-sounds/raw

normalize "$RAW/wiki/drum-roll.ogg" "$OUT/drum-roll-01.ogg"
normalize "$RAW/wiki/applause.wav" "$OUT/applause-01.ogg"
normalize "$RAW/wiki/cholo-whistle.ogg" "$OUT/cholo-whistle-01.ogg"
normalize "$RAW/wiki/applause-big.ogg" "$OUT/applause-big-01.ogg" 8.2 7.9
normalize "$RAW/wiki/crowd-cheer.oga" "$OUT/crowd-cheer-01.ogg"
normalize "$RAW/wiki/laughter.wav" "$OUT/laughter-01.ogg" 6.5 6.2
normalize "$RAW/freesound/comedy-rimshot.mp3" "$OUT/rimshot-01.ogg"
normalize "$RAW/freesound/air-horn.mp3" "$OUT/air-horn-01.ogg"
normalize "$RAW/wiki/buzzer.wav" "$OUT/buzzer-01.ogg"
normalize "$RAW/freesound/wrong-buzzer.mp3" "$OUT/wrong-buzzer-01.ogg"
normalize "$RAW/freesound/ding.mp3" "$OUT/ding-01.ogg"
normalize "$RAW/freesound/bell.mp3" "$OUT/bell-01.ogg"
normalize "$RAW/freesound/record-scratch.mp3" "$OUT/record-scratch-01.ogg"
normalize "$RAW/kenney-whoosh/woosh7.ogg" "$OUT/whoosh-01.ogg"
normalize "$RAW/kenney/impactPunch_heavy_000.ogg" "$OUT/impact-01.ogg"
normalize "$KENNEY_IFACE/confirmation_002.wav" "$OUT/success-chime-01.ogg"
normalize "$RAW/freesound/dramatic-stings.mp3" "$OUT/suspense-01.ogg" 2.2 1.9
normalize "$KENNEY_JINGLE/jingles_STEEL/jingles_STEEL01.ogg" "$OUT/intro-sting-01.ogg"
normalize "$KENNEY_JINGLE/jingles_SAX/jingles_SAX07.ogg" "$OUT/outro-sting-01.ogg"
normalize "$KENNEY_JINGLE/jingles_HIT/jingles_HIT11.ogg" "$OUT/transition-sting-01.ogg"
normalize "$RAW/incompetech/NewsSting.mp3" "$OUT/news-sting-01.ogg" 5.6 5.3

echo "=== normalized ==="
for f in "$OUT"/*.ogg; do
  d=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f")
  printf '%6.2fs  %s\n' "$d" "$(basename "$f")"
done
