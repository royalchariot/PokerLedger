const KEY = "gilded-auth-v2";
const HOUSE_KEY = "gilded-house-auth-v1";
const LEGACY_KEY = "gilded-auth-v1";
const USER_KEY = "gilded-user-auth-v1";

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // ignore storage quota/private mode failures
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

export function saveAuth(auth) {
  safeSet(sessionStorage, KEY, JSON.stringify(auth));
}

export function loadAuth() {
  try {
    const sessionRaw = safeGet(sessionStorage, KEY);
    if (sessionRaw) return JSON.parse(sessionRaw);

    const legacyRaw = safeGet(localStorage, LEGACY_KEY);
    if (!legacyRaw) return null;

    const parsed = JSON.parse(legacyRaw);
    // One-time migration: move auth to tab-scoped storage.
    saveAuth(parsed);
    safeRemove(localStorage, LEGACY_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function clearAuth() {
  safeRemove(sessionStorage, KEY);
  safeRemove(localStorage, LEGACY_KEY);
}

export function saveHouseAuth(auth) {
  safeSet(sessionStorage, HOUSE_KEY, JSON.stringify(auth));
}

export function loadHouseAuth() {
  try {
    const raw = safeGet(sessionStorage, HOUSE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearHouseAuth() {
  safeRemove(sessionStorage, HOUSE_KEY);
}

export function saveUserAuth(auth) {
  safeSet(localStorage, USER_KEY, JSON.stringify(auth));
}

export function loadUserAuth() {
  try {
    const raw = safeGet(localStorage, USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearUserAuth() {
  safeRemove(localStorage, USER_KEY);
}
