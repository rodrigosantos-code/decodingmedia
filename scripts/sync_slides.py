#!/usr/bin/env python3
"""
DECODING MEDIA - Auto Sync Google Slides to Local High-Res Images & Supabase
Descarga automáticamente presentaciones de Google Slides en PDF, calcula el hash SHA-256
para detectar cambios, convierte cada diapositiva a imagen JPEG de alta resolución,
actualiza el número exacto de diapositivas (slidesCount) y sincroniza con Supabase.
"""

import os
import sys
import json
import time
import ssl
import hashlib
import re
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
import pymupdf

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLIDES_DIR = os.path.join(BASE_DIR, 'slides')
CACHE_FILE = os.path.join(SLIDES_DIR, 'sync_cache.json')

SUPABASE_URL = 'https://diwbyoubikgxhwpufgjj.supabase.co'
ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpd2J5b3ViaWtneGh3cHVmZ2pqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNzQzOTEsImV4cCI6MjEwNTc1MDM5MX0.b_tcHWCHHxvndXBJmxSjYk0nQN7AK8hjI0uU3cG2rhs'

SSL_CTX = ssl._create_unverified_context()

def get_presentation_id(url):
    if not url:
        return None
    m = re.search(r'/presentation/d/([a-zA-Z0-9_-]+)', str(url))
    return m.group(1) if m else None

def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_cache(cache):
    os.makedirs(SLIDES_DIR, exist_ok=True)
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        print(f"[Sync] Error saving cache: {e}")

def fetch_supabase_deck(deck_id='default'):
    url = f"{SUPABASE_URL}/rest/v1/dm_decks?id=eq.{deck_id}&select=*"
    req = urllib.request.Request(url, headers={
        'apikey': ANON_KEY,
        'Authorization': f'Bearer {ANON_KEY}'
    })
    try:
        with urllib.request.urlopen(req, context=SSL_CTX) as resp:
            data = json.loads(resp.read().decode())
            if data and len(data) > 0:
                return data[0]
    except Exception as e:
        print(f"[Sync] Error fetching deck '{deck_id}' from Supabase: {e}")
    return None

def update_supabase_deck_slots(deck_id, slots):
    url = f"{SUPABASE_URL}/rest/v1/dm_decks?id=eq.{deck_id}"
    body = json.dumps({
        'slots': slots,
        'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'updated_by': 'sync_slides_daemon'
    }).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PATCH', headers={
        'apikey': ANON_KEY,
        'Authorization': f'Bearer {ANON_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    })
    try:
        with urllib.request.urlopen(req, context=SSL_CTX) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"[Sync] Error updating Supabase deck '{deck_id}': {e}")
        return False

