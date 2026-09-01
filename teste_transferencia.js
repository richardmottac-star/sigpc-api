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


S('9. O REPASSE SE IDENTIFICA SEM COLUNA NOVA');
// ⚠️ O `criado_em` tem default `now()`, que no Postgres e o instante em que a TRANSACAO
// comecou — nao o de cada linha. Todas as linhas de um lote saem com o carimbo IDENTICO.
// Medido em 01/09: as 32 linhas do repasse do Samoel tem UM carimbo so, contra 324 linhas e
// 324 carimbos do `parecer`. Por isso a chave do grupo e (criado_em, evento, de, para).
conf(/GROUP BY criado_em, evento, valor_anterior, valor_novo/.test(transf.SQL_LISTA),
     'a lista agrupa pelo carimbo da transacao e pelas duas pontas');
conf(/MIN\(id\)::int\s+AS id/.test(transf.SQL_LISTA), 'e o id do repasse e o MIN(id) do lote');
conf(/ORDER BY criado_em DESC/.test(transf.SQL_LISTA), 'do mais recente para o mais antigo');
// ⚠️ OS DOIS EVENTOS ENTRAM: esconder o `transferencia_dispensa` faria a tela dizer que a
// primeira transferencia do sistema nunca aconteceu.
conf(transf.EVENTOS_REPASSE.includes('transferencia') &&
     transf.EVENTOS_REPASSE.includes('transferencia_dispensa'),
     'e os dois eventos de repasse entram na lista', transf.EVENTOS_REPASSE.join(', '));

