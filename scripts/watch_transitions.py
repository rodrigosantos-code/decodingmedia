#!/usr/bin/env python3
import os
import sys
import time
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSITIONS_DIR = os.path.join(BASE_DIR, 'Transitions')
CACHE_DIR = os.path.join(TRANSITIONS_DIR, '.cache')
def find_ffmpeg():
    hitpaw = '/Applications/HitPaw VikPea.app/Contents/MacOS/ffmpeg'
    if os.path.isfile(hitpaw):
        return hitpaw
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    import shutil
    which = shutil.which('ffmpeg')
    if which:
        return which
    return 'ffmpeg'

FFMPEG_BIN = find_ffmpeg()

os.makedirs(CACHE_DIR, exist_ok=True)

def reverse_video(src_path, dst_path):
    print(f"[REVERSE TRIGGER] Reversing: {os.path.basename(src_path)} -> {os.path.basename(dst_path)}")
    cmd = [
        FFMPEG_BIN,
        '-y',
        '-i', src_path,
        '-vf', 'reverse',
        '-af', 'areverse',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        dst_path
    ]
    t0 = time.time()
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elapsed = time.time() - t0
    if res.returncode == 0:
        print(f"[REVERSE TRIGGER] Successfully generated {os.path.basename(dst_path)} in {elapsed:.2f}s")
        return True
    else:
        print(f"[REVERSE TRIGGER] ERROR reversing {os.path.basename(src_path)}")
        return False

def sync_transitions():
    if not os.path.exists(TRANSITIONS_DIR):
        return
    
    files = os.listdir(TRANSITIONS_DIR)
    for f in files:
        if f.startswith('.') or not f.endswith('.mp4'):
            continue
        
        src_path = os.path.join(TRANSITIONS_DIR, f)
        if not os.path.isfile(src_path):
            continue
        
        base_name = os.path.splitext(f)[0]
        dst_path = os.path.join(CACHE_DIR, f"{base_name}_reverse.mp4")
        
        # Check if reverse needs to be generated
        needs_build = False
        if not os.path.exists(dst_path):
            needs_build = True
        elif os.path.getmtime(src_path) > os.path.getmtime(dst_path):
            needs_build = True
            
        if needs_build:
            reverse_video(src_path, dst_path)

def main():
    print(f"[REVERSE TRIGGER] Watching directory: {TRANSITIONS_DIR}")
    print(f"[REVERSE TRIGGER] Output cache: {CACHE_DIR}")
    
    # Run once initially
    sync_transitions()
    
    if '--once' in sys.argv:
        print("[REVERSE TRIGGER] Run once completed.")
        return

    print("[REVERSE TRIGGER] Daemon active. Polling for new transition videos every 2 seconds...")
    try:
        while True:
            time.sleep(2)
            sync_transitions()
    except KeyboardInterrupt:
        print("[REVERSE TRIGGER] Daemon stopped.")

if __name__ == '__main__':
    main()
