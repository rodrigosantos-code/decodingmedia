/**
 * DECODING MEDIA - Módulo Cliente de Supabase
 * Maneja la sincronización en la nube, múltiples escenas/presentaciones y control remoto multi-dispositivo.
 */
(function(window) {
  'use strict';

  const STORAGE_KEY_URL = 'dm_supabase_url';
  const STORAGE_KEY_KEY = 'dm_supabase_anon_key';
  const STORAGE_KEY_ACTIVE_DECK = 'dm_active_deck_id';
  const STORAGE_KEY_DECKS_INDEX = 'dm_local_decks_index';
  const DEFAULT_DECK_ID = 'default';

  // =========================================================================
  // GESTOR DE ALMACENAMIENTO HÍBRIDO (IndexedDB + LocalStorage seguro)
  // Permite almacenar proyectos y PDFs con múltiples diapositivas sin límite de 5MB
  // =========================================================================
  const DMStorage = {
    DB_NAME: 'dm_deck_storage',
    DB_VERSION: 1,
    STORE_DECKS: 'decks',
    _dbPromise: null,

    _getDB: function() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
          console.warn('[DMStorage] IndexedDB no soportado en este navegador');
          resolve(null);
          return;
        }
        const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.STORE_DECKS)) {
            db.createObjectStore(this.STORE_DECKS, { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => {
          console.warn('[DMStorage] Error abriendo IndexedDB:', e.target.error);
          resolve(null);
        };
      });
      return this._dbPromise;
    },

    saveDeckSlots: async function(deckId, slots) {
      if (!deckId) deckId = DEFAULT_DECK_ID;
      const db = await this._getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(this.STORE_DECKS, 'readwrite');
          const store = tx.objectStore(this.STORE_DECKS);
          store.put({
            id: deckId,
            slots: slots,
            updated_at: new Date().toISOString()
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = (err) => {
            console.warn('[DMStorage] Error guardando deck en IndexedDB:', err);
            resolve(false);
          };
        } catch (e) {
          console.warn('[DMStorage] Excepción guardando en IndexedDB:', e);
          resolve(false);
        }
      });
    },

    getDeckSlots: async function(deckId) {
      if (!deckId) deckId = DEFAULT_DECK_ID;
      const db = await this._getDB();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(this.STORE_DECKS, 'readonly');
          const store = tx.objectStore(this.STORE_DECKS);
          const req = store.get(deckId);
          req.onsuccess = () => {
            if (req.result && Array.isArray(req.result.slots)) {
              resolve(req.result.slots);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch (e) {
          console.warn('[DMStorage] Excepción leyendo de IndexedDB:', e);
          resolve(null);
        }
      });
    },

    // Guardado seguro en localStorage que previene excepciones de cuota (QuotaExceededError)
    safeSetItem: function(key, data) {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      try {
        localStorage.setItem(key, str);
        return true;
      } catch (e) {
        console.warn(`[DMStorage] QuotaExceeded en '${key}'. Almacenando versión ligera sin cadenas base64...`);
        try {
          let parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (Array.isArray(parsed)) {
            const stripped = parsed.map(s => {
              if (s.slideImages && Array.isArray(s.slideImages)) {
                return {
                  ...s,
                  slideImages: s.slideImages.filter(img => typeof img === 'string' && !img.startsWith('data:'))
                };
              }
              return s;
            });
            localStorage.setItem(key, JSON.stringify(stripped));
            return true;
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.slots)) {
              const strippedSlots = parsed.slots.map(s => {
                if (s.slideImages && Array.isArray(s.slideImages)) {
                  return {
                    ...s,
                    slideImages: s.slideImages.filter(img => typeof img === 'string' && !img.startsWith('data:'))
                  };
                }
                return s;
              });
              localStorage.setItem(key, JSON.stringify({ ...parsed, slots: strippedSlots }));
              return true;
            }
          }
        } catch (e2) {}
        return false;
      }
    }
  };

  window.DMStorage = DMStorage;

  let client = null;
  let statusListeners = [];
  let currentStatus = 'not_configured'; // 'not_configured' | 'connecting' | 'connected' | 'error' | 'syncing'
  let currentStatusMessage = 'Sin configurar';
  
  let dbChannel = null;
  let liveBroadcastChannel = null;
  let onDeckChangeCallback = null;
  let onLiveCommandCallback = null;
  const SESSION_CLIENT_ID = 'tab_' + Math.random().toString(36).substring(2, 10);

  function notifyStatus(status, message = '') {
    currentStatus = status;
    currentStatusMessage = message;
    statusListeners.forEach(fn => {
      try { fn(status, message); } catch (e) { console.error('Status listener error:', e); }
    });
  }

  function getStoredCredentials() {
    const defaultCfg = window.DM_SUPABASE_DEFAULT_CONFIG || {};
    const url = (localStorage.getItem(STORAGE_KEY_URL) || defaultCfg.url || '').trim();
    const anonKey = (localStorage.getItem(STORAGE_KEY_KEY) || defaultCfg.anonKey || '').trim();
    return { url, anonKey };
  }

  function getActiveDeckId() {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_DECK) || DEFAULT_DECK_ID;
  }

  function setActiveDeckId(id) {
    const newId = (id || DEFAULT_DECK_ID).trim();
    localStorage.setItem(STORAGE_KEY_ACTIVE_DECK, newId);
    setupRealtimeSubscriptions();
    return newId;
  }

  function getLocalDecksIndex() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DECKS_INDEX);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return [{ id: DEFAULT_DECK_ID, name: 'Presentación Principal', updated_at: new Date().toISOString() }];
  }

  function saveLocalDecksIndex(list) {
    try {
      localStorage.setItem(STORAGE_KEY_DECKS_INDEX, JSON.stringify(list));
    } catch (e) {}
  }

  // Helper: Sanear slots para almacenamiento en PostgreSQL dm_decks.
  // IMPORTANTE: Excluye cadenas base64 gigantes (data:) de slideImages para evitar
  // el error 57014 (canceling statement due to statement timeout) en PostgreSQL.
  // Las imágenes locales completas siguen guardadas en IndexedDB, y las URLs http/https se preservan.
  function sanitizeSlotsForCloud(rawSlots) {
    if (!Array.isArray(rawSlots)) return [];
    return rawSlots.map(slot => {
      if (!slot || typeof slot !== 'object') return slot;
      const copy = { ...slot };
      if (Array.isArray(copy.slideImages)) {
        copy.slideImages = copy.slideImages.filter(img => typeof img === 'string' && !img.startsWith('data:'));
      }
      return copy;
    });
  }

  // Helper: Petición SELECT directa mediante REST API nativo (sin depender de supabase-js SDK)
  async function directRestSelect(table, queryParams = '') {
    const { url, anonKey } = getStoredCredentials();
    if (!url || !anonKey) throw new Error('Credenciales no configuradas');
    const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    return await res.json();
  }

  // Helper: Petición UPSERT directa mediante REST API nativo (sin depender de supabase-js SDK)
  async function directRestUpsert(table, payload) {
    const { url, anonKey } = getStoredCredentials();
    if (!url || !anonKey) throw new Error('Credenciales no configuradas');
    const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${table}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.message) errMsg = errJson.message;
      } catch (e) {
        if (errText) errMsg = errText;
      }
      throw new Error(errMsg);
    }
    return true;
  }

  function initClient() {
    const { url, anonKey } = getStoredCredentials();
    if (!url || !anonKey) {
      client = null;
      notifyStatus('not_configured', 'Credenciales no configuradas');
      return null;
    }

    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.warn('[DMCloud] SDK supabase-js no presente. Usando motor REST nativo directo.');
      testConnection();
      return null;
    }

    try {
      notifyStatus('connecting', 'Conectando con Supabase...');
      client = window.supabase.createClient(url, anonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        },
        realtime: {
          params: {
            eventsPerSecond: 15
          }
        }
      });
      setupRealtimeSubscriptions();
      testConnection();
      return client;
    } catch (err) {
      console.warn('[DMCloud] Error instanciando cliente JS, usando fallback REST:', err);
      testConnection();
      return null;
    }
  }

  async function testConnection() {
    const { url, anonKey } = getStoredCredentials();
    if (!url || !anonKey) {
      notifyStatus('not_configured', 'Credenciales no configuradas');
      return false;
    }

    try {
      if (client && client.from) {
        const { data, error } = await client
          .from('dm_decks')
          .select('id, updated_at')
          .limit(1);

        if (!error) {
          notifyStatus('connected', 'Conectado a la nube');
          return true;
        }
      }

      // Fallback REST directo
      const rows = await directRestSelect('dm_decks', 'select=id,updated_at&limit=1');
      if (Array.isArray(rows)) {
        notifyStatus('connected', 'Conectado a la nube');
        return true;
      }
      notifyStatus('error', 'Respuesta inesperada');
      return false;
    } catch (e) {
      console.warn('[DMCloud] Excepción en testConnection:', e);
      notifyStatus('error', e.message || 'Sin conexión');
      return false;
    }
  }

  function setupRealtimeSubscriptions() {
    if (!client) return;

    // 1. Canal de Base de Datos para cambios en cualquier deck de dm_decks
    if (dbChannel) {
      try { client.removeChannel(dbChannel); } catch (e) {}
    }

    dbChannel = client
      .channel('dm-deck-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dm_decks' },
        (payload) => {
          if (payload.new && payload.new.slots && typeof onDeckChangeCallback === 'function') {
            if (payload.new.calib_version === '__deleted__' || payload.new.calib_version === 'deleted') return;
            // Ignorar cambios emitidos por esta misma pestaña/sesión
            if (payload.new.updated_by && payload.new.updated_by.includes(SESSION_CLIENT_ID)) return;
            const currentDeckId = getActiveDeckId();
            if (payload.new.id === currentDeckId || !payload.new.id) {
              console.log('[DMCloud] Configuración recibida desde otro dispositivo:', payload.new.id, payload.new.updated_at);
              onDeckChangeCallback(payload.new);
            }
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[DMCloud] Suscrito a cambios de base de datos en tiempo real');
        }
      });

    // 2. Canal Broadcast para control remoto instantáneo en vivo (pasar diapositiva, cambiar deck)
    if (liveBroadcastChannel) {
      try { client.removeChannel(liveBroadcastChannel); } catch (e) {}
    }

    liveBroadcastChannel = client
      .channel('dm-live-remote', {
        config: { broadcast: { ack: false, self: false } }
      })
      .on('broadcast', { event: 'stage_command' }, (payload) => {
        if (payload && payload.payload && typeof onLiveCommandCallback === 'function') {
          onLiveCommandCallback(payload.payload);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[DMCloud] Canal de control remoto en vivo activo');
        }
      });
  }

  // --- API PÚBLICA ---
  const DMCloud = {
    init: initClient,

    isConfigured: () => {
      const { url, anonKey } = getStoredCredentials();
      return Boolean(url && anonKey);
    },

    getCredentials: getStoredCredentials,

    saveCredentials: function(url, anonKey) {
      if (url) localStorage.setItem(STORAGE_KEY_URL, url.trim());
      else localStorage.removeItem(STORAGE_KEY_URL);

      if (anonKey) localStorage.setItem(STORAGE_KEY_KEY, anonKey.trim());
      else localStorage.removeItem(STORAGE_KEY_KEY);

      return initClient();
    },

    clearCredentials: function() {
      localStorage.removeItem(STORAGE_KEY_URL);
      localStorage.removeItem(STORAGE_KEY_KEY);
      if (client && dbChannel) try { client.removeChannel(dbChannel); } catch(e) {}
      if (client && liveBroadcastChannel) try { client.removeChannel(liveBroadcastChannel); } catch(e) {}
      client = null;
      notifyStatus('not_configured', 'Desconectado');
    },

    getStatus: () => ({ status: currentStatus, message: currentStatusMessage }),

    onStatusChange: function(fn) {
      if (typeof fn === 'function') {
        statusListeners.push(fn);
        fn(currentStatus, currentStatusMessage);
      }
    },

    testConnection: testConnection,

    // Gestión del Deck activo
    getActiveDeckId: getActiveDeckId,
    setActiveDeckId: setActiveDeckId,

    // Listar todos los decks disponibles (nube + local fallback)
    listDecks: async function() {
      let localList = getLocalDecksIndex().filter(l => l.id && l.id !== '__deleted__' && l.id !== 'deleted');
      if (!client) {
        initClient();
      }

      try {
        let data = null;
        if (client && client.from) {
          const res = await client
            .from('dm_decks')
            .select('id, updated_at, calib_version')
            .neq('calib_version', '__deleted__')
            .order('updated_at', { ascending: false });
          if (!res.error && res.data) {
            data = res.data;
          }
        }

        if (!data) {
          try {
            const rows = await directRestSelect('dm_decks', 'select=id,updated_at,calib_version&calib_version=neq.__deleted__&order=updated_at.desc');
            if (Array.isArray(rows)) {
              data = rows;
            }
          } catch (restErr) {
            console.warn('[DMCloud] REST listDecks error:', restErr);
          }
        }

        if (!data) {
          return localList;
        }

        const validData = data.filter(item => item.calib_version !== '__deleted__' && item.calib_version !== 'deleted' && item.id !== '__deleted__');

        // Combinar datos de la nube con nombres locales si existen
        const combined = validData.map(item => {
          const localItem = localList.find(l => l.id === item.id);
          const name = (localItem && localItem.name) ? localItem.name : (item.id === DEFAULT_DECK_ID ? 'Presentación Principal' : `Presentación (${item.id})`);
          return {
            id: item.id,
            name: name,
            updated_at: item.updated_at
          };
        });

        if (combined.length === 0) {
          combined.push({ id: DEFAULT_DECK_ID, name: 'Presentación Principal', updated_at: new Date().toISOString() });
        }

        saveLocalDecksIndex(combined);
        return combined;
      } catch (e) {
        return localList;
      }
    },

    // Cargar escenas/slots de un deck específico desde Supabase
    fetchDeckConfig: async function(deckId) {
      const targetId = deckId || getActiveDeckId();
      const { url, anonKey } = getStoredCredentials();
      if (!url || !anonKey) return null;

      if (!client) {
        initClient();
      }

      try {
        notifyStatus('syncing', 'Descargando datos...');
        let data = null;

        if (client && client.from) {
          try {
            const res = await client
              .from('dm_decks')
              .select('id, slots, calib_version, updated_at')
              .eq('id', targetId)
              .maybeSingle();
            if (!res.error && res.data) {
              data = res.data;
            }
          } catch (sdkErr) {
            console.warn('[DMCloud] SDK fetchDeckConfig falló, usando REST:', sdkErr);
          }
        }

        if (!data) {
          try {
            const rows = await directRestSelect('dm_decks', `id=eq.${encodeURIComponent(targetId)}&select=id,slots,calib_version,updated_at`);
            if (Array.isArray(rows) && rows.length > 0) {
              data = rows[0];
            }
          } catch (restErr) {
            console.warn('[DMCloud] REST fetchDeckConfig falló:', restErr);
          }
        }

        if (!data || data.calib_version === '__deleted__' || data.calib_version === 'deleted') {
          notifyStatus('connected', 'Sincronizado');
          return null;
        }

        if (data && Array.isArray(data.slots)) {
          const localTime = parseInt(localStorage.getItem('dm_deck_slots_time_' + targetId) || '0', 10);
          const cloudTime = data.updated_at ? new Date(data.updated_at).getTime() : 0;
          if (!localTime || cloudTime >= localTime) {
            DMStorage.saveDeckSlots(targetId, data.slots);
          } else {
            console.log('[DMCloud] Local IndexedDB es más reciente que los datos de la nube. Preservando local.');
          }
        }

        notifyStatus('connected', 'Sincronizado');
        return data;
      } catch (err) {
        console.error('[DMCloud] Excepción en fetchDeckConfig:', err);
        notifyStatus('error', 'Error al sincronizar');
        return null;
      }
    },

    // Guardar escenas/slots en Supabase para un deck dado
    saveDeckConfig: async function(slots, calibVersion, sender = 'editor', deckId, deckName) {
      const targetId = deckId || getActiveDeckId();
      
      // Asegurar persistencia local inmediata en IndexedDB (con todas las imágenes locales HD intactas)
      if (Array.isArray(slots)) {
        DMStorage.saveDeckSlots(targetId, slots);
        try {
          localStorage.setItem('dm_deck_slots_time_' + targetId, String(Date.now()));
        } catch(e) {}
      }

      const { url, anonKey } = getStoredCredentials();
      if (!url || !anonKey) {
        return { success: false, error: 'Credenciales de Supabase no configuradas' };
      }

      if (!client) {
        initClient();
      }

      try {
        notifyStatus('syncing', 'Subiendo a la nube...');

        // Sanear slots para la nube: excluir cadenas base64 gigantes (data:) de slideImages para evitar
        // el error 57014 (canceling statement due to statement timeout) en PostgreSQL.
        const cloudSlots = sanitizeSlotsForCloud(slots);

        const payload = {
          id: targetId,
          slots: cloudSlots,
          calib_version: calibVersion || '20260923_def_v2',
          updated_at: new Date().toISOString(),
          updated_by: `${sender}:${SESSION_CLIENT_ID}`
        };

        let uploadSuccess = false;
        let lastError = null;

        // 1. Intentar con SDK supabase-js si está disponible
        if (client && client.from) {
          try {
            const { error } = await client
              .from('dm_decks')
              .upsert(payload, { onConflict: 'id' });
            if (error) {
              lastError = error.message;
              console.warn('[DMCloud] supabase-js upsert falló, usando fallback REST:', error);
            } else {
              uploadSuccess = true;
            }
          } catch (sdkErr) {
            lastError = sdkErr.message;
            console.warn('[DMCloud] Excepción en supabase-js upsert, usando fallback REST:', sdkErr);
          }
        }

        // 2. Fallback robusto a REST fetch nativo si falló el SDK o no estaba cargado
        if (!uploadSuccess) {
          try {
            await directRestUpsert('dm_decks', payload);
            uploadSuccess = true;
          } catch (restErr) {
            lastError = restErr.message;
            console.error('[DMCloud] Fallback REST falló también:', restErr);
          }
        }

        if (!uploadSuccess) {
          notifyStatus('error', lastError || 'Error al subir a la nube');
          return { success: false, error: lastError || 'Error al subir a la nube' };
        }

        // Actualizar índice local de presentaciones
        const list = getLocalDecksIndex();
        const existing = list.find(l => l.id === targetId);
        if (existing) {
          if (deckName) existing.name = deckName;
          existing.updated_at = payload.updated_at;
        } else {
          list.push({ id: targetId, name: deckName || `Presentación (${targetId})`, updated_at: payload.updated_at });
        }
        saveLocalDecksIndex(list);

        notifyStatus('connected', 'Guardado en la nube');
        return { success: true };
      } catch (err) {
        console.error('[DMCloud] Excepción en saveDeckConfig:', err);
        notifyStatus('error', err.message || 'Error de red');
        return { success: false, error: err.message || 'Error de red' };
      }
    },

    // Crear un nuevo deck completo
    createDeck: async function(id, name, initialSlots = []) {
      const cleanId = (id || 'deck-' + Date.now()).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const cleanName = (name || `Nueva Escena (${cleanId})`).trim();
      
      const list = getLocalDecksIndex();
      if (!list.some(l => l.id === cleanId)) {
        list.push({ id: cleanId, name: cleanName, updated_at: new Date().toISOString() });
        saveLocalDecksIndex(list);
      }

      setActiveDeckId(cleanId);
      await this.saveDeckConfig(initialSlots, '20260923_def_v2', 'editor_create', cleanId, cleanName);
      return cleanId;
    },

    // Eliminar un deck
    deleteDeck: async function(id) {
      if (!id || id === DEFAULT_DECK_ID) return false;

      if (!client) {
        initClient();
      }

      // 1. Borrar de Supabase
      if (client) {
        try {
          // Primero marcamos como __deleted__ por si la política RLS no permite DELETE anónimo en la BD
          await client.from('dm_decks').update({
            calib_version: '__deleted__',
            slots: [],
            updated_at: new Date().toISOString(),
            updated_by: 'deleted'
          }).eq('id', id);

          // E intentamos borrado físico
          const { error } = await client.from('dm_decks').delete().eq('id', id);
          if (error) {
            console.warn('[deleteDeck] Supabase delete warning:', error);
          }
        } catch(e) {
          console.error('[deleteDeck] Exception:', e);
        }
      }

      // 2. Borrar del índice local y almacenamiento
      let list = getLocalDecksIndex();
      list = list.filter(l => l.id !== id && l.id !== '__deleted__');
      saveLocalDecksIndex(list);

      try {
        localStorage.removeItem('dm_deck_slots_' + id);
        localStorage.removeItem('dm_deck_preset_' + id);
        const alt = JSON.parse(localStorage.getItem('dm_decks_index') || '[]');
        if (Array.isArray(alt)) {
          localStorage.setItem('dm_decks_index', JSON.stringify(alt.filter(l => l.id !== id)));
        }
      } catch(e) {}

      // Si el borrado era el activo, volver a default
      if (getActiveDeckId() === id) {
        setActiveDeckId(DEFAULT_DECK_ID);
      }

      return true;
    },

    // Suscribirse a cambios en los slots
    subscribeToDeckChanges: function(callback) {
      onDeckChangeCallback = callback;
    },

    // Emitir comando de control en vivo entre ordenadores
    broadcastLiveCommand: async function(commandData) {
      if (!liveBroadcastChannel) return;
      try {
        await liveBroadcastChannel.send({
          type: 'broadcast',
          event: 'stage_command',
          payload: {
            ...commandData,
            deckId: getActiveDeckId(),
            timestamp: Date.now()
          }
        });
      } catch (e) {
        console.warn('[DMCloud] Error al emitir comando en vivo:', e);
      }
    },

    // Suscribirse a comandos de control en vivo
    subscribeToLiveCommands: function(callback) {
      onLiveCommandCallback = callback;
    },

    // Acceso directo al cliente Supabase (para admin panel y Storage)
    get supabase() {
      return client;
    },
    _getClient: function() {
      return client;
    }
  };

  window.DMCloud = DMCloud;

  // Auto-inicializar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(initClient, 100);
    });
  } else {
    setTimeout(initClient, 100);
  }

})(window);
