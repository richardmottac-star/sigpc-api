// CAMINHO: sigpc-api/teste_sgpe_vinculo.js
//
// A VINCULAÇÃO MÃE/PARCIAIS (lib/sgpe-vinculo.js + GET /sgpe/vinculo). Sem rede, sem banco.
//
// O que protege: a faixa diz o TAMANHO da TR. Um número menor que o real — por recorte, por
// agrupamento errado ou por PC sem processo somindo da conta — se lê como o total, e ninguém
// desconfia de um número plausível.
//
// USO: node teste_sgpe_vinculo.js
'use strict';

const fs = require('fs');
const path = require('path');
const v = require('./lib/sgpe-vinculo');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

// ── uma TR de mentira, com os casos que o acervo tem ────────────────────────
const pc = (processo_pc, parcial_num, tipo) =>
  ({ tr: '2020TR000637', entidade: 'APAE DE PINHALZINHO', processo_mae: 'SCC3538/2020',
     processo_pc, parcial_num, tipo: tipo || 'parcial' });
const TR = [
  pc('SCC 00011126/2024', '1'), pc('SCC 00011126/2024', '1'),   // 2 PCs, mesma parcial
  pc('SCC11126/2024', '2'),                                     // a MESMA grafia, sem zeros
  pc('SCC9460/2021', '3'), pc('SCC9460/2021', '4'),             // 1 processo, DUAS parciais
  pc('-1', '5'), pc('', '6'), pc('-', '7'),                     // os tres marcadores de ausencia
  pc('AR355478172', '8'),                                       // malformado: entra cru
  pc(null, '9'),
  pc('SCC 00012090/2024', '1', 'FINAL'),                        // a final, em maiuscula
];

S('1. A CHAVE');
conf(v.chave('SCC 00003538/2020') === 'SCC35382020', 'letras + digitos, zero a esquerda fora', v.chave('SCC 00003538/2020'));
conf(v.chave('SCC3538/2020') === v.chave('SCC 3538/2020')
  && v.chave('SCC3538/2020') === v.chave('SCC 00003538/2020'), 'as tres grafias caem na mesma chave');
conf(v.chave('scc3538/2020') === 'SCC35382020', 'minuscula sobe');
conf(v.chave('') === '' && v.chave(null) === '' && v.chave(undefined) === '', 'vazio vira vazio');
// ⚠️ O ZERO A ESQUERDA SAI UMA VEZ SO, sobre TODOS os digitos juntos — e e isso que a
// distingue da `busca.chaveProcesso`, que tira de cada numero separadamente. As duas
// discordam nas regionais; o cabecalho da lib registra a medicao que autorizou esta.
conf(v.chave('ADR20 00001233/2017') === 'ADR20000012332017', 'e a regional segue esta regra, nao a da busca');
// ⚠️ A EXPRESSAO SQL APLICA A MESMA REGRA, e o `expr` entra DUAS vezes — letras e digitos.
conf((v.CHAVE_SQL('x').match(/\bx\b/g) || []).length === 2, 'a expressao SQL usa o campo duas vezes');
conf(/\[\^A-Z\]/.test(v.CHAVE_SQL('x')) && /\^0\+/.test(v.CHAVE_SQL('x')), 'e e a regra registrada');

S('2. QUEM E "SEM PROCESSO"');
// ⚠️ OS TRES MARCADORES DO ACERVO. Sem esta lista, uma PC sem processo viraria um "processo"
// chamado `-1` na faixa — e a pessoa iria corrigir um processo que nao existe.
for (const m of ['', '-', '-1', '  -1  ', null, undefined])
  conf(v.semProcesso(m) === true, `${JSON.stringify(m)} conta como sem processo`);
conf(v.semProcesso('SCC9460/2021') === false, 'e um processo de verdade nao');
conf(v.semProcesso('AR355478172') === false, 'nem um malformado — a rota nao julga validade');

S('3. A FINAL E POR `tipo`, NUNCA PELO TEXTO');
// Armadilha 15: no acervo ha FINAL (981), Final (39) e final (1), e cinco finais gravadas com
// `parcial_num = '1'` — testar pelo texto as misturaria a parcial 1.
for (const t of ['FINAL', 'Final', 'final', ' final '])
  conf(v.ehFinal({ tipo: t }) === true, `tipo="${t}" e final`);
conf(v.ehFinal({ tipo: 'parcial', parcial_num: 'FINAL' }) === false,
     'e `parcial_num` dizendo FINAL nao faz uma parcial virar final');

S('4. O BLOCO');
const d = v.montar(TR, v.chave('SCC 11126/2024'), 'parcial');
conf(d.encontrado === true && d.papel === 'parcial', 'encontrado e papel');
conf(d.tr === '2020TR000637' && d.entidade === 'APAE DE PINHALZINHO', 'tr e entidade');
conf(d.processo_mae === 'SCC3538/2020', 'processo mae');
conf(d.total_pcs === TR.length, 'total_pcs e o numero de PCs recebidas', d.total_pcs);
conf(d.pcs_sem_processo === 4, 'as quatro sem processo (-1, vazio, - e null)', d.pcs_sem_processo);

