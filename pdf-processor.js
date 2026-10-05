/**
 * DECODING MEDIA - PDF Processor
 * Renderizado de diapositivas PDF en el navegador (cliente) usando PDF.js
 * Compatible con ejecución en la web (HTTPS, Vercel, Netlify, GitHub Pages) y offline/local.
 */

(function(window) {
  'use strict';

  // Configuración de PDF.js
  function ensurePdfJsLoaded() {
    return new Promise((resolve, reject) => {
      if (window.pdfjsLib) {
        setupWorker();
        resolve(window.pdfjsLib);
        return;
      }

      // Intentar cargar primero la copia local en vendor/
      const localScript = document.createElement('script');
      localScript.src = 'vendor/pdf.min.js';
      localScript.onload = () => {
        setupWorker();
        resolve(window.pdfjsLib);
      };
      localScript.onerror = () => {
        // Fallback a CDN
        console.warn('[PDF Processor] Fallback a CDN para PDF.js');
        const cdnScript = document.createElement('script');
        cdnScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        cdnScript.onload = () => {
          setupWorker();
          resolve(window.pdfjsLib);
        };
        cdnScript.onerror = () => reject(new Error('No se pudo cargar la librería PDF.js'));
        document.head.appendChild(cdnScript);
      };
      document.head.appendChild(localScript);
    });
  }

  function setupWorker() {
    if (!window.pdfjsLib) return;
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      // Probar si el worker local existe o usar CDN
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
  }

  /**
   * Procesa un archivo PDF en el navegador convirtiendo cada página en una imagen HD.
   * @param {File|Blob|ArrayBuffer} fileOrBuffer 
   * @param {Object} options 
   * @returns {Promise<{slidesCount: number, slideImages: string[], slideBlobs: Blob[]}>}
   */
  async function processPdf(fileOrBuffer, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const maxDimension = options.maxDimension || 1600; // Calidad 1080p nítida
    const quality = options.quality !== undefined ? options.quality : 0.82;

    onProgress(0, 1, 'Iniciando motor PDF...');
    const pdfjs = await ensurePdfJsLoaded();

    let arrayBuffer;
    if (fileOrBuffer instanceof ArrayBuffer) {
      arrayBuffer = fileOrBuffer;
    } else if (fileOrBuffer.arrayBuffer) {
      arrayBuffer = await fileOrBuffer.arrayBuffer();
    } else {
      arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(fileOrBuffer);
      });
    }

    const loadingTask = pdfjs.getDocument({
      data: arrayBuffer,
      cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
      cMapPacked: true
    });

    const pdfDoc = await loadingTask.promise;
    const totalPages = pdfDoc.numPages;

    if (totalPages === 0) {
      throw new Error('El PDF no contiene páginas válidas');
    }

    const slideImages = [];
    const slideBlobs = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      onProgress(pageNum, totalPages, `Procesando diapositiva ${pageNum} de ${totalPages}...`);

      const page = await pdfDoc.getPage(pageNum);
      const unscaledViewport = page.getViewport({ scale: 1.0 });

      // Calcular escala para llegar al ancho deseado manteniendo aspecto
      const scale = Math.min(2.5, Math.max(1.0, maxDimension / unscaledViewport.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });

      // Fondo blanco por defecto para PDFs transparentes
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvasContext: ctx,
        viewport: viewport
      }).promise;

      // Generar Data URL optimizado (JPEG calidad 0.82)
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      slideImages.push(dataUrl);

      // Generar Blob para posible subida a Supabase Storage
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      slideBlobs.push(blob);
    }

    onProgress(totalPages, totalPages, '¡Diapositivas listas!');

    return {
      slidesCount: totalPages,
      slideImages: slideImages,
      slideBlobs: slideBlobs
    };
  }

  /**
   * Intenta subir las diapositivas a Supabase Storage (dm_assets)
   * Si tiene éxito devuelve los URLs públicos; si falla o no está configurado devuelve null.
   */
  async function tryUploadToSupabaseStorage(deckId, slotId, slideBlobs, onProgress = () => {}) {
    try {
      if (!window.DMCloud) return null;
      const sc = typeof window.DMCloud._getClient === 'function' 
        ? window.DMCloud._getClient() 
        : (window.DMCloud.supabase || (window.supabase && typeof window.supabase.createClient === 'function' ? window.supabase : null));
      
      if (!sc || !sc.storage) return null;

      const publicUrls = [];
      const total = slideBlobs.length;

      for (let i = 0; i < total; i++) {
        onProgress(i + 1, total, `Sincronizando diapositiva ${i + 1} en la nube...`);
        const path = `decks/${deckId}/slides/${slotId}/slide_${i + 1}.jpg`;
        const { error: upErr } = await sc.storage.from('dm_assets').upload(path, slideBlobs[i], {
          upsert: true,
          contentType: 'image/jpeg'
        });

        if (upErr) {
          console.warn('[PDF Processor] Supabase Storage upload error (usando imágenes locales):', upErr.message);
          return null; // Fallback a Data URLs
        }

        const { data: ud } = sc.storage.from('dm_assets').getPublicUrl(path);
        if (ud && ud.publicUrl) {
          publicUrls.push(`${ud.publicUrl}?t=${Date.now()}`);
        } else {
          return null;
        }
      }

      return publicUrls;
    } catch (err) {
      console.warn('[PDF Processor] Storage fallback warning:', err);
      return null;
    }
  }

  /**
   * Intentar con el microservicio local de python (puerto 8765) si está disponible (sólo en localhost).
   */
  async function tryLocalDaemonUpload(slotId, deckId, file) {
    // Si estamos en un origen HTTPS en la web, el navegador bloquea http://127.0.0.1 por Mixed Content
    if (window.location.protocol === 'https:') {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      // Convertir a base64
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });

      const resp = await fetch('http://127.0.0.1:8765/upload-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: slotId,
          deckId: deckId,
          fileName: file.name,
          fileData: b64
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.data) {
          return json.data;
        }
      }
      return null;
    } catch (e) {
      // Demonio local no disponible, pasar a procesamiento en cliente
      return null;
    }
  }

  window.DMPdfProcessor = {
    ensureLoaded: ensurePdfJsLoaded,
    processPdf: processPdf,
    tryUploadToSupabaseStorage: tryUploadToSupabaseStorage,
    tryLocalDaemonUpload: tryLocalDaemonUpload
  };

  // Pre-cargar worker si ya está en DOM
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        ensurePdfJsLoaded().catch(() => {});
      });
    } else {
      ensurePdfJsLoaded().catch(() => {});
    }
  }

})(typeof window !== 'undefined' ? window : this);