def sync_slot_presentation(slot, cache):
    url = slot.get('url', '')
    slot_id = slot.get('id', 'unknown')
    pres_id = get_presentation_id(url)
    if not pres_id:
        return False, "No valid Google Slides URL"

    pdf_url = f"https://docs.google.com/presentation/d/{pres_id}/export/pdf"
    req = urllib.request.Request(pdf_url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })

    print(f"[Sync] Downloading PDF for {slot.get('name', slot_id)} ({pres_id})...")
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=20) as resp:
            pdf_bytes = resp.read()
    except Exception as e:
        return False, f"Download failed: {e}"

    sha = hashlib.sha256(pdf_bytes).hexdigest()
    slot_dir = os.path.join(SLIDES_DIR, slot_id)
    slot_cache = cache.get(slot_id, {})

    # Check if already up-to-date
    if slot_cache.get('sha') == sha and os.path.exists(slot_dir) and len(os.listdir(slot_dir)) > 0:
        existing_count = slot_cache.get('page_count', len(os.listdir(slot_dir)))
        if slot.get('slidesCount') == existing_count and slot.get('slideImages'):
            print(f"[Sync] Slot {slot.get('name', slot_id)} is already up to date ({existing_count} slides).")
            return False, "Unchanged"

    # Process PDF with PyMuPDF
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype='pdf')
    except Exception as e:
        return False, f"Failed to parse PDF: {e}"

    num_pages = doc.page_count
    print(f"[Sync] Detected {num_pages} slides for {slot.get('name', slot_id)} (Hash: {sha[:10]})")

    os.makedirs(slot_dir, exist_ok=True)
    # Remove old images in slot directory
    for f in os.listdir(slot_dir):
        if f.endswith('.jpg') or f.endswith('.png'):
            try:
                os.remove(os.path.join(slot_dir, f))
            except Exception:
                pass

    slide_images = []
    for i in range(num_pages):
        page = doc.load_page(i)
        # 140 DPI gives crisp 16:9 / 3:4 / 9:16 rendering (~1800px width)
        pix = page.get_pixmap(dpi=140)
        img_name = f"slide_{i + 1}.jpg"
        img_path = os.path.join(slot_dir, img_name)
        # Quality 85 balances small size (~150KB) and razor-sharp text
        pix.save(img_path, output='jpg', jpg_quality=85)
        rel_path = f"slides/{slot_id}/{img_name}"
        slide_images.append(rel_path)

    # Save original PDF as reference
    try:
        with open(os.path.join(slot_dir, "presentation.pdf"), 'wb') as f:
            f.write(pdf_bytes)
    except Exception:
        pass

    # Update slot metadata
    slot['slidesCount'] = num_pages
    slot['slideImages'] = slide_images
    slot['pdfHash'] = sha
    slot['lastSync'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    cache[slot_id] = {
        'sha': sha,
        'page_count': num_pages,
        'slide_images': slide_images,
        'updated_at': time.time()
    }
    return True, f"Updated with {num_pages} slides"

def sync_deck(deck_id='default', local_slots=None):
    cache = load_cache()
    if local_slots:
        slots = local_slots
        from_supabase = False
    else:
        deck_data = fetch_supabase_deck(deck_id)
        if not deck_data or 'slots' not in deck_data:
            print(f"[Sync] Deck '{deck_id}' not found in Supabase.")
            return False, []
        slots = deck_data['slots']
        from_supabase = True

    any_updated = False
    results = []

    for slot in slots:
        fmt = slot.get('format', '')
        if fmt == 'title':
            continue
        url = slot.get('url', '')
        if not url or 'docs.google.com/presentation' not in url:
            continue

        updated, msg = sync_slot_presentation(slot, cache)
        results.append({
            'slotId': slot.get('id'),
            'name': slot.get('name'),
            'updated': updated,
            'message': msg,
            'slidesCount': slot.get('slidesCount', 1)
        })
        if updated:
            any_updated = True

    save_cache(cache)

    if any_updated or from_supabase:
        print(f"[Sync] Saving updated slots to Supabase deck '{deck_id}'...")
        ok = update_supabase_deck_slots(deck_id, slots)
        if ok:
            print(f"[Sync] Supabase deck '{deck_id}' successfully updated!")
        else:
            print(f"[Sync] Warning: Could not update Supabase deck '{deck_id}'.")

    return True, slots, results

def process_uploaded_pdf(slot_id, pdf_bytes, file_name='presentation.pdf', deck_id='default'):
    slot_dir = os.path.join(SLIDES_DIR, slot_id)
    os.makedirs(slot_dir, exist_ok=True)

    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype='pdf')
    except Exception as e:
        return False, f"Failed to parse PDF: {e}", None

    num_pages = doc.page_count
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    print(f"[Sync] Processing uploaded PDF for slot '{slot_id}' ({file_name}): {num_pages} pages (Hash: {sha[:10]})")

    # Clear old slide images
    for f in os.listdir(slot_dir):
        if f.endswith('.jpg') or f.endswith('.png'):
            try:
                os.remove(os.path.join(slot_dir, f))
            except Exception:
                pass

    slide_images = []
    for i in range(num_pages):
        page = doc.load_page(i)
        pix = page.get_pixmap(dpi=140)
        img_name = f"slide_{i + 1}.jpg"
        img_path = os.path.join(slot_dir, img_name)
        pix.save(img_path, output='jpg', jpg_quality=85)
        rel_path = f"slides/{slot_id}/{img_name}"
        slide_images.append(rel_path)

    # Save original PDF
    pdf_save_name = file_name if file_name.lower().endswith('.pdf') else f"{file_name}.pdf"
    pdf_save_path = os.path.join(slot_dir, pdf_save_name)
    try:
        with open(pdf_save_path, 'wb') as f:
            f.write(pdf_bytes)
        with open(os.path.join(slot_dir, 'presentation.pdf'), 'wb') as f:
            f.write(pdf_bytes)
    except Exception as e:
        print(f"[Sync] Error saving raw PDF: {e}")

    # Update cache
    cache = load_cache()
    cache[slot_id] = {
        'sha': sha,
        'page_count': num_pages,
        'slide_images': slide_images,
        'pdf_filename': file_name,
        'source_type': 'pdf',
        'updated_at': time.time()
    }
    save_cache(cache)

    # Update slot in Supabase if deck_id provided
    updated_slot = None
    if deck_id:
        deck_data = fetch_supabase_deck(deck_id)
        if deck_data and 'slots' in deck_data:
            slots = deck_data['slots']
            for s in slots:
                if s.get('id') == slot_id:
                    s['slidesCount'] = num_pages
                    s['slideImages'] = slide_images
                    s['pdfFileName'] = file_name
                    s['pdfHash'] = sha
                    s['sourceType'] = 'pdf'
                    s['lastSync'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                    updated_slot = s
                    break
            if updated_slot:
                update_supabase_deck_slots(deck_id, slots)

    result_data = {
        'slotId': slot_id,
        'slidesCount': num_pages,
        'slideImages': slide_images,
        'pdfFileName': file_name,
        'pdfHash': sha,
        'sourceType': 'pdf'
    }
    return True, f"PDF processed: {num_pages} slides", result_data

# ═════════════════════════════════════════════════════════════════════
# HTTP MICROSERVICE FOR PRODUCER / BROWSER AUTO-SYNC (PORT 8765)
# ═════════════════════════════════════════════════════════════════════
class SyncHTTPHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, apikey, Authorization')

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/status'):
            cache = load_cache()
            self.send_response(200)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'online',
                'service': 'DecodingMedia Slide Sync',
                'cacheSlots': len(cache)
            }).encode('utf-8'))
        elif self.path.startswith('/sync'):
            # Trigger sync on GET (e.g. from reload)
            deck_id = 'default'
            if '?deck=' in self.path:
                deck_id = self.path.split('?deck=')[1].split('&')[0]
            ok, slots, results = sync_deck(deck_id)
            self.send_response(200)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': ok,
                'deckId': deck_id,
                'slots': slots,
                'results': results
            }).encode('utf-8'))
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def do_POST(self):
        if self.path.startswith('/sync'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                data = json.loads(body)
            except Exception:
                data = {}

            deck_id = data.get('deckId', 'default')
            incoming_slots = data.get('slots', None)

            ok, slots, results = sync_deck(deck_id, incoming_slots)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': ok,
                'deckId': deck_id,
                'slots': slots,
                'results': results
            }).encode('utf-8'))
        elif self.path.startswith('/upload-pdf'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
            try:
                data = json.loads(body)
            except Exception as e:
                self.send_response(400)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': f'Invalid JSON: {e}'}).encode('utf-8'))
                return

            slot_id = data.get('slotId')
            deck_id = data.get('deckId', 'default')
            file_name = data.get('fileName', 'presentation.pdf')
            b64_data = data.get('fileData', '')

            if not slot_id or not b64_data:
                self.send_response(400)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': 'Missing slotId or fileData'}).encode('utf-8'))
                return

            import base64
            if ',' in b64_data:
                b64_data = b64_data.split(',', 1)[1]

            try:
                pdf_bytes = base64.b64decode(b64_data)
            except Exception as e:
                self.send_response(400)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': f'Base64 decode failed: {e}'}).encode('utf-8'))
                return

            ok, msg, res = process_uploaded_pdf(slot_id, pdf_bytes, file_name, deck_id)
            self.send_response(200 if ok else 500)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': ok,
                'message': msg,
                'data': res
            }).encode('utf-8'))
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def log_message(self, format, *args):
        # Concise logs
        pass

def run_server(port=8765):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, SyncHTTPHandler)
    print(f"[Sync Server] Decoding Media Slides Daemon running on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Sync Server] Stopping server.")
        httpd.server_close()

def main():
    if '--server' in sys.argv:
        # Run initial sync once, then start HTTP daemon
        sync_deck('default')
        run_server()
    elif '--watch' in sys.argv:
        print("[Sync] Watch mode active. Checking for presentation changes every 15s...")
        while True:
            try:
                sync_deck('default')
            except Exception as e:
                print(f"[Sync Error] {e}")
            time.sleep(15)
    else:
        # One-shot sync
        deck_id = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else 'default'
        sync_deck(deck_id)

if __name__ == '__main__':
    main()
