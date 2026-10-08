'use strict';
// Substitui src/db.js na versão hospedada: bancos SQLite em memória (sql.js).
const { AUTH_SCHEMA, DATA_SCHEMA, seedLists } = require('../src/schema');
const { DatabaseSync } = require('./sqlshim');
let auth = null; const dbs = {};
function init() { auth = new DatabaseSync(); auth.exec(AUTH_SCHEMA); module.exports.auth = auth; }
function fresh() { const db = new DatabaseSync(); db.exec(DATA_SCHEMA); return db; }
function setReal(db) { dbs.real = db; }
function dataDb(mode) {
  const m = mode === 'demo' ? 'demo' : 'real';
  if (!dbs[m]) {
    const db = fresh(); seedLists(db); dbs[m] = db;
    if (m === 'demo') require('../src/demo').seed(db);
  }
  return dbs[m];
}
function resetDemo() { if (dbs.demo) { dbs.demo.close(); delete dbs.demo; } return dataDb('demo'); }
function tx(db, fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
module.exports = { auth, init, fresh, setReal, dataDb, resetDemo, tx, DATA_DIR: '' };
