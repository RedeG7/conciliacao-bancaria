'use strict';
process.removeAllListeners('warning');
const app = require('./src/server');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Simulador INSS Obras rodando em http://localhost:${PORT}`));
// Selic do Banco Central uma vez por dia (desligar com SELIC_AUTO=0)
if (process.env.SELIC_AUTO !== '0') require('./src/integracoes').agendarSelic();
