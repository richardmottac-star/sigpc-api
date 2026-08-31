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
const pc = (processo_pc, parcial_num, tipo, extra) =>
  ({ tr: '2020TR000637', entidade: 'APAE DE PINHALZINHO', processo_mae: 'SCC3538/2020',
     processo_pc, parcial_num, tipo: tipo || 'parcial',
     // ⚠️ Vem do LEFT JOIN com `sgpe_situacao` (31/08/2026). `null` significa "ainda nao
     // sincronizado", e nao "sem assunto" — o job so preenche quando o rodizio passa.
     assunto: null, situacao_portal: null, mae_assunto: null, mae_situacao_portal: null,
     ...(extra || {}) });
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

S('7b. O ASSUNTO E A SITUACAO');
{
  // ⚠️ SAO LIDOS DA PRIMEIRA LINHA DE CADA PROCESSO, e nao somados: todas as PCs de um mesmo
  // `processo_pc` casam a MESMA linha da `sgpe_situacao` — a chave e o processo, nao a PC.
  const TR2 = [
    pc('SCC9460/2021', '1', 'parcial', { assunto: 'PRESTACAO DE CONTAS', situacao_portal: 'ABERTO',
                                         mae_assunto: 'CONVENIO', mae_situacao_portal: 'ARQUIVADO' }),
    pc('SCC9460/2021', '2', 'parcial', { assunto: 'PRESTACAO DE CONTAS', situacao_portal: 'ABERTO',
                                         mae_assunto: 'CONVENIO', mae_situacao_portal: 'ARQUIVADO' }),
    pc('SCC1111/2021', '3'),                       // sem par na sgpe_situacao
  ];
  const d2 = v.montar(TR2, '', 'parcial');
  const a = d2.processos.find((x) => x.processo === 'SCC9460/2021');
  const b = d2.processos.find((x) => x.processo === 'SCC1111/2021');
  conf(a.assunto === 'PRESTACAO DE CONTAS', 'o processo sincronizado traz o assunto', a.assunto);
  conf(a.situacao_portal === 'ABERTO', 'e a situacao_portal', a.situacao_portal);
  conf(a.qtd === 2, 'e as duas PCs dele seguem contando 2 — o join nao duplica linha', a.qtd);
  // ⚠️ `null` E RESPOSTA: quer dizer "ainda nao sincronizado", nao "sem assunto".
  conf(b.assunto === null && b.situacao_portal === null, 'o nao sincronizado vem com os dois null');
  conf('assunto' in b && 'situacao_portal' in b, 'e os campos EXISTEM na resposta, nulos');
  // ⚠️ A MAE TEM OS SEUS PROPRIOS, do join dela — nao os do processo_pc da primeira linha.
  conf(d2.mae_assunto === 'CONVENIO', 'a mae traz o assunto DELA', d2.mae_assunto);
  conf(d2.mae_situacao_portal === 'ARQUIVADO', 'e a situacao DELA', d2.mae_situacao_portal);
  conf(d2.mae_assunto !== a.assunto, 'que e outro processo, e outro assunto');
  // Sem nada vindo do banco, tudo null — nunca `undefined`, que a tela leria diferente.
  const d3 = v.montar([pc('SCC1/2020', '1')], '', 'parcial');
  conf(d3.processos[0].assunto === null && d3.mae_assunto === null, 'ausencia vira null, nunca undefined');
}

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

  // ── O JOIN DA SITUACAO (31/08/2026) ──────────────────────────────────────
  // ⚠️ DUAS CHAVES NESTA ROTA, DE PROPOSITO. Achar a TR usa a do `sgpe-vinculo`; juntar a
  // situacao usa a do `busca`. Medido: a primeira casa 7.538 de 7.839 e deixa 295 regionais
  // sem par; a segunda casa 7.829 e deixa 4. Com a primeira, 295 processos diriam "ainda nao
  // sincronizado" ESTANDO sincronizados.
  conf(/LEFT JOIN sgpe_situacao s/.test(bloco) && /LEFT JOIN sgpe_situacao m/.test(bloco),
       'ha dois LEFT JOIN — um para a parcial, outro para a mae');
  // ⚠️ LEFT, NUNCA INNER: um INNER faria a PC nao sincronizada SUMIR da faixa.
  conf(!/\bINNER JOIN sgpe_situacao/.test(bloco), 'e sao LEFT, nunca INNER');
  conf((bloco.match(/CHAVE_PROC_SQL\(/g) || []).length === 4,
       'o join usa a chave da lib/busca nos quatro lados',
       (bloco.match(/CHAVE_PROC_SQL\(/g) || []).length);
  conf(/s\.assunto, s\.situacao_portal/.test(bloco), 'e traz assunto e situacao_portal');
  conf(/m\.assunto AS mae_assunto/.test(bloco), 'com os da mae em campos proprios');
  // ⚠️ A COLUNA CHAMA-SE `situacao_portal`, e nao `situacao`.
  conf(!/s\.situacao\b(?!_portal)/.test(bloco), 'e o nome da coluna e situacao_portal');
}

S('9. O JOB GRAVA O ASSUNTO');
{
  const sit = fs.readFileSync(path.join(__dirname, 'lib', 'sgpe-situacao.js'), 'utf8');
  // ⚠️ DO MESMO LUGAR DE ONDE O MODAL DO F4 JA LIA: `pr.assunto`, que a lib do portal monta
  // do `nmAssunto`. Nunca foi gravado ate 31/08/2026.
  conf(/assunto: pr\.assunto \? String\(pr\.assunto\)\.slice\(0, 120\) : null/.test(sit),
       'a linha leva o assunto do portal, cortado em 120');
  conf(/\(sigla, numero_oficial, ano, resultado, situacao_portal, estado_portal, posicao,[\s\S]{0,160}assunto, checado_em\)/.test(sit),
       'a coluna entra no INSERT');
  // ⚠️ A MESMA PROTECAO DOS DEMAIS: num resultado de REDE o assunto NAO e apagado. O portal
  // fora do ar por uma hora nao pode zerar o assunto de 300 processos.
  conf(/assunto\s+= CASE WHEN EXCLUDED\.resultado = ANY\(\$14::text\[\]\) THEN EXCLUDED\.assunto/.test(sit),
       'e o upsert protege o valor antigo num erro de rede');
  // ⚠️ `$15` NO FIM: po-lo na posicao 14 renumeraria o RESULTADOS_QUE_SUBSTITUEM, que aparece
  // onze vezes no SQL — onze lugares para errar um, em silencio.
  conf(/l\.erro_motivo, RESULTADOS_QUE_SUBSTITUEM,[\s\S]{0,320}l\.assunto\]/.test(sit),
       'e o parametro novo e o ultimo, sem renumerar os que ja existiam');
  conf(/VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11::date,\$12,\$13,\$15, NOW\(\)\)/.test(sit),
       'o VALUES usa $15 para o assunto');
}

