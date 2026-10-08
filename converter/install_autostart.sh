#!/usr/bin/env bash
set -e
BASE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/audio-auto-recorder-converter.service" <<UNIT
[Unit]
Description=Audio Auto Recorder MP3 converter
After=graphical-session.target

[Service]
Type=simple
ExecStart=$BASE/converter/start_converter.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now audio-auto-recorder-converter.service
systemctl --user --no-pager status audio-auto-recorder-converter.service || true
echo
echo 'Conversor configurado para iniciar automaticamente no login.'
