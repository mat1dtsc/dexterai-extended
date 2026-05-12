'use strict';
/**
 * lib/cache.js — Cache en memoria con TTL y límite de tamaño v2.0
 * Mejoras: límite máximo de entradas, limpieza automática de expirados
 */

var store = {};
var MAX_ENTRIES = 1000; // Límite para evitar memory leaks
var CLEANUP_INTERVAL = 60000; // Limpiar expirados cada 60s

function get(key) {
  var entry = store[key];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete store[key];
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  ttlMs = ttlMs || 120000; // default 2 minutos
  
  // Si estamos cerca del límite, limpiar expirados primero
  var keys = Object.keys(store);
  if (keys.length >= MAX_ENTRIES) {
    cleanupExpired();
    // Si aún estamos cerca, eliminar las entradas más viejas
    keys = Object.keys(store);
    if (keys.length >= MAX_ENTRIES) {
      var oldest = keys.reduce(function(a, b) {
        return store[a].expires < store[b].expires ? a : b;
      });
      delete store[oldest];
    }
  }
  
  store[key] = {
    value: value,
    expires: Date.now() + ttlMs
  };
}

function cleanupExpired() {
  var now = Date.now();
  var keys = Object.keys(store);
  var removed = 0;
  for (var i = 0; i < keys.length; i++) {
    if (store[keys[i]].expires < now) {
      delete store[keys[i]];
      removed++;
    }
  }
  return removed;
}

function clear() {
  store = {};
}

function keys() {
  return Object.keys(store);
}

function stats() {
  return {
    entries: Object.keys(store).length,
    maxEntries: MAX_ENTRIES,
    expiredEntries: Object.keys(store).filter(function(k) {
      return store[k].expires < Date.now();
    }).length
  };
}

// Limpieza automática periódica
setInterval(cleanupExpired, CLEANUP_INTERVAL);

module.exports = {
  get: get,
  set: set,
  clear: clear,
  keys: keys,
  stats: stats,
  cleanupExpired: cleanupExpired
};
