'use strict';
process.removeAllListeners('warning');
const app = require('./src/server');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`RH rodando em http://localhost:${PORT}`));
