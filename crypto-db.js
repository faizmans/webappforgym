/**
 * GymSpace Pro — Fast Non-Blocking AES-GCM 256-bit Local Storage Engine
 */

const CryptoVault = (() => {
  const SPACES_INDEX_KEY = 'GYMSPACE_PRO_ISOLATED_SPACES_V3';
  const LOCKOUT_KEY = 'GYMSPACE_PRO_AUTH_LOCKOUT';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function generateSalt() {
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return toBase64(arr.buffer);
  }

  async function sha256Hex(text) {
    const digest = await window.crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function checkRateLimit() {
    try {
      const info = JSON.parse(sessionStorage.getItem(LOCKOUT_KEY) || '{"fails":0,"until":0}');
      const now = Date.now();
      if (info.until > now) {
        const secs = Math.ceil((info.until - now) / 1000);
        throw new Error(`LOCKED:${secs}`);
      }
      return info;
    } catch (e) {
      if (e.message.startsWith('LOCKED:')) throw e;
      return { fails: 0, until: 0 };
    }
  }

  function recordAuthResult(success) {
    if (success) {
      sessionStorage.removeItem(LOCKOUT_KEY);
      return;
    }
    const info = checkRateLimit();
    info.fails += 1;
    if (info.fails >= 5) {
      info.until = Date.now() + 30000;
      info.fails = 0;
    }
    sessionStorage.setItem(LOCKOUT_KEY, JSON.stringify(info));
  }

  async function deriveKey(pin, saltB64, iterations = 120000) {
    const baseKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(pin),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: fromBase64(saltB64),
        iterations,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptData(plainObj, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const jsonStr = JSON.stringify(plainObj);
    const checksum = await sha256Hex(jsonStr);
    const cipher = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jsonStr));
    return {
      iv: toBase64(iv.buffer),
      data: toBase64(cipher),
      checksum,
      kdfIterations: 120000,
      updatedAt: new Date().toISOString()
    };
  }

  async function decryptData(payload, key) {
    const iv = new Uint8Array(fromBase64(payload.iv));
    const cipher = fromBase64(payload.data);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    const jsonStr = dec.decode(decrypted);

    if (payload.checksum) {
      const computed = await sha256Hex(jsonStr);
      if (computed !== payload.checksum) {
        throw new Error('Vault integrity check failed');
      }
    }
    return JSON.parse(jsonStr);
  }

  function getSpacesList() {
    try {
      const v3 = JSON.parse(localStorage.getItem(SPACES_INDEX_KEY) || '[]');
      const v2 = JSON.parse(localStorage.getItem('GYMSPACE_PRO_ISOLATED_SPACES_V2') || '[]');
      const merged = [...v3];
      v2.forEach(item => {
        if (!merged.some(m => m.gymId === item.gymId)) merged.push(item);
      });
      return merged;
    } catch {
      return [];
    }
  }

  function saveSpacesList(list) {
    localStorage.setItem(SPACES_INDEX_KEY, JSON.stringify(list));
  }

  function openGymDB(gymId) {
    return new Promise((resolve, reject) => {
      const dbName = `GymSpace_Isolated_${gymId}`;
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('vault')) {
          db.createObjectStore('vault', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveEncryptedVault(gymId, encryptedPayload) {
    try {
      const db = await openGymDB(gymId);
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readwrite');
        tx.objectStore('vault').put({ id: 'ROOT', ...encryptedPayload });
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch {
      localStorage.setItem(`GymSpace_Fallback_${gymId}`, JSON.stringify(encryptedPayload));
      return true;
    }
  }

  async function loadEncryptedVault(gymId) {
    try {
      const db = await openGymDB(gymId);
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('vault', 'readonly');
        const req = tx.objectStore('vault').get('ROOT');
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch {
      const raw = localStorage.getItem(`GymSpace_Fallback_${gymId}`);
      return raw ? JSON.parse(raw) : null;
    }
  }

  return {
    generateSalt,
    deriveKey,
    encryptData,
    decryptData,
    checkRateLimit,
    recordAuthResult,
    getSpacesList,
    saveSpacesList,
    saveEncryptedVault,
    loadEncryptedVault
  };
})();