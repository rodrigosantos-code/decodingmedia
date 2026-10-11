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

  function initClient() {
    const { url, anonKey } = getStoredCredentials();
    if (!url || !anonKey) {
      client = null;
      notifyStatus('not_configured', 'Credenciales no configuradas');
      return null;
    }

    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.warn('[DMCloud] SDK de Supabase no cargado todavía.');
      notifyStatus('error', 'Librería de Supabase no disponible');
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
      console.error('[DMCloud] Error al instanciar Supabase:', err);
      notifyStatus('error', 'Error en formato de credenciales');
      return null;
    }
  }

  async function testConnection() {
    if (!client) return false;
    try {
      const { data, error } = await client
        .from('dm_decks')
        .select('id, updated_at')
        .limit(1);

      if (error) {
        console.warn('[DMCloud] Test de conexión fallido:', error.message);
        notifyStatus('error', error.message);
        return false;
      }

      notifyStatus('connected', 'Conectado a la nube');
      return true;
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
            const currentDeckId = getActiveDeckId();
            if (payload.new.id === currentDeckId || !payload.new.id) {
              console.log('[DMCloud] Configuración actualizada desde otro ordenador:', payload.new.id, payload.new.updated_at);
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
        if (!client) return localList;
      }

      try {
        const { data, error } = await client
          .from('dm_decks')
          .select('id, updated_at, calib_version')
          .neq('calib_version', '__deleted__')
          .order('updated_at', { ascending: false });

        if (error || !data) {
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
      if (!client) {
        initClient();
        if (!client) return null;
      }

      try {
        notifyStatus('syncing', 'Descargando datos...');
        const { data, error } = await client
          .from('dm_decks')
          .select('id, slots, calib_version, updated_at')
          .eq('id', targetId)
          .maybeSingle();

        if (error) {
          console.warn('[DMCloud] Error al obtener dm_decks:', error);
          notifyStatus('error', error.message);
          return null;
        }

        if (!data || data.calib_version === '__deleted__' || data.calib_version === 'deleted') {
          notifyStatus('connected', 'Sincronizado');
          return null;
        }

        if (data && Array.isArray(data.slots)) {
          DMStorage.saveDeckSlots(targetId, data.slots);
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
      
      // Asegurar persistencia local inmediata en IndexedDB
      if (Array.isArray(slots)) {
        DMStorage.saveDeckSlots(targetId, slots);
      }

      if (!client) {
        initClient();
        if (!client) return { success: false, error: 'Cliente de Supabase no disponible' };
      }

      try {
        notifyStatus('syncing', 'Subiendo a la nube...');
        let cloudSlots = slots;

        // Comprobar tamaño y optimizar para PostgREST
        try {
          const rawStr = JSON.stringify(slots);
          if (rawStr.length > 2.5 * 1024 * 1024) {
            console.warn(`[DMCloud] Payload de slots pesado (${(rawStr.length / 1024 / 1024).toFixed(1)}MB). Optimizando imágenes base64 para la nube...`);
            cloudSlots = slots.map(s => {
              if (s.slideImages && Array.isArray(s.slideImages)) {
                return {
                  ...s,
                  slideImages: s.slideImages.filter(img => typeof img === 'string' && !img.startsWith('data:'))
                };
              }
              return s;
            });
          }
        } catch(optErr) {}

        const payload = {
          id: targetId,
          slots: cloudSlots,
          calib_version: calibVersion || '20260923_def_v2',
          updated_at: new Date().toISOString(),
          updated_by: sender
        };

        const { error } = await client
          .from('dm_decks')
          .upsert(payload, { onConflict: 'id' });

        if (error) {
          console.warn('[DMCloud] Error al guardar en Supabase:', error);
          notifyStatus('error', error.message);
          return { success: false, error: error.message };
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
