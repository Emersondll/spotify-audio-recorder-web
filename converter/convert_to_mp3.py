#!/usr/bin/env python3
import os, time, subprocess
from pathlib import Path

home = Path.home()
downloads = Path(os.environ.get('XDG_DOWNLOAD_DIR', home / 'Downloads'))
src = downloads / 'Audio Auto Recorder' / 'recording_tmp'
dst = downloads / 'Audio Auto Recorder'
src.mkdir(parents=True, exist_ok=True)
dst.mkdir(parents=True, exist_ok=True)
print('Audio Auto Recorder MP3 converter')
print('Origem:', src)
print('Destino:', dst)

def convert(f):
    out = dst / (f.stem + '.mp3')
    if out.exists():
        i=2
        while (dst / f'{f.stem} ({i}).mp3').exists(): i+=1
        out=dst / f'{f.stem} ({i}).mp3'
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(f),'-vn','-codec:a','libmp3lame','-q:a','2',str(out)]
    subprocess.run(cmd, check=True)
    f.unlink()
    print('OK:', out)

while True:
    for f in src.glob('*.webm'):
        try:
            if f.stat().st_size < 1000: continue
            # Chrome only exposes the final .webm after its download is complete.
            convert(f)
        except Exception as e:
            print('ERRO:', f, e)
    time.sleep(1)
