'use strict';
// Certificado digital A1 (.pfx/.p12) dos clientes: leitura (titular, CPF/CNPJ,
// validade) e cifra do arquivo e da senha antes de gravar no banco.
// A chave vem de CERT_ENC_KEY (gerada pelo deploy, ver deploy.yml). Perder a
// chave torna os certificados gravados irrecuperáveis (é preciso reenviar).
const crypto = require('crypto');
const forge = require('node-forge');

class CertError extends Error {}

const chave = () => {
  const k = process.env.CERT_ENC_KEY || '';
  return k ? crypto.createHash('sha256').update(k).digest() : null;
};
const cifraDisponivel = () => !!chave();

// AES-256-GCM: base64(iv | tag | texto cifrado)
function cifrar(buf) {
  const k = chave();
  if (!k) throw new CertError('Guarda de certificados não configurada no servidor (CERT_ENC_KEY).');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decifrar(b64) {
  const k = chave();
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

const texto = v => { try { return forge.util.decodeUtf8(v || ''); } catch (e) { return v || ''; } };

// Lê o .pfx e devolve os dados do certificado do titular. Senha errada ou
// arquivo que não é PKCS#12 viram CertError com mensagem para o usuário.
function lerPfx(buf, senha) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(buf.toString('binary')), false, senha);
  } catch (e) {
    throw new CertError(/mac|password|invalid/i.test(e.message) ? 'Senha do certificado incorreta.' : 'Arquivo não é um certificado A1 (.pfx/.p12) válido.');
  }
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map(b => b.cert).filter(Boolean);
  const chaves = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])
    .concat(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
  if (!certs.length || !chaves.length) throw new CertError('O arquivo não traz o certificado com a chave privada (exporte o A1 completo).');
  // o do titular é o que não é de autoridade certificadora
  const cert = certs.find(c => !(c.getExtension('basicConstraints') || {}).cA) || certs[0];
  const cn = texto(cert.subject.getField('CN')?.value);
  // ICP-Brasil: "RAZAO SOCIAL:12345678000199" (e-CNPJ) ou "NOME:12345678901" (e-CPF)
  const m = cn.match(/^(.*):(\d{11}|\d{14})$/);
  return {
    titular: m ? m[1] : cn,
    documento: m ? m[2] : '',
    emissor: texto(cert.issuer.getField('CN')?.value),
    validade: cert.validity.notAfter.toISOString(),
  };
}

const diasPara = iso => Math.floor((new Date(iso) - Date.now()) / 864e5);

module.exports = { lerPfx, cifrar, decifrar, cifraDisponivel, diasPara, CertError };
