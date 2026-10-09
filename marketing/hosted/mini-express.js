'use strict';
// Roteador compatível com o subconjunto de Express usado em src/server.js, executado no navegador.
function compile(path) {
  if (path === '*') return { re: /^.*$/, keys: [] };
  const keys = []; const src = path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}
function express() {
  const stack = [];
  const add = method => (path, ...fns) => { stack.push(Object.assign({ method, fns }, compile(path))); };
  const app = {
    _stack: stack, disable() {}, set() {},
    use(path, ...fns) { if (typeof path === 'function') { fns = [path]; path = ''; } stack.push({ use: true, prefix: path, fns }); },
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    prepend(method, path, fn) { stack.unshift(Object.assign({ method, fns: [fn] }, compile(path))); },
    handle(req) {
      return new Promise(resolve => {
        const res = {
          statusCode: 200, headers: {}, done: false,
          status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
          json(d) { this.finish(d); }, send(d) { this.finish(d); }, end(d) { this.finish(d === undefined ? null : d); },
          redirect(c, u) { this.statusCode = c; this.finish({ redirect: u }); }, sendFile() { this.status(404).finish({ error: 'Rota não encontrada.' }); },
          finish(body) { if (this.done) return; this.done = true; resolve({ status: this.statusCode, headers: this.headers, body }); },
        };
        req.get = n => req.headers[n.toLowerCase()];
        const items = [];
        for (const l of stack) for (const fn of l.fns) items.push({ l, fn });
        let i = 0;
        const next = err => {
          while (i < items.length) {
            const { l, fn } = items[i++];
            const isErr = fn.length === 4;
            if (err ? !isErr : isErr) continue;
            if (l.use) { if (!req.path.startsWith(l.prefix)) continue; }
            else { if (l.method !== req.method) continue; const m = req.path.match(l.re); if (!m) continue; req.params = {}; l.keys.forEach((k, j) => { req.params[k] = decodeURIComponent(m[j + 1]); }); }
            try { const r = isErr ? fn(err, req, res, next) : fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { return next(e); }
            return;
          }
          if (!res.done) res.status(err ? 500 : 404).json({ error: err ? 'Erro interno.' : 'Rota não encontrada.' });
        };
        next();
      });
    },
  };
  return app;
}
express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();
module.exports = express;
