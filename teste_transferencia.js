// CAMINHO: sigpc-api/teste_transferencia.js
//
// A REGRA DA TRANSFERENCIA, com duble — sem banco, sem rede.
//
// ⚠️ O QUE ELE GUARDA: que a PC BAIXADA nao se move. E a regra central, e a unica que erra
// sem dar erro: mover a baixada junto transferiria a PRODUTIVIDADE de uma pessoa para outra
// — quem saiu perde o que fez, quem recebe ganha o que nao fez, e os dois numeros ficam
// errados em silencio.
//
// ⚠️ O SQL CRU E CONFERIDO CONTRA O POSTGRES DE VERDADE em `conferir_transferencia_*.js`,
// dentro de BEGIN/ROLLBACK. Aqui e o duble, e as duas coisas nao se misturam — armadilha 11.
//
// USO: node teste_transferencia.js

const fs = require('fs');
const path = require('path');
const transf = require('./lib/transferencia');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

const DE = 40, PARA = 7, OUTRO = 99;
// Uma TR mista: duas abertas do DE, uma baixada do DE, e uma aberta de OUTRO noutra TR.
const FOTO = [
  { codigo_pc: '2022PC000001', tr: 'T1', parcial_num: '1', setorial_id: 'FCEE', analista_id: DE,    analista_nome: 'Goreti', baixada: false, status: 'analise',    dt_assumida: '2026-01-01', dt_inicio_analise: '2026-01-02' },
  { codigo_pc: '2022PC000002', tr: 'T1', parcial_num: '2', setorial_id: 'FCEE', analista_id: DE,    analista_nome: 'Goreti', baixada: false, status: 'diligencia', dt_assumida: '2026-01-01', dt_inicio_analise: '2026-01-02' },
  { codigo_pc: '2022PC000003', tr: 'T1', parcial_num: '3', setorial_id: 'FCEE', analista_id: DE,    analista_nome: 'Goreti', baixada: true,  status: 'baixada',    dt_assumida: '2026-01-01', dt_inicio_analise: '2026-01-02' },
  { codigo_pc: '2022PC000004', tr: 'T2', parcial_num: '1', setorial_id: 'FCEE', analista_id: OUTRO, analista_nome: 'Outro',  baixada: false, status: 'analise',    dt_assumida: '2026-01-01', dt_inicio_analise: '2026-01-02' },
];

S('1. A VALIDACAO');
conf(transf.validar({ de_id: DE, para_id: PARA, trs: ['T1'], usuario_id: 4 }) === null, 'o corpo completo passa');
conf(transf.validar(null) !== null, 'corpo vazio recusado');
conf(transf.validar({ para_id: PARA, trs: ['T1'], usuario_id: 4 }) !== null, 'sem de_id recusa');
conf(transf.validar({ de_id: DE, trs: ['T1'], usuario_id: 4 }) !== null, 'sem para_id recusa');
// ⚠️ O MESMO ID NAS DUAS PONTAS: sem esta recusa o UPDATE roda contra ele mesmo, grava
// historico de uma transferencia que nao aconteceu, e devolve "N PCs transferidas" com todas
// paradas no mesmo lugar. Um sucesso mentiroso.
conf(transf.validar({ de_id: DE, para_id: DE, trs: ['T1'], usuario_id: 4 }) !== null,
     'de_id igual a para_id recusa');
conf(transf.validar({ de_id: DE, para_id: PARA, trs: [], usuario_id: 4 }) !== null, 'lista de TRs vazia recusa');
conf(transf.validar({ de_id: DE, para_id: PARA, trs: ['T1'] }) !== null, 'sem usuario_id recusa');
conf(transf.validar({ de_id: DE, para_id: PARA, trs: ['  '], usuario_id: 4 }) !== null, 'TR em branco recusa');

S('2. A LISTA DE TRs, LIMPA');
conf(transf.trsLimpas([' T1 ', 'T1', 'T2', '', null]).join(',') === 'T1,T2',
     'apara, tira repetida e ignora vazia', transf.trsLimpas([' T1 ', 'T1', 'T2', '', null]).join(','));

S('3. O QUE SE MOVE E O QUE FICA');
const movem = transf.pcsQueMovem(FOTO, DE);
const ficam = transf.pcsQueFicam(FOTO, DE);
conf(movem.length === 2, 'movem-se as DUAS abertas do de_id', movem.map((m) => m.codigo_pc).join(','));
conf(movem.every((m) => !m.baixada), 'e nenhuma delas esta baixada');
// ⚠️ A REGRA CENTRAL. A unidade de produtividade e a PC baixada (CGE 727/2025), e ela e de
// quem a analisou.
conf(ficam.length === 1 && ficam[0].codigo_pc === '2022PC000003', 'a baixada FICA', ficam.map((f) => f.codigo_pc).join(','));
conf(!movem.some((m) => m.analista_id === OUTRO), 'e PC de outro analista nao entra');

