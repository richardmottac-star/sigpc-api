// CAMINHO: sigpc-api/teste_sgpe_siglas.js
//
// GET /sgpe/siglas — a janela para o mapa de órgãos do `lib/sgpe-link.js`.
//
// ⚠️ O QUE ESTE TESTE GUARDA NÃO É O NÚMERO 183, É A FONTE ÚNICA. Ele lê o corpo da rota
// direto do `server.js` e o executa contra o `ORGAOS` de verdade: se alguém um dia colar uma
// lista literal ali dentro, a comparação com `Object.keys(ORGAOS)` acusa. Conferir só o
// tamanho deixaria passar uma cópia com as mesmas 183 chaves — que é exatamente o defeito que
// o mapa de nomes curtos teve por três meses.
'use strict';

const fs = require('fs');
const path = require('path');
const { ORGAOS, SIGLAS_AMBIGUAS } = require('./lib/sgpe-link');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const m = src.match(/app\.get\('\/sgpe\/siglas',[\s\S]*?\r?\n\}\);/);
if (!m) { console.error('FALHOU: a rota GET /sgpe/siglas não está no server.js'); process.exit(1); }

// O corpo da rota, executado tal como está escrito — sem express, sem banco, sem rede.
let rota = null;
const app = { get: (_p, h) => { rota = h; } };
eval(m[0]);   // eslint-disable-line no-eval

let saida = null;
rota({ query: {} }, { json: (j) => { saida = j; } });

const erros = [];
const ok = (cond, msg) => { if (!cond) erros.push(msg); };
const d = (saida && saida.data) || {};

ok(saida && saida.error === null, 'error deveria ser null');
ok(d.total === 183, 'total = ' + d.total + ', esperado 183');
ok(Array.isArray(d.siglas) && d.siglas.length === 183, 'siglas tem ' + (d.siglas || []).length + ' itens');
ok(d.siglas && d.siglas.join(',') === Object.keys(ORGAOS).sort().join(','),
   'a lista devolvida NÃO é a do ORGAOS — apareceu uma segunda cópia');
ok(d.ambiguas && d.ambiguas.join(',') === SIGLAS_AMBIGUAS.join(','), 'ambiguas divergiu da lib');
ok(d.siglas && d.siglas.includes('FCEE') && d.siglas.includes('SCC') && d.siglas.includes('ADR20'),
   'faltou sigla que o acervo usa em volume');
ok(d.siglas && !d.siglas.includes('SSC'), 'SSC entrou, e ela não existe no SGPe');
ok(d.siglas && d.siglas.slice().sort().join(',') === d.siglas.join(','), 'a lista não veio ordenada');

// ⚠️ A rota devolve uma CÓPIA de `SIGLAS_AMBIGUAS`. Devolver a constante viva deixaria um
// `push` de quem consome mexer no mapa do processo inteiro — o Express serializa depois.
if (Array.isArray(d.ambiguas)) d.ambiguas.push('LIXO');
ok(SIGLAS_AMBIGUAS.indexOf('LIXO') === -1, 'a rota devolveu a constante VIVA, não uma cópia');

if (erros.length) {
  console.error('teste_sgpe_siglas: ' + erros.length + ' falha(s)\n - ' + erros.join('\n - '));
  process.exit(1);
}
console.log('teste_sgpe_siglas: 9 checagens, 0 falhas — 183 siglas, lidas de lib/sgpe-link.js');
