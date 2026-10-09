'use strict';
// Gera dist/real4u-hospedado.html: aplicação completa em um único arquivo para publicar como artifact do Claude.
const fs = require('fs'); const path = require('path'); const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
const alias = { name: 'alias', setup(b) {
  b.onResolve({ filter: /^\.\/db$/ }, a => (a.importer.includes(path.sep + 'src' + path.sep) ? { path: path.join(__dirname, 'db-browser.js') } : undefined));
  b.onResolve({ filter: /^express$/ }, () => ({ path: path.join(__dirname, 'mini-express.js') }));
  b.onResolve({ filter: /^crypto$/ }, () => ({ path: path.join(__dirname, 'crypto-shim.js') }));
  b.onResolve({ filter: /^path$/ }, () => ({ path: path.join(__dirname, 'path-shim.js') }));
} };
(async () => {
const out = await esbuild.build({ entryPoints: [path.join(__dirname, 'entry.js')], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020',
  plugins: [alias], define: { 'process.env': '{}', __dirname: '"/"' }, minify: true });
const bundle = out.outputFiles[0].text;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const ui = ['core', 'app', 'contact', 'dashboard', 'funnel', 'contacts', 'marketing', 'analysis', 'settings'].map(n => read(`public/js/${n}.js`)).join('\n;\n');
const html = `<title>Real 4U Marketing e Comercial</title>
<style>${read('public/css/app.css')}
:root { color-scheme: light; }
body { background: var(--bg); color: var(--text); }
</style>
<div id="root"></div>
<script>${safe(read('node_modules/sql.js/dist/sql-asm.js'))}</script>
<script>${safe(bundle)}</script>
<script>${safe(ui)}</script>
<script>${safe(read('hosted/hosted-ui.js'))}</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/real4u-hospedado.html'), html);
console.log('dist/real4u-hospedado.html', (html.length / 1e6).toFixed(2), 'MB');
})();