S('4. TR QUE NAO E DO de_id E RECUSADA, COM A LISTA');
// ⚠️ "SER DO de_id" E TER PC ABERTA DELE — nao e o analista_nome, que e texto livre e ja
// contradisse o analista_id em 10 PCs; e nao e "todas as PCs serem dele", porque a TR fica
// MISTA justamente depois de uma transferencia.
conf(transf.trsAlheias(['T1'], FOTO, DE).length === 0, 'a TR com aberta do de_id passa');
conf(transf.trsAlheias(['T2'], FOTO, DE).join(',') === 'T2', 'a TR de outro e recusada');
conf(transf.trsAlheias(['T1', 'T2'], FOTO, DE).join(',') === 'T2',
     'e a lista diz QUAL, sem levar a boa junto', transf.trsAlheias(['T1', 'T2'], FOTO, DE).join(','));
conf(transf.trsAlheias(['T9'], FOTO, DE).join(',') === 'T9', 'TR que nem existe tambem e recusada');
// ⚠️ TR SO COM BAIXADA E RECUSADA: nao ha o que mover nela, e aceita-la devolveria "0 PCs
// transferidas" com ar de sucesso.
const soBaixada = FOTO.filter((l) => l.baixada);
conf(transf.trsAlheias(['T1'], soBaixada, DE).join(',') === 'T1', 'TR so com baixada e recusada');

S('5. O UPDATE MEXE EM QUATRO COLUNAS, E SO NELAS');
// ⚠️ ORDEM DO RICHARD: situacao_atual, ci_*, eng_* e sigef_declaracao ficam como estavam.
const proibidas = ['situacao_atual', 'ci_situacao', 'ci_rodada', 'ci_encerrado_em', 'ci_encerrado_por',
  'ci_tecnico_id', 'ci_tecnico_em', 'eng_situacao', 'eng_enviada_em', 'eng_retorno_em',
  'sigef_declaracao', 'sigef_status', 'baixada', 'data_baixa', 'parecer_tipo', 'enviado_ci', 'status'];
const tocadas = proibidas.filter((c) => new RegExp('\\b' + c + '\\s*=').test(transf.SQL_MOVER));
conf(tocadas.length === 0, 'o UPDATE nao atribui a nenhuma coluna proibida', tocadas.join(', '));
conf(/analista_id = \$4/.test(transf.SQL_MOVER) && /analista_nome = \$5/.test(transf.SQL_MOVER),
     'ele troca o dono');
// ⚠️ dt_assumida REINICIA e dt_inicio_analise NAO. Sao perguntas diferentes: a primeira e
// "quando ESTE analista pegou", a segunda e o relogio do PRAZO. Reiniciar o prazo numa
// transferencia daria folego novo a uma PC parada ha meses.
conf(/dt_assumida = NOW\(\)/.test(transf.SQL_MOVER), 'e reinicia a dt_assumida');
conf(!/dt_inicio_analise\s*=/.test(transf.SQL_MOVER), 'mas NAO reinicia a dt_inicio_analise — e o prazo');
// ⚠️ O WHERE REPETE O FILTRO mesmo ja havendo a foto: entre a foto e o UPDATE cabe outra
// transacao. O WHERE e a garantia; a foto e a prova.
conf(/AND analista_id = \$3/.test(transf.SQL_MOVER), 'o WHERE prende o dono antigo');
conf(/AND NOT baixada/.test(transf.SQL_MOVER), 'e prende a aberta — a baixada nao se move nem por engano');

S('6. O HISTORICO');
const params = transf.paramsHistorico({
  movidas: movem.map((m) => ({ codigo_pc: m.codigo_pc, tr: m.tr, parcial_num: m.parcial_num })),
  foto: FOTO, deId: DE, paraId: PARA, deNome: 'Maria Goreti Korb', paraNome: 'Aline Silva',
  usuarioId: 4, motivo: 'Redistribuicao.',
});
conf(params.length === 10, 'sao dez arrays, um por coluna do INSERT', params.length);
conf(params[0].length === 2 && params.every((a) => a.length === 2), 'e todos com uma entrada por PC movida');
conf(params[3].every((e) => e === 'transferencia'), "o evento e 'transferencia'", params[3][0]);
// ⚠️ E NAO `transferencia_dispensa`: aquele foi o nome do script de 28/08 e nasceu do caso da
// dispensa. Esta rota transfere de qualquer analista — reusar o nome faria a trilha afirmar
// uma dispensa que nao houve.
conf(!params[3].includes('transferencia_dispensa'), 'e nao herda o nome do script da dispensa');
conf(params[4].every((v) => v === '40 · Goreti'), 'valor_anterior e "id · nome curto"', params[4][0]);
conf(params[5].every((v) => v === '7 · Aline'), 'valor_novo idem', params[5][0]);
conf(params[6].every((v) => v === PARA), 'o analista_id do historico e o NOVO dono');
// ⚠️ executado_por PREENCHIDO: pela lib/autoria ele fica NULO quando o dono executou, e aqui
// nunca e o caso — quem executa e o tecnico do sistema, o dono e quem recebeu. E justamente a
// linha em que os dois DIFEREM que se quer achar depois.
conf(params[8].every((v) => v === 4), 'executado_por preenchido com quem clicou', params[8][0]);
conf(params[6][0] !== params[8][0], 'e ele difere do dono — sao pessoas diferentes por definicao');
// ⚠️ estado_anterior E POR ONDE SE DESFAZ. Sem ela a transferencia e de mao unica.
const foto0 = JSON.parse(params[9][0]);
conf(foto0.analista_id === DE && foto0.status === 'analise' && foto0.dt_inicio_analise === '2026-01-02',
     'estado_anterior guarda a foto da PC — dono, status e as duas datas', JSON.stringify(foto0));