S('10. A MIGRACAO');
{
  const mig = fs.readFileSync(path.join(__dirname, 'migracao_assunto_situacao_20260831.js'), 'utf8');
  conf(/const EXECUTAR = process\.argv\.includes\('--executar'\)/.test(mig), 'dry-run por padrao');
  conf(/ADD COLUMN IF NOT EXISTS/.test(mig), 'idempotente no proprio ALTER');
  conf(/await cli\.query\('BEGIN'\)/.test(mig), 'roda em transacao');
  conf(/if \(falhas\.length\) \{[\s\S]{0,80}ROLLBACK/.test(mig), 'e faz ROLLBACK se alguma conferencia falhar');
  // ⚠️ AS CONFERENCIAS SAO DEPOIS DE GRAVAR, contra a foto — conferir so antes prova o que se
  // esperava, nao o que aconteceu.
  const iAlter = mig.indexOf('await cli.query(SQL)');
  const iConf = mig.indexOf('CONFERÊNCIAS (depois do ALTER');
  conf(iAlter > 0 && iConf > iAlter, 'as conferencias vem DEPOIS do ALTER');
  conf(/para_reverter/.test(mig) && /JSON\.stringify/.test(mig), 'e a reversao vai para um JSON');
  // ⚠️ O `DROP COLUMN` APARECE NO ARQUIVO — no cabecalho e no JSON de reversao —, e tem de
  // aparecer: e o registro de como desfazer. O que nao pode e alguem EXECUTAR. Entao a
  // checagem olha as chamadas ao banco, uma a uma, e nao o texto solto.
  const chamadas = mig.match(/cli\.query\(([\s\S]*?)\)/g) || [];
  conf(chamadas.length > 0, 'o script fala com o banco', chamadas.length);
  conf(!chamadas.some((c) => /DROP/i.test(c)), 'e NENHUMA chamada executa um DROP',
       chamadas.filter((c) => /DROP/i.test(c)).join(' | '));
  conf(/DROP COLUMN IF EXISTS/.test(mig), 'o comando de reversao esta REGISTRADO no JSON');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
