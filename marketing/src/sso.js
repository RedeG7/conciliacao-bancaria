'use strict';
// Login único vindo do Hub (hub.redeg7.com). O Hub confere a sessão do usuário
// e redireciona para /sso?t=<bilhete>; o bilhete é assinado (HMAC-SHA256) com o
// segredo compartilhado SSO_SECRET, vale 60 segundos e só pode ser usado uma vez.
const crypto = require('crypto');

const usados = new Map(); // jti -> exp (segundos), contra reuso do mesmo bilhete

function verificar(bilhete, segredo, agora = Math.floor(Date.now() / 1000)) {
  if (!segredo || typeof bilhete !== 'string') return null;
  const [corpo, assinatura] = bilhete.split('.');
  if (!corpo || !assinatura) return null;
  const esperada = Buffer.from(crypto.createHmac('sha256', segredo).update(corpo).digest('base64url'));
  const recebida = Buffer.from(assinatura);
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.sub !== 'string' || !p.sub || typeof p.exp !== 'number' || p.exp < agora || !p.jti) return null;
  for (const [j, exp] of usados) if (exp < agora) usados.delete(j);
  if (usados.has(p.jti)) return null;
  usados.set(p.jti, p.exp);
  return p;
}

module.exports = { verificar };
