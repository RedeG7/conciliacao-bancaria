'use strict';
process.removeAllListeners('warning');
const app = require('./src/server');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Real 4U — Marketing & Comercial rodando em http://localhost:${PORT}`));
// sincronização automática do Meta Ads de todos os escritórios conectados
if (process.env.META_SYNC !== '0') require('./src/meta').startScheduler();
