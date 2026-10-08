'use strict';
// Implementação mínima da API DatabaseSync (node:sqlite) sobre sql.js, para rodar no navegador.
let SQL = null;
function setSQL(s) { SQL = s; }
const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v));
class DatabaseSync {
  constructor() { this.db = new SQL.Database(); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const all = (...a) => { const st = db.prepare(sql); try { st.bind(norm(a)); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } };
    return {
      all, get: (...a) => all(...a)[0],
      run: (...a) => { db.run(sql, norm(a)); const r = db.exec('SELECT changes(), last_insert_rowid()')[0].values[0]; return { changes: r[0], lastInsertRowid: r[1] }; },
    };
  }
  close() { this.db.close(); }
}
module.exports = { DatabaseSync, setSQL };
