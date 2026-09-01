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


S('17. A PORTARIA DO DESTINO, QUE DEFINE A VIGENCIA');
// ⚠️ SEM ELA O TERMO NAO SAI, e por isso a transferencia tambem nao — decisao do Richard em
// 01/09. A vigencia e o que o termo afirma ("a partir de tal data o analista assume"), e um
// termo sem vigencia nao diz de quando vale.
const rotaT = rota.slice(rota.indexOf("app.post('/transferencia',"), rota.indexOf("app.get('/transferencias'"));
conf(/FROM substituicao/.test(rotaT), 'a rota consulta a substituicao primeiro');
conf(/WHERE substituto_id = \$1/.test(rotaT), 'casando pelo analista de DESTINO');
conf(/falta: 'portaria_destino'/.test(rotaT), 'e recusa com 400 quando nao ha portaria');
conf(/status\(400\)[\s\S]{0,300}?Informe o número e a data/.test(rotaT),
     'dizendo que o numero e a data tem de ser informados');
// ⚠️ ARMADILHA 25: o `pg` devolve coluna `date` como objeto Date, e String(Date).slice(0,10)
// da "Fri Aug 21", nao "2026-08-21". Cai nela ao escrever esta rota, e a conversao passou a
// ser do POSTGRES.
conf(/data_publicacao::text/.test(rotaT), 'a data vem como TEXTO do Postgres');
conf(!/String\(subs\[0\]\.data_publicacao\)\.slice/.test(rota), 'e nao e um Date fatiado como texto');
conf((rota.match(/SELECT portaria, data_publicacao::text/g) || []).length === 2,
     'nas duas consultas — a do repasse e a do detalhe',
     (rota.match(/data_publicacao::text/g) || []).length);

S('18. A PORTARIA VIAJA COM O REPASSE');
// ⚠️ GRAVADA NO estado_anterior (jsonb): nenhuma coluna nova, nenhum ALTER. O termo tem de
// sair IGUAL na reemissao, anos depois, mesmo que a substituicao mude.
const pp = transf.paramsHistorico({
  movidas: movem.map((m) => ({ codigo_pc: m.codigo_pc, tr: m.tr, parcial_num: m.parcial_num })),
  foto: FOTO, deId: DE, paraId: PARA, deNome: 'Goreti', paraNome: 'Aline',
  usuarioId: 4, portaria: '203/2026', portariaEm: '2026-08-21',
});
const fotoP = JSON.parse(pp[9][0]);
conf(fotoP.portaria_destino === '203/2026', 'o numero entra na foto de cada PC', fotoP.portaria_destino);
conf(fotoP.portaria_destino_em === '2026-08-21', 'e a data tambem', fotoP.portaria_destino_em);
conf(/estado_anterior->>'portaria_destino'/.test(transf.SQL_DETALHE),
     'e o detalhe a devolve de volta');
// ⚠️ NAO FOI PARA A substituicao: as colunas de la se chamam dispensado_id e dispensado_nome,
// e gravar ali um repasse entre dois analistas EM ATIVIDADE afirmaria uma dispensa que nao
// houve. Dado errado no banco e pior que um campo a mais.
conf(!/INSERT INTO substituicao/.test(rota), 'e nenhuma rota INSERE em substituicao');

S('19. O NUMERO E A DATA ANDAM JUNTOS');
// ⚠️ Um numero sem data nao define vigencia nenhuma — deixaria o termo com meia frase.
conf(transf.validar({ de_id: 1, para_id: 2, trs: ['T'], usuario_id: 4, portaria: '203/2026' }) !== null,
     'numero sem data recusa');
conf(transf.validar({ de_id: 1, para_id: 2, trs: ['T'], usuario_id: 4, portaria_em: '2026-08-21' }) !== null,
     'data sem numero recusa');
conf(transf.validar({ de_id: 1, para_id: 2, trs: ['T'], usuario_id: 4,
                      portaria: '203/2026', portaria_em: '2026-08-21' }) === null, 'os dois juntos passam');
conf(transf.validar({ de_id: 1, para_id: 2, trs: ['T'], usuario_id: 4 }) === null,
     'e nenhum dos dois passa — a substituicao pode responder');

