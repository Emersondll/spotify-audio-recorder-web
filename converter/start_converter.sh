#!/usr/bin/env bash
set -e
command -v ffmpeg >/dev/null || { echo 'Instale: sudo apt install ffmpeg'; exit 1; }
exec python3 "$(dirname "$0")/convert_to_mp3.py"
