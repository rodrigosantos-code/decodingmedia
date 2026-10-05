#!/usr/bin/env python3
"""
Generate selective color variants for preset frames.
Rotates strictly the neon pink/magenta doodles (Hue ~ 315°),
leaving skin tones (Hue ~ 16°), neutral dark background, and white art 100% untouched.
"""
import os
import sys
import time
from PIL import Image
import numpy as np

# Mapped hue IDs and their exact perceptual rotations to achieve the intended named color from the base 303° magenta pink:
HUES = [
    # (id/folder, name, rotation_deg, saturation_multiplier)
    (30, 'Rojo', 58.0, 1.10),     # 303° + 58° = 361° (1° pure fiery red, no pink)
    (60, 'Naranja', 88.0, 1.05),  # 303° + 88° = 391° (31° warm orange)
    (95, 'Amarillo', 112.0, 1.0), # 303° + 112° = 415° (55° bright yellow)
    (150, 'Verde', 182.0, 1.0),   # 303° + 182° = 485° (125° emerald green)
    (200, 'Cian', 242.0, 1.0),    # 303° + 242° = 545° (185° crisp cyan)
    (240, 'Azul', 282.0, 1.05),   # 303° + 282° = 585° (225° royal blue)
    (280, 'Morado', 327.0, 1.05)  # 303° + 327° = 630° (270° deep purple)
]

FRAME_FILES = [
    'Title.png',
    '3x4.png',
    '3x4_sinfondo.png',
    '9x16.png',
    '9x16_sinfondo.png',
    '16x9.png',
    '16x9_sinfondo.png'
]

def shift_pink_hue(im, hue_deg, sat_mult=1.0):
    im_rgba = im.convert('RGBA')
    arr = np.array(im_rgba, dtype=np.float32) / 255.0
    r, g, b, a = arr[:,:,0], arr[:,:,1], arr[:,:,2], arr[:,:,3]

    # Vectorized RGB to HSV
    maxc = np.maximum(np.maximum(r, g), b)
    minc = np.minimum(np.minimum(r, g), b)
    v = maxc
    deltac = maxc - minc
    s = np.zeros_like(v)
    nonzero = maxc != 0
    s[nonzero] = deltac[nonzero] / maxc[nonzero]

    h = np.zeros_like(v)
    rc = np.zeros_like(v)
    gc = np.zeros_like(v)
    bc = np.zeros_like(v)
    deltac_nz = deltac != 0
    rc[deltac_nz] = (maxc[deltac_nz] - r[deltac_nz]) / deltac[deltac_nz]
    gc[deltac_nz] = (maxc[deltac_nz] - g[deltac_nz]) / deltac[deltac_nz]
    bc[deltac_nz] = (maxc[deltac_nz] - b[deltac_nz]) / deltac[deltac_nz]

    mask_r = (r == maxc) & deltac_nz
    mask_g = (g == maxc) & deltac_nz
    mask_b = (b == maxc) & deltac_nz

    h[mask_r] = bc[mask_r] - gc[mask_r]
    h[mask_g] = 2.0 + rc[mask_g] - bc[mask_g]
    h[mask_b] = 4.0 + gc[mask_b] - rc[mask_b]
    h = (h / 6.0) % 1.0

    # Pink/Magenta is centered around 303° (0.843).
    # Range is roughly 270° (0.75) to 350° (0.97).
    # Skin tones are around 10° to 38° (0.028 to 0.105), completely outside this range.
    h_dist = np.abs(h - 0.843)
    pink_h_mask = np.clip(1.0 - (h_dist / 0.12), 0.0, 1.0)
    s_gate = np.clip((s - 0.20) / 0.15, 0.0, 1.0)
    v_gate = np.clip((v - 0.15) / 0.15, 0.0, 1.0)

    soft_mask = pink_h_mask * s_gate * v_gate

    # Rotate pink hue by hue_deg
    h_new = (h + (hue_deg / 360.0)) % 1.0
    s_new = np.clip(s * sat_mult, 0.0, 1.0)

    # Convert rotated HSV back to RGB
    hi = np.floor(h_new * 6.0).astype(int) % 6
    f = (h_new * 6.0) - np.floor(h_new * 6.0)
    p = v * (1.0 - s_new)
    q = v * (1.0 - f * s_new)
    t = v * (1.0 - (1.0 - f) * s_new)

    r_rot = np.choose(hi, [v, q, p, p, t, v])
    g_rot = np.choose(hi, [t, v, v, q, p, p])
    b_rot = np.choose(hi, [p, p, t, v, v, q])

    rgb_rot = np.stack([r_rot, g_rot, b_rot], axis=2)
    rgb_orig = np.stack([r, g, b], axis=2)

    final_rgb = rgb_orig * (1.0 - soft_mask[:,:,None]) + rgb_rot * soft_mask[:,:,None]
    final_rgba = np.dstack([final_rgb, a])

    return Image.fromarray(np.uint8(np.clip(final_rgba * 255.0, 0, 255)))

def main():
    force_all = '--force' in sys.argv
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'presets', 'preset2'))
    colors_dir = os.path.join(base_dir, 'colors')
    os.makedirs(colors_dir, exist_ok=True)

    print(f"Generating color variants in {colors_dir} (force={force_all})...")
    start_total = time.time()

    # Pre-load base images
    base_images = {}
    for filename in FRAME_FILES:
        filepath = os.path.join(base_dir, filename)
        if os.path.exists(filepath):
            print(f"Loading {filename}...")
            base_images[filename] = Image.open(filepath)
        else:
            print(f"Warning: {filepath} not found, skipping.")

    for hue_val, hue_name, rot_deg, sat_mult in HUES:
        hue_dir = os.path.join(colors_dir, str(hue_val))
        os.makedirs(hue_dir, exist_ok=True)
        print(f"\nProcessing Hue {hue_val}° ({hue_name}, rot={rot_deg}°, sat={sat_mult})...")
        t_hue = time.time()

        for filename, base_im in base_images.items():
            dest_path = os.path.join(hue_dir, filename)
            src_path = os.path.join(base_dir, filename)
            if not force_all and os.path.exists(dest_path) and os.path.getmtime(dest_path) > os.path.getmtime(src_path):
                print(f"  [Cached] {filename}")
                continue

            t0 = time.time()
            variant = shift_pink_hue(base_im, rot_deg, sat_mult)
            variant.save(dest_path, optimize=True)
            print(f"  Saved {filename} ({time.time() - t0:.2f}s)")

        print(f"Done Hue {hue_val}° in {time.time() - t_hue:.2f}s")

    print(f"\nAll variants generated successfully in {time.time() - start_total:.2f}s!")

    print(f"\nAll variants generated successfully in {time.time() - start_total:.2f}s!")

if __name__ == '__main__':
    main()