S('20. OS TEXTOS DOS AVISOS (01/09/2026)');
// ⚠️ OS QUATRO TEXTOS MORAM NA lib, e nao soltos na rota. Sao repasse e desfazer vezes
// analista e coordenacao, e os quatro dizem os MESMOS numeros: escritos em quatro lugares da
// server.js, divergiriam no primeiro ajuste.
{
  const a = transf.avisoDestino({ pcs: 32, trs: 5, deNome: 'Samoel', quando: '2026-08-28', vencidas: 0 });
  conf(a.titulo === 'Você recebeu 32 prestações em 5 TRs', 'o titulo do destino', a.titulo);
  conf(a.mensagem === 'Repassadas de Samoel em 28/08/2026. Já estão na sua planilha e podem ser analisadas.',
       'e o corpo, sem a frase do prazo', a.mensagem);

  // ⚠️ "N TEM PRAZO VENCIDO" SO SAI QUANDO HA — ordem do Richard. A frase com zero e ruido que
  // treina a pessoa a nao ler o resto do aviso, e o aviso do repasse e o que ela precisa ler
  // inteiro.
  const v = transf.avisoDestino({ pcs: 32, trs: 5, deNome: 'Samoel', quando: '2026-08-28', vencidas: 3 });
  conf(/3 têm prazo vencido\.$/.test(v.mensagem), 'com vencidas, a frase entra no fim', v.mensagem);
  conf(!/prazo vencido/.test(a.mensagem), 'e com zero ela NAO aparece');
  const v1 = transf.avisoDestino({ pcs: 1, trs: 1, deNome: 'Samoel', quando: '2026-08-28', vencidas: 1 });
  conf(v1.titulo === 'Você recebeu 1 prestação em 1 TR', 'o singular no titulo', v1.titulo);
  conf(/1 tem prazo vencido\./.test(v1.mensagem), 'e o singular na frase do prazo', v1.mensagem);

  const c = transf.avisoCoord({ pcs: 32, grupo: 3, deNome: 'Samoel', paraNome: 'Richard', quando: '2026-08-28' });
  conf(c.titulo === 'Repasse no Grupo 3', 'o titulo da coordenacao', c.titulo);
  conf(c.mensagem === '32 prestações de Samoel passaram para Richard em 28/08/2026.',
       'e o corpo dela', c.mensagem);

  // ⚠️ QUEM PERDEU AS PCs E O ANALISTA DE DESTINO DO REPASSE, nao o de origem: as PCs estavam
  // com ele ate o desfazer, e a origem nao tem mais nada a ver com aquele acervo.
  const df = transf.avisoDesfeitoAnalista({ pcs: 32, trs: 5, quando: '2026-09-01', quandoRepasse: '2026-08-28' });
  conf(df.titulo === '32 prestações voltaram ao estoque', 'o titulo do desfazer', df.titulo);
  conf(/repasse de 28\/08\/2026 foi desfeito em 01\/09\/2026/.test(df.mensagem),
       'e ele cita as DUAS datas — a do repasse e a do desfazer', df.mensagem);
  const dc = transf.avisoDesfeitoCoord({ pcs: 32, grupo: 3, paraNome: 'Richard', quando: '2026-09-01' });
  conf(dc.titulo === 'Repasse desfeito no Grupo 3', 'o titulo do desfazer para a coordenacao', dc.titulo);

  // ⚠️ NAO SE FATIA O TEXTO DE UM Date — armadilha 25, e a mesma pedra em que esta rota ja
  // tropecou: String(d).slice(0,10) da "Fri Aug 21", nao "2026-08-21".
  conf(transf.dataBr(new Date(2026, 7, 28)) === '28/08/2026', 'a data sai certa vinda de um Date',
       transf.dataBr(new Date(2026, 7, 28)));
  conf(transf.dataBr('2026-08-28T16:55:05.084Z') === '28/08/2026', 'e vinda de um ISO com hora',
       transf.dataBr('2026-08-28T16:55:05.084Z'));
  conf(transf.dataBr(null) === '', 'e o nulo nao vira "Invalid Date"');
}

