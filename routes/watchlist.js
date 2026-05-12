'use strict';
/**
 * routes/watchlist.js — CRUD de watchlists dinámicas
 */
var express = require('express');
var router = express.Router();
var db = require('../lib/db');

router.get('/', function(req, res) {
  db.listarWatchlists().then(function(rows) { res.json({ watchlists: rows }); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

router.get('/active-symbols', function(req, res) {
  db.simbolosDeWatchlistsActivas().then(function(symbols) {
    res.json({ symbols: symbols, count: symbols.length });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

// Activar UNA watchlist (desactiva las demás) — útil para el selector del sidebar
router.post('/:id/activate', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  db.listarWatchlists().then(function(all) {
    var match = all.find(function(w) { return w.id === id; });
    if (!match) { res.status(404).json({ error: 'no encontrada' }); return null; }
    // Desactivar todas
    return Promise.all(all.map(function(w) {
      return db.actualizarWatchlist(w.id, { activa: w.id === id });
    })).then(function() {
      res.json({ activated: id, simbolos: match.simbolos });
    });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

router.get('/:id', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  db.obtenerWatchlist(id).then(function(w) {
    if (!w) return res.status(404).json({ error: 'no encontrada' });
    res.json(w);
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

router.post('/', function(req, res) {
  var nombre = (req.body && req.body.nombre) ? String(req.body.nombre).trim() : '';
  var simbolos = (req.body && Array.isArray(req.body.simbolos)) ? req.body.simbolos : [];
  if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
  simbolos = simbolos.map(function(s) { return String(s).trim().toUpperCase(); }).filter(Boolean);
  db.crearWatchlist(nombre, simbolos).then(function(r) {
    res.status(201).json({ id: r.id, nombre: nombre, simbolos: simbolos });
  }).catch(function(err) {
    var status = /UNIQUE/i.test(err.message) ? 409 : 500;
    res.status(status).json({ error: err.message });
  });
});

router.put('/:id', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  var fields = {};
  if (req.body) {
    if (typeof req.body.nombre === 'string') fields.nombre = req.body.nombre.trim();
    if (Array.isArray(req.body.simbolos)) {
      fields.simbolos = req.body.simbolos.map(function(s) { return String(s).trim().toUpperCase(); }).filter(Boolean);
    }
    if (req.body.activa !== undefined) fields.activa = !!req.body.activa;
  }
  db.actualizarWatchlist(id, fields).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

router.delete('/:id', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  db.eliminarWatchlist(id).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

// Agrega un símbolo a una watchlist existente (idempotente)
router.post('/:id/symbol', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  var symbol = (req.body && req.body.symbol) ? String(req.body.symbol).trim().toUpperCase() : '';
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  db.obtenerWatchlist(id).then(function(w) {
    if (!w) { res.status(404).json({ error: 'no encontrada' }); return null; }
    if (w.simbolos.indexOf(symbol) >= 0) return res.json({ added: false, simbolos: w.simbolos });
    var nuevos = w.simbolos.concat([symbol]);
    return db.actualizarWatchlist(id, { simbolos: nuevos }).then(function() {
      res.json({ added: true, simbolos: nuevos });
    });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

// Quita un símbolo de una watchlist
router.delete('/:id/symbol/:symbol', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  var symbol = String(req.params.symbol || '').trim().toUpperCase();
  db.obtenerWatchlist(id).then(function(w) {
    if (!w) { res.status(404).json({ error: 'no encontrada' }); return null; }
    var nuevos = w.simbolos.filter(function(s) { return s !== symbol; });
    return db.actualizarWatchlist(id, { simbolos: nuevos }).then(function() {
      res.json({ removed: nuevos.length !== w.simbolos.length, simbolos: nuevos });
    });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

module.exports = router;