// ⚠️ A CONFERENCIA QUE IMPORTA: a soma tem de FECHAR. Se ela nao fechar, a faixa mostra
// menos PCs do que a TR tem, e o numero menor se le como o total.
const soma = d.processos.reduce((n, p) => n + p.qtd, 0) + d.pcs_sem_processo;
conf(soma === d.total_pcs, `soma de qtd + sem_processo = total_pcs`, `${soma} vs ${d.total_pcs}`);
conf(d.total_processos_parciais === d.processos.length, 'total_processos_parciais bate com a lista');

S('5. O AGRUPAMENTO');
const acha = (p) => d.processos.find((x) => x.processo === p);
conf(acha('SCC 00011126/2024').qtd === 2, 'duas PCs no mesmo processo somam qtd 2');
// ⚠️ AGRUPA PELO VALOR CRU, e nao pela chave: as duas grafias do mesmo processo na mesma TR
// sao DUAS linhas, de proposito — e o que a pessoa precisa ver para decidir corrigir uma.
conf(!!acha('SCC11126/2024') && !!acha('SCC 00011126/2024'), 'as duas grafias aparecem separadas');
conf(v.chave('SCC11126/2024') === v.chave('SCC 00011126/2024'), 'mesmo tendo a MESMA chave');
// ⚠️ E as DUAS ficam `atual`, porque as duas sao o processo consultado.
conf(acha('SCC11126/2024').atual === true && acha('SCC 00011126/2024').atual === true,
     'e as duas sao marcadas como a consultada');
conf(acha('SCC9460/2021').qtd === 2 && acha('SCC9460/2021').parciais.join(',') === '3,4',
     'um processo com duas parciais lista as duas', acha('SCC9460/2021').parciais.join(','));
conf(!!acha('AR355478172'), 'o malformado entra na lista, com o valor cru');
conf(!d.processos.some((p) => v.semProcesso(p.processo)), 'e nenhum marcador de ausencia virou processo');

S('6. AS PARCIAIS SAO `parcial_num`, E A FINAL VAI NO FIM');
conf(acha('SCC 00012090/2024').parciais.join(',') === 'final', 'a PC final entra como "final"');
const comFinal = v.montar(
  [pc('SCC1/2020', '2'), pc('SCC1/2020', '1'), pc('SCC1/2020', '10'), pc('SCC1/2020', '1', 'FINAL')],
  '', 'parcial');
conf(comFinal.processos[0].parciais.join(',') === '1,2,10,final',
     'ordena por numero (10 depois de 2) e joga a final para o fim',
     comFinal.processos[0].parciais.join(','));

S('7. NAO ACHOU E NAO ACHOU');
conf(v.NAO_ENCONTRADO.encontrado === false, 'encontrado: false');
conf(Object.keys(v.NAO_ENCONTRADO).length === 1, 'e SO isso — sem tr, sem entidade, sem palpite',
     Object.keys(v.NAO_ENCONTRADO).join(','));

S('8. A ROTA, NO server.js');
{
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/sgpe/vinculo'");
  conf(i > 0, 'a rota existe');
  const bloco = src.slice(i, src.indexOf('\n});', i));
  // ⚠️ A MAE VEM PRIMEIRO: um texto pode estar nos dois campos, e perguntar `processo_pc`
  // antes devolveria "parcial" para o que e mae.
  const iMae = bloco.indexOf("achar('processo_mae')"), iPc = bloco.indexOf("achar('processo_pc')");
  conf(iMae > 0 && iPc > iMae, 'procura em processo_mae ANTES de processo_pc');
  conf(/papel = 'mae'/.test(bloco) && /papel = 'parcial'/.test(bloco), 'e nomeia os dois papeis');
  // ⚠️ TODAS AS PCs DA TR: sem analista, sem baixada, sem LIMIT.
  const iSel = bloco.indexOf('FROM prestacoes_contas\n        WHERE tr = $1');
  const sel = iSel > 0 ? bloco.slice(iSel, iSel + 200) : bloco.slice(bloco.indexOf('WHERE tr = $1'));
  conf(!/analista_id|baixada/.test(sel), 'a lista da TR nao filtra por analista nem por baixada');
  conf(!/LIMIT/.test(sel), 'e nao tem LIMIT');
  conf(/vinculo\.CHAVE_SQL\(coluna\)/.test(bloco) && /vinculo\.CHAVE_SQL\('\$1::text'\)/.test(bloco),
       'a chave e aplicada aos DOIS lados, pela mesma expressao da lib');
  // ⚠️ `$1::text` — sem o tipo, o Postgres recusa `upper($1)` com "could not determine data type".
  conf(/\$1::text/.test(bloco), 'e o parametro vai tipado');
  conf(/vinculo\.montar\(rows, k, papel\)/.test(bloco), 'e quem monta o bloco e a lib');
  conf(!/INSERT|UPDATE|DELETE/.test(bloco), 'a rota e SO LEITURA');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