S('10. O CARIMBO NAO VOLTA PELO JAVASCRIPT');
// ⚠️ DEFEITO REAL, pego em 01/09 contra o banco. A primeira versao lia a chave do lote, trazia
// o `criado_em` para o Node e o mandava de volta como parametro — e o detalhe voltava VAZIO.
// A coluna e `timestamp WITHOUT time zone`, e um `Date` do JS chega com fuso: a comparacao
// nunca casava. E a armadilha 18 noutra roupa, e NAO DAVA ERRO — devolvia zero linhas, que se
// le como "este repasse nao moveu nada".
conf(/WITH lote AS \(/.test(transf.SQL_DETALHE), 'o detalhe acha o lote DENTRO do SQL');
conf(/WHERE id = \$1/.test(transf.SQL_DETALHE), 'entrando pelo id');
conf(!/h\.criado_em = \$1/.test(transf.SQL_DETALHE), 'e nao por um criado_em vindo de fora');
conf(/WITH lote AS \(/.test(transf.SQL_MOV_POSTERIOR), 'a trava faz o mesmo');
conf(/h\.criado_em > l\.criado_em/.test(transf.SQL_MOV_POSTERIOR),
     'e compara os dois carimbos dentro do Postgres');

S('11. O DETALHE SAI DA FOTO, NAO DE UM JOIN PELO CODIGO');
// ⚠️ O `codigo_pc` esta no `estado_anterior` em 32/32 das linhas antigas. E a foto do que foi
// movido NAQUELE dia — se a PC mudou de mao de novo depois, o detalhe do repasse continua
// contando o que ELE fez, que e a pergunta.
conf(/estado_anterior->>'codigo_pc'/.test(transf.SQL_DETALHE), 'o codigo vem do estado_anterior');
conf(/LEFT JOIN prestacoes_contas/.test(transf.SQL_DETALHE),
     'e o LEFT JOIN so acrescenta o estado de AGORA — a PC apagada nao some do detalhe');

S('12. A TRAVA DO DESFAZER');
// ⚠️ PELA PARCELA, e nao pelo codigo_pc: o historico do parecer e gravado em (tr, parcial_num)
// porque a analise e por PARCIAL. Procurar por codigo_pc nao acharia o parecer que baixou
// aquela mesma PC — a trava passaria batido no evento mais comum.
conf(/\(h\.tr, COALESCE\(h\.parcial_num,''\)\) IN/.test(transf.SQL_MOV_POSTERIOR),
     'a trava casa por (tr, parcial_num)');
for (const e of ['parecer', 'ci', 'estorno', 'engenharia_envio', 'situacao']) {
  conf(transf.EVENTOS_TRAVA.includes(e), `'${e}' trava o desfazer`);
}
conf(!transf.EVENTOS_TRAVA.includes('transferencia'),
     'e o proprio repasse NAO se conta como movimentacao posterior');

S('13. O DESFAZER MANDA PARA O ESTOQUE');
const dsf = transf.paramsDesfeita({
  linhas: [{ tr: 'T1', parcial_num: '1', codigo_pc: 'PC1', analista_atual: 7, repasse_id: 9 }],
  lote: { criado_em: new Date('2026-08-28T16:55:05Z'), valor_anterior: '48 · Samoel', valor_novo: '4 · Richard' },
  usuarioId: 4, motivo: 'Teste.',
});
conf(dsf[3][0] === 'transferencia_desfeita', "o evento e 'transferencia_desfeita'", dsf[3][0]);
// ⚠️ AS PONTAS INVERTEM: o valor_anterior do desfazer e o valor_novo do repasse, e o destino e
// o ESTOQUE. Repetir as pontas do repasse faria a trilha ler ao contrario.
conf(dsf[4][0] === '4 · Richard', 'valor_anterior e quem TINHA a PC', dsf[4][0]);
conf(dsf[5][0] === '— · estoque', 'e valor_novo e o estoque', dsf[5][0]);
conf(dsf[6][0] === null, 'o analista_id fica NULO — a PC nao tem dono');
conf(dsf[8][0] === 4, 'executado_por preenchido');
const fotoD = JSON.parse(dsf[9][0]);
conf(fotoD.veio_de === '48 · Samoel' && fotoD.repasse_id === 9,
     'e a foto guarda de quem veio e de qual repasse — e o que a pilula do Estoque le',
     JSON.stringify(fotoD));

S('14. "LIVRE" TEM UMA DEFINICAO SO');
// ⚠️ Em 16/08 havia duas, e 87 PCs caiam no vao entre elas. Quem devolve ao estoque e a
// devol.SQL_DEVOLVER, a mesma da devolucao do superadmin.
// ⚠️ O RECORTE TERMINA NO BANNER SEGUINTE, e nao no fim do arquivo: sem o limite a fatia
// levava as rotas de baixo junto, e a checagem do "segundo SET status=livre" reprovava por
// causa da devolucao normal, que fica adiante. Foi um defeito deste teste, nao da rota.
const rotaD = rota.slice(rota.indexOf("app.post('/transferencias/:id/desfazer'"),
                         rota.indexOf('//  BUSCA GLOBAL'));
conf(/devol\.SQL_DEVOLVER/.test(rotaD), 'o desfazer usa a devol.SQL_DEVOLVER');
conf(!/status = 'livre'/.test(rotaD), 'e nao escreve um segundo SET status=livre');
conf(/status\(409\)/.test(rotaD) && /pcs_impedidas/.test(rotaD),
     'a recusa por movimentacao posterior devolve a lista de quais');
conf(/await cli\.query\('BEGIN'\)/.test(rotaD) && /await cli\.query\('COMMIT'\)/.test(rotaD),
     'tudo ou nada, numa transacao so');
conf((rotaD.match(/ROLLBACK/g) || []).length >= 4, 'com ROLLBACK em cada saida',
     (rotaD.match(/ROLLBACK/g) || []).length);
conf(/perfilEfetivo\(u\[0\]\) !== 'superadmin'/.test(rotaD), 'e so o superadmin desfaz');

S('15. O TERMO SO EXISTE PARA O EVENTO NOVO');
// ⚠️ Os 32 registros de 28/08 vieram de um script que nao gerou termo nenhum. Inventar um
// documento para um repasse que nao teve seria produzir papel com data retroativa.
const rotaL = rota.slice(rota.indexOf("app.get('/transferencias'"), rota.indexOf("app.get('/transferencias/:id'"));
conf(/tem_termo: r\.evento === transf\.EVENTO/.test(rotaL),
     'a lista marca tem_termo so no evento novo');
conf(/executado_por_nome/.test(rotaL), 'e devolve o nome de quem executou');
// ⚠️ UMA CONSULTA SO para os nomes: um SELECT por linha viraria N+1 sem ninguem perceber.
conf(/WHERE id = ANY\(\$1::int\[\]\)/.test(rotaL), 'por UMA consulta, nao uma por linha');

S('16. A ROTA DAS DEVOLVIDAS, PARA A PILULA DO ESTOQUE');
// ⚠️ ROTA DE NOME FIXO ANTES DA ROTA COM :id — armadilha 13. Declarada depois,
// /transferencias/devolvidas cairia em /transferencias/:id com id "devolvidas" e
// devolveria 404 em producao. Ja aconteceu com /usuarios/pendentes.
conf(rota.indexOf("app.get('/transferencias/devolvidas'") < rota.indexOf("app.get('/transferencias/:id'"),
     'a rota de nome fixo vem ANTES da rota com :id');
// ⚠️ A MARCA E DERIVADA, NAO GRAVADA: nao ha coluna veio_de_dispensado, e nao pode haver —
// ela mudaria sozinha a cada desfazer e ficaria mentindo ate alguem rodar um script.
const rotaDev = rota.slice(rota.indexOf("app.get('/transferencias/devolvidas'"), rota.indexOf("app.get('/transferencias/:id'"));
conf(/transf.EVENTO_DESFEITA/.test(rotaDev), 'ela le o historico do desfazer');
// ⚠️ E NADA DE COLUNA NOVA EM prestacoes_contas para esta frente: a marca sai do historico.
conf(!/ALTER TABLE prestacoes_contas[sS]{0,120}(veio_de|devolvida)/.test(rota),
     'e nenhuma coluna de "veio de dispensado" foi criada');
// ⚠️ SO VALE ENQUANTO A TR CONTINUAR NO ESTOQUE: se alguem ja assumiu de volta, a pilula
// mentiria — a TR tem dono e nao esta livre.
conf(/analista_id IS NULL/.test(rotaDev), 'e so devolve TR que continua sem dono');
conf(/portaria/.test(rotaDev), 'trazendo a portaria de quem saiu, para o balao');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