conf(params[7][0].includes('2022PC000001') && params[7][0].includes('Redistribuicao.'),
     'a observacao traz a PC e o motivo');

S('7. AS CONFERENCIAS DEPOIS DE GRAVAR');
// ⚠️ CONFERIR SO ANTES PROVA O QUE SE ESPERAVA, NAO O QUE ACONTECEU.
const depoisBom = FOTO.map((l) => (l.analista_id === DE && !l.baixada)
  ? { ...l, analista_id: PARA, analista_nome: 'Aline' } : l);
const movidasBom = movem.map((m) => ({ codigo_pc: m.codigo_pc, tr: m.tr, parcial_num: m.parcial_num }));
conf(transf.conferir({ foto: FOTO, depois: depoisBom, movidas: movidasBom, deId: DE, paraId: PARA }).length === 0,
     'o caminho bom nao acha problema');
// A baixada mexida — o defeito que apaga a produtividade de alguem.
const depoisBaixadaMexida = depoisBom.map((l) => l.baixada ? { ...l, analista_id: PARA } : l);
conf(transf.conferir({ foto: FOTO, depois: depoisBaixadaMexida, movidas: movidasBom, deId: DE, paraId: PARA }).length > 0,
     'baixada que mudou de dono e PEGA');
// Uma que devia mover e nao moveu.
const depoisMetade = FOTO.map((l) => l.codigo_pc === '2022PC000001' ? { ...l, analista_id: PARA } : l);
conf(transf.conferir({ foto: FOTO, depois: depoisMetade, movidas: movidasBom, deId: DE, paraId: PARA }).length > 0,
     'PC que ficou para tras e PEGA — nada de transferir metade');
// O UPDATE mexendo em conjunto diferente do previsto.
conf(transf.conferir({ foto: FOTO, depois: depoisBom, movidas: [movidasBom[0]], deId: DE, paraId: PARA }).length > 0,
     'conjunto movido diferente do previsto e PEGO');
// Linha que sumiu.
conf(transf.conferir({ foto: FOTO, depois: depoisBom.slice(1), movidas: movidasBom, deId: DE, paraId: PARA }).length > 0,
     'linha que sumiu da base e PEGA');

S('8. NA ROTA');
const rota = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const bloco = rota.slice(rota.indexOf("app.post('/transferencia'"), rota.indexOf('//  BUSCA GLOBAL'));
conf(!!bloco, 'a rota existe');
// ⚠️ O PERFIL VEM DO BANCO, nunca do corpo — o defeito das quatro rotas corrigidas em 14/08.
conf(/FROM usuarios WHERE id = \$1/.test(bloco), 'o perfil e lido do BANCO');
conf(/papel\.perfilEfetivo\(u\[0\]\) !== 'superadmin'/.test(bloco), 'e e o perfil EFETIVO');
conf(/status\(403\)/.test(bloco), 'quem nao e superadmin leva 403 — coordenador inclusive');
conf(!/req\.body[\s\S]{0,200}?perfil/.test(bloco), 'e o perfil NAO sai do corpo');
// ⚠️ TUDO OU NADA.
conf(/await cli\.query\('BEGIN'\)/.test(bloco), 'ha BEGIN');
conf((bloco.match(/ROLLBACK/g) || []).length >= 3, 'e ROLLBACK em cada saida de erro',
     (bloco.match(/ROLLBACK/g) || []).length);
conf(/await cli\.query\('COMMIT'\)/.test(bloco), 'e um COMMIT so, no fim');
const iBegin = bloco.indexOf("query('BEGIN')");
const iFoto = bloco.indexOf('transf.SQL_FOTO');
const iMover = bloco.indexOf('transf.SQL_MOVER');
const iConf = bloco.indexOf('transf.conferir');
const iCommit = bloco.indexOf("query('COMMIT')");
conf(iBegin < iFoto && iFoto < iMover, 'a foto e tirada DEPOIS do BEGIN e ANTES do UPDATE');
conf(iMover < iConf && iConf < iCommit, 'e as conferencias rodam depois do UPDATE e antes do COMMIT');
// ⚠️ O DESTINO TEM DE SER ANALISTA ATIVO, e "ativo" sao DUAS colunas: os sete dispensados
// continuam com ativo = true, entao deduzir a dispensa do ativo deixaria passar justamente
// as sete pessoas para quem nao se pode mandar PC.
conf(/uPara\.perfil !== 'analista'/.test(bloco), 'o destino tem de ser analista');
conf(/!uPara\.ativo \|\| uPara\.data_saida/.test(bloco), 'ativo E sem data_saida — as duas colunas');
conf(/trs_recusadas/.test(bloco), 'e a recusa por TR alheia devolve a lista');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
