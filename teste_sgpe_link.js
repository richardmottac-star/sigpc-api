// CAMINHO: sigpc-api/teste_sgpe_link.js
//
// Testes da parte PURA do link do SGPe (lib/sgpe-link.js). Sem rede, sem banco.
//
// ⚠️ O `nuProcesso` usado aqui é o número OFICIAL, só para conferir a montagem da URL.
// Em produção ele NUNCA sai do número da tela: vem do SGPe (lib/sgpe-dwr.js). Ver o aviso
// no topo do sgpe-link.js — não existe fórmula.
//
// USO: node teste_sgpe_link.js

const {
  normalizarProcesso, formatarProcesso, siglaConhecida, orgaoDaSigla, montarUrlSgpe, ORGAOS,
} = require('./lib/sgpe-link');

let ok = 0, falhou = 0;

// Pipeline completo: texto cru -> link, ou null com o motivo.
function resolver(bruto) {
  const p = normalizarProcesso(bruto);
  if (!p) return { url: null, motivo: 'rejeitado na normalizacao' };
  if (!siglaConhecida(p.sigla)) return { url: null, motivo: `sigla ${p.sigla} fora do mapa` };
  return { url: montarUrlSgpe(p.numero, orgaoDaSigla(p.sigla), p.ano), sigla: p.sigla, motivo: '' };
}

function teste(bruto, esperado, nota) {
  const r = resolver(bruto);
  const obtido = r.url ? r.url.match(/processoPK=([^&]+)/)[1] : null;
  const passou = obtido === esperado;
  passou ? ok++ : falhou++;
  const rotulo = bruto === null ? 'null' : bruto === '' ? '""' : `"${bruto}"`;
  console.log(
    `  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo.padEnd(24)} -> ${String(obtido).padEnd(22)}`
    + `${passou ? '' : ` (esperado ${esperado})`}${r.motivo ? '   [' + r.motivo + ']' : ''}`
    + `${nota ? '   · ' + nota : ''}`);
}

console.log('\n═══ 1. CASOS PEDIDOS ═══');
teste('ADR20 00001233/2017', '1233,13477,2017', 'regiao com separador');
teste('ADR17 00000867/2017', '867,13447,2017', 'regiao com separador');
teste('SCC 00007055/2021', '7055,10068,2021', 'sigla sem regiao');
teste('SDR13 00001028/2013', '1028,6991,2013', 'SDR com separador');
teste('ADR223151/2017', null, 'AMBIGUO: sem separador');
teste('ADR 3151/2017', null, 'ADR sozinha nao e orgao');
teste('', null, 'vazio');
teste(null, null, 'null');

console.log('\n═══ 2. OUTROS SEPARADORES ═══');
teste('ADR20-1233/2017', '1233,13477,2017', 'hifen');
teste('ADR20.1233/2017', '1233,13477,2017', 'ponto');
teste('ADR11 354 /2017', '354,13385,2017', 'espaco antes da barra (real no acervo)');
teste('adr09 594/2017', '594,13357,2017', 'minusculo');

console.log('\n═══ 3. REGRESSAO — sigla colada ao numero (a maior parte do acervo) ═══');
teste('SCC2146/2020', '2146,10068,2020', 'NAO pode virar SCC21 n.46');
teste('SCC15324/2021', '15324,10068,2021', '');
teste('FCEE264/2017', '264,4267,2017', '');
teste('SED75922/2024', '75922,7054,2024', '');
teste('SCC 00009622/2024', '9622,10068,2024', '');

console.log('\n═══ 4. AMBIGUIDADE COLADA — todos tem de dar null ═══');
teste('SDR05001028/2017', null, 'SDR nao e orgao, SDR05 e');
teste('ADR050001027/2017', null, '');
teste('ADR18968/2017', null, '');

console.log('\n═══ 5. LIXO E MALFORMADO ═══');
teste('Aguardando protocolo', null, '');
teste('SCC 6579', null, 'sem ano');
teste('SCC 7229 2024', null, 'sem barra');
teste('9223/2026', null, 'sem sigla');
teste('-', null, '');
teste('ADR2400000965/2017', null, 'numero com 10 digitos');

console.log('\n═══ 6. INTEGRIDADE DO MAPA ═══');
const n = Object.keys(ORGAOS).length;
console.log(`  ${n === 183 ? 'OK  ' : 'FALHA'}  183 pares no mapa -> ${n}`);
n === 183 ? ok++ : falhou++;
const dup = Object.entries(ORGAOS).reduce((a, [k, v]) => { (a[v] = a[v] || []).push(k); return a }, {});
const colisoes = Object.entries(dup).filter(([, ks]) => ks.length > 1);
console.log(`  INFO  codigos repetidos: ${colisoes.length ? colisoes.map(([v, ks]) => v + '=' + ks.join('/')).join(' · ') : 'nenhum'}`);
for (const s of ['ADR01', 'ADR35', 'SDR01', 'SDR36', 'CMDO-G', 'SAPIENS_EXTERNO_INAT', 'SGPE']) {
  const tem = !!ORGAOS[s];
  console.log(`  ${tem ? 'OK  ' : 'FALHA'}  chave ${s} presente`);
  tem ? ok++ : falhou++;
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