S('21. OS AVISOS NA ROTA');
// ⚠️ DEPOIS DO COMMIT, NUNCA DENTRO DA TRANSACAO. Sob o mesmo cliente, o aviso morreria no
// ROLLBACK; sob o pool antes do COMMIT, o oposto — sobreviveria a um ROLLBACK e anunciaria um
// repasse que nao aconteceu.
conf(rotaT.indexOf("cli.query('COMMIT')") < rotaT.indexOf('notificarRepasse('),
     'o aviso do repasse vem DEPOIS do COMMIT');
conf(/notificarRepasse\(pool,/.test(rotaT), 'e grava pelo pool, fora da transacao');
conf(/\.catch\(/.test(rotaT.slice(rotaT.indexOf('notificarRepasse('))),
     'e o sino quebrado nao derruba o repasse ja gravado');
conf(rotaD.indexOf("cli.query('COMMIT')") < rotaD.indexOf('notificarDesfeito('),
     'e o do desfazer, idem');

// ⚠️ O ref_id SEPARA O REPASSE DO DESFAZER. O dedupe e destinatario+tipo+ref_id, e os dois
// eventos tem o mesmo tipo e o mesmo id de lote: um ref_id so faria o aviso do desfazer ser
// engolido como repeticao — e a pessoa nunca saberia que as TRs sairam da planilha dela.
conf(/ref_id: .repasse:\$\{a\.repasseId\}./.test(rota), 'o repasse marca ref_id repasse:N');
conf(/ref_id: .desfeito:\$\{a\.repasseId\}./.test(rota), 'e o desfazer, desfeito:N');
// ⚠️ urgente NAO E ENFEITE: e ele que poe o aviso no TOPO (o ORDER BY do notif.listar) e faz a
// tela desenhar a barra na borda esquerda. O destaque sai do mecanismo que ja existe.
conf((rota.match(/urgente: true/g) || []).length >= 2, 'os dois avisos nascem urgentes');
// TODOS os coordenadores, dos tres grupos — e nao a coordenadoresDoGrupo.
conf(/coordenadoresEmExercicio/.test(rota), 'a coordenacao inteira e avisada');
conf(/\.filter\(\(id\) => id !== a\.paraId\)/.test(rota),
     'e o destino sai da lista se ele mesmo for coordenador');
// O ref_tipo diz QUAL aviso e, e e por ele que a tela decide os botoes.
conf(/ref_tipo: 'repasse'/.test(rota) && /ref_tipo: 'repasse_coord'/.test(rota),
     'o ref_tipo separa o aviso do analista do da coordenacao');

// ⚠️ AS VENCIDAS SAO CONTADAS COM A MESMA REGRA DA BUSCA GLOBAL: CORTE_PRAZO e hoje em
// Brasilia. Um segundo criterio faria o aviso dizer um numero que nenhuma tela mostra.
conf(/CORTE_PRAZO/.test(rotaT) && /HOJE_BR/.test(rotaT),
     'as vencidas usam o CORTE_PRAZO e o HOJE_BR do lib/datas');
// ⚠️ O id do repasse vem do RETURNING do proprio INSERT, e nao de uma reconsulta: adivinhar
// pelo carimbo depois do COMMIT e justamente a colisao que o lib admite nao garantir.
conf(/idsHist = hRows\.map/.test(rotaT), 'o id do repasse vem do RETURNING do historico');
conf(/Math\.min\(\.\.\.idsHist\)/.test(rotaT), 'e e o MIN do lote, a mesma chave das rotas');

S('22. QUEM ABRE O REPASSE, E POR TABELA O TERMO');
// ⚠️ A GUARDA E UMA SO, e as DUAS rotas do termo entram por ela. Escrita nos dois lugares, uma
// ficaria para tras no primeiro ajuste — e a que ficasse seria a que deixa passar.
conf(/async function podeVerRepasse/.test(rota), 'a regra e uma funcao unica');
conf(/perfilEfetivo\(quem\) === 'superadmin'/.test(rota), 'superadmin sempre passa');
conf(/de\.id === quem\.id\) \|\| \(para && para\.id === quem\.id/.test(rota),
     'as DUAS pontas passam — origem e destino');
conf(/'coordenador' && !quem\.data_saida/.test(rota),
     'coordenador em exercicio passa, e o dispensado NAO');
conf(!/GET \/transferencias\/:id[\s\S]{0,400}Acesso restrito ao superadmin/.test(rota),
     'e a rota do detalhe deixou de ser so do superadmin');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
