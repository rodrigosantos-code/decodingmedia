#!/usr/bin/env python3
import os
import sys
import time
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSITIONS_DIR = os.path.join(BASE_DIR, 'Transitions')

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

def reverse_video(src_path, dst_path):
    print(f"[REVERSE TRIGGER] Reversing: {os.path.basename(src_path)} -> {os.path.basename(dst_path)}")
    probe = subprocess.run([FFMPEG_BIN, '-i', src_path], stderr=subprocess.PIPE, text=True)
    has_audio = 'Audio:' in probe.stderr

    cmd = [
        FFMPEG_BIN,
        '-y',
        '-i', src_path,
        '-vf', 'reverse',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart'
    ]
    if has_audio:
        cmd += ['-af', 'areverse', '-c:a', 'aac', '-b:a', '192k']
    else:
        cmd += ['-an']
    cmd.append(dst_path)

    t0 = time.time()
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elapsed = time.time() - t0
    if res.returncode == 0:
        print(f"[REVERSE TRIGGER] Successfully generated {os.path.basename(dst_path)} in {elapsed:.2f}s")
        return True
    else:
        print(f"[REVERSE TRIGGER] ERROR reversing {os.path.basename(src_path)}")
        return False

NUEVOS_DIR = os.path.join(BASE_DIR, 'Nuevos archivos')
PRESET2_DIR = os.path.join(BASE_DIR, 'presets', 'preset2')

# Map from user file names in "Nuevos archivos" to "Transitions" folder files
NUEVOS_TO_TRANSITIONS = {
    '16x9 a 3x4.mp4': '3x4_to_16x9_reverse.mp4',
    '3x4 a 16x9.mp4': '3x4_to_16x9.mp4',
    '16x9 a 9x16.mp4': '9x16_to_16x9_reverse.mp4',
    '9x16 a 16x9.mp4': '9x16_to_16x9.mp4',
    '9x16 a 3x4.mp4': '9x16_to_3x4.mp4',
    '3x4 a 9x16.mp4': '9x16_to_3x4_reverse.mp4',
    'Title a 16x9.mp4': 'title_to_16x9.mp4',
    '16x9 a Title.mp4': 'title_to_16x9_reverse.mp4',
    'Title a 3x4.mp4': 'title_to_3x4.mp4',
    '3x4 a Title.mp4': 'title_to_3x4_reverse.mp4',
    'Title a 9x16.mp4': 'title_to_9x16.mp4',
    '9x16 a Title.mp4': 'title_to_9x16_reverse.mp4',
}

def sync_nuevos_archivos():
    if not os.path.exists(NUEVOS_DIR):
        return
    os.makedirs(PRESET2_DIR, exist_ok=True)
    os.makedirs(TRANSITIONS_DIR, exist_ok=True)

    for f in os.listdir(NUEVOS_DIR):
        if f.startswith('.'):
            continue
        src = os.path.join(NUEVOS_DIR, f)
        if not os.path.isfile(src):
            continue

        # Sync to preset2
        dst_p2 = os.path.join(PRESET2_DIR, f)
        if not os.path.exists(dst_p2) or os.path.getmtime(src) > os.path.getmtime(dst_p2) or os.path.getsize(src) != os.path.getsize(dst_p2):
            import shutil
            shutil.copy2(src, dst_p2)
            print(f"[Sync Nuevos] Updated preset2/{f}")

        # Sync to Transitions if mapped
        if f in NUEVOS_TO_TRANSITIONS:
            trans_name = NUEVOS_TO_TRANSITIONS[f]
            dst_tr = os.path.join(TRANSITIONS_DIR, trans_name)
            if not os.path.exists(dst_tr) or os.path.getmtime(src) > os.path.getmtime(dst_tr) or os.path.getsize(src) != os.path.getsize(dst_tr):
                import shutil
                shutil.copy2(src, dst_tr)
                print(f"[Sync Nuevos] Updated Transitions/{trans_name} (from {f})")

def sync_transitions():
    sync_nuevos_archivos()
    if not os.path.exists(TRANSITIONS_DIR):
        return
    
    files = os.listdir(TRANSITIONS_DIR)
    for f in files:
        if f.startswith('.') or not f.endswith('.mp4') or f.endswith('_reverse.mp4'):
            continue
        
        src_path = os.path.join(TRANSITIONS_DIR, f)
        if not os.path.isfile(src_path):
            continue
        
        base_name = os.path.splitext(f)[0]
        dst_path = os.path.join(TRANSITIONS_DIR, f"{base_name}_reverse.mp4")
        
        # Check if reverse needs to be generated
        needs_build = False
        if not os.path.exists(dst_path):
            needs_build = True
        elif os.path.getmtime(src_path) > os.path.getmtime(dst_path):
            needs_build = True
            
        if needs_build:
            reverse_video(src_path, dst_path)

def main():
    print(f"[REVERSE TRIGGER] Watching directories:\n - {NUEVOS_DIR}\n - {TRANSITIONS_DIR}")
    
    # Run once initially
    sync_transitions()
    
    if '--once' in sys.argv:
        print("[REVERSE TRIGGER] Run once completed.")
        return

    print("[REVERSE TRIGGER] Daemon active. Polling for new files every 2 seconds...")
    try:
        while True:
            time.sleep(2)
            sync_transitions()
    except KeyboardInterrupt:
        print("[REVERSE TRIGGER] Daemon stopped.")

if __name__ == '__main__':
    main()
