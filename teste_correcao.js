// CAMINHO: sigpc-api/teste_correcao.js
//
// AS QUATRO FRENTES DE 18/08/2026, testadas por unidade:
//   A) lib/correcao.js            corrigir situação  ·  B) puxar do C.I.
//   C) lib/pc-nova.js             cadastrar PC
//   D) lib/solicitacao-correcao.js  pedir correção ao coordenador
//
// ⚠️ SÓ DUBLÊ, NENHUM BANCO. As rotas gerenciam a própria transação, e a armadilha 11 do
// CLAUDE.md é explícita: testar contra o banco real uma função que dá o próprio COMMIT
// confirma a transação externa e o ROLLBACK do teste não tem mais o que desfazer. Em 12/08
// isso gravou 7 PCs e 14 mensagens em produção num teste que parecia isolado.
//
//   node teste_correcao.js

const correcao = require('./lib/correcao');
const pcNova = require('./lib/pc-nova');
const solCor = require('./lib/solicitacao-correcao');
const fs = require('fs');

let ok = 0, falhou = 0;
const T = (nome, cond, extra) => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

// ── dublês ───────────────────────────────────────────────────────────────────
const PC = (over = {}) => ({
  codigo_pc: '2021PC000001', tr: '2021TR000001', parcial_num: '1', setorial_id: 'FCEE',
  tipo: 'parcial', baixada: true, status: 'baixada', situacao_atual: null,
  origem_baixa: 'sistema', baixado_por: 10, analista_id: 10,
  enviado_ci: false, enviado_ci_por: null, ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
S('1. A — QUEM CORRIGE A BAIXA SOZINHO');

T('a baixa foi DELE — corrige',
  correcao.podeCorrigirBaixa('analista', 10, PC({ baixado_por: 10 })).pode === true);
T('a baixa foi de OUTRO — NAO corrige',
  correcao.podeCorrigirBaixa('analista', 99, PC({ baixado_por: 10 })).pode === false);
T('e o caminho dela e a solicitacao',
  correcao.podeCorrigirBaixa('analista', 99, PC({ baixado_por: 10 })).viaSolicitacao === true);
T('sem autoria registrada (NULL) — corrige',
  correcao.podeCorrigirBaixa('analista', 99, PC({ baixado_por: null })).pode === true);
T('baixa da RECARGA — corrige mesmo com autor de outro',
  correcao.podeCorrigirBaixa('analista', 99,
    PC({ baixado_por: 10, origem_baixa: correcao.ORIGEM_RECARGA })).pode === true);
T('a constante da recarga e a string exata da regra',
  correcao.ORIGEM_RECARGA === 'recarga_parcial_20260805');
T('o TECNICO corrige qualquer uma',
  correcao.podeCorrigirBaixa('superadmin', 4, PC({ baixado_por: 10 })).pode === true);
T('e o tecnico NAO cai na solicitacao',
  correcao.podeCorrigirBaixa('superadmin', 4, PC({ baixado_por: 10 })).viaSolicitacao === false);

// ⚠️ O superadmin NO PAPEL ANALISTA e' analista aqui tambem — e' o perfilEfetivo que chega.
T('superadmin no papel analista NAO passa pela porta do tecnico',
  correcao.podeCorrigirBaixa('analista', 4, PC({ baixado_por: 10 })).pode === false);
T('id como texto e o mesmo id',
  correcao.podeCorrigirBaixa('analista', '10', PC({ baixado_por: 10 })).pode === true);

// ═════════════════════════════════════════════════════════════════════════════
S('2. B — QUEM PUXA DE VOLTA DO C.I.');

const NOCI = (o = {}) => PC({ enviado_ci: true, enviado_ci_por: 10, ci_situacao: 'na_fila', ...o });

T('o encaminhamento foi DELE — puxa',
  correcao.podePuxarCi('analista', 10, NOCI()).pode === true);
T('foi de OUTRO — NAO puxa',
  correcao.podePuxarCi('analista', 99, NOCI()).pode === false);
T('e vira solicitacao',
  correcao.podePuxarCi('analista', 99, NOCI()).viaSolicitacao === true);
T('sem autoria registrada — puxa (1.745 das 2.671 estao assim)',
  correcao.podePuxarCi('analista', 99, NOCI({ enviado_ci_por: null })).pode === true);
T('PC que NAO esta no C.I. — recusa',
  correcao.podePuxarCi('analista', 10, PC({ enviado_ci: false })).pode === false);
T('e essa recusa NAO e solicitacao — nao ha o que pedir',
  correcao.podePuxarCi('analista', 10, PC({ enviado_ci: false })).viaSolicitacao === false);
T('o tecnico puxa qualquer uma',
  correcao.podePuxarCi('superadmin', 4, NOCI()).pode === true);

// ═════════════════════════════════════════════════════════════════════════════
S('3. O ALCANCE — E A FINAL QUE ANDA SOZINHA');

const irmas = [
  { codigo_pc: 'A1', tipo: 'parcial' }, { codigo_pc: 'A2', tipo: 'parcial' },
  { codigo_pc: 'TR-PFINAL', tipo: 'final' },
];
T('a parcial leva as irmas parciais',
  JSON.stringify(correcao.alvoDaAcao(PC({ codigo_pc: 'A1' }), irmas)) === JSON.stringify(['A1', 'A2']));
T('e EXCLUI a final que divide o mesmo parcial_num',
  !correcao.alvoDaAcao(PC({ codigo_pc: 'A1' }), irmas).includes('TR-PFINAL'));
T('a FINAL anda sozinha',
  JSON.stringify(correcao.alvoDaAcao(PC({ codigo_pc: 'TR-PFINAL', tipo: 'final' }), irmas))
    === JSON.stringify(['TR-PFINAL']));
T('final sozinha mesmo com parcial_num = 1 (os 5 casos do banco)',
  correcao.alvoDaAcao(PC({ codigo_pc: 'X-PFINAL', tipo: 'final', parcial_num: '1' }), irmas).length === 1);
T('sem PC, alcance vazio', correcao.alvoDaAcao(null, irmas).length === 0);

// ═════════════════════════════════════════════════════════════════════════════
S('4. MOTIVO E DESTINO');

T('motivo vazio recusa', !!correcao.validarMotivo(''));
T('motivo curto recusa', !!correcao.validarMotivo('abc'));
T('motivo bom passa', correcao.validarMotivo('baixei a parcial errada') === null);
T('motivo gigante recusa', !!correcao.validarMotivo('x'.repeat(correcao.MOTIVO_MAX + 1)));
T('destino fora da lista recusa', !!correcao.validarDestino('Baixada'));
T('destino valido passa', correcao.validarDestino('Diligência') === null);
T('Livre e destino valido', correcao.validarDestino('Livre') === null);
T('todo destino tem status legado',
  correcao.DESTINOS.every(d => !!correcao.DESTINO_PARA_STATUS[d]));
T('Aguardando documentacao cai em analise, como no server',
  correcao.DESTINO_PARA_STATUS['Aguardando documentação'] === 'analise');

// ═════════════════════════════════════════════════════════════════════════════
S('5. SAIR DA PRODUTIVIDADE MEXE NAS QUATRO COLUNAS');

const SQL = correcao.SQL_TIRAR_DA_PRODUTIVIDADE;
// As tres contagens de produtividade nao concordam: a rota le data_baixa+estornada, a tela
// le status. Faltar UMA destas deixa a PC contando em algum lugar.
T('zera baixada', /baixada\s*=\s*false/.test(SQL));
T('muda status', /status\s*=\s*\$2/.test(SQL));
T('marca estornada', /estornada\s*=\s*true/.test(SQL));
T('carimba data_estorno', /data_estorno\s*=\s*NOW\(\)/.test(SQL));
T('PRESERVA data_baixa — a produtividade cumulativa le ela', !/data_baixa\s*=/.test(SQL));
T('limpa parecer_tipo — senao o pPasso leria passo 2', /parecer_tipo\s*=\s*NULL/.test(SQL));
T('limpa baixado_por — a baixa deixou de existir', /baixado_por\s*=\s*NULL/.test(SQL));
T('a chave e codigo_pc = ANY', /codigo_pc\s*=\s*ANY\(\$1\)/.test(SQL));
// ⚠️ So' o WHERE: o `parcial_num` do RETURNING e' proposital — `registrarHistorico` e'
// chaveado por (tr, parcial_num) e precisa dele. O que nao pode e' FILTRAR por ele.
const soWhere = (s) => s.slice(s.indexOf('WHERE'), s.indexOf('RETURNING'));
T('e NAO usa parcial_num como chave', !/parcial_num/.test(soWhere(SQL)));
T('nem o puxar do C.I.', !/parcial_num/.test(soWhere(correcao.SQL_PUXAR_CI)));
T('nem o so-situacao', !/parcial_num/.test(soWhere(correcao.SQL_SO_SITUACAO)));

T('so-situacao NAO marca estorno em PC nunca baixada',
  !/estornada/.test(correcao.SQL_SO_SITUACAO));
T('e so alcanca o que esta aberto',
  /baixada\s*=\s*false/.test(correcao.SQL_SO_SITUACAO));

const PUX = correcao.SQL_PUXAR_CI;
T('puxar limpa enviado_ci', /enviado_ci\s*=\s*false/.test(PUX));
T('puxar limpa dt_envio_ci', /dt_envio_ci\s*=\s*NULL/.test(PUX));
T('puxar zera ci_rodada — senao a proxima ida comeca na rodada 2', /ci_rodada\s*=\s*0/.test(PUX));
T('puxar limpa ci_situacao', /ci_situacao\s*=\s*NULL/.test(PUX));
T('puxar TIRA da produtividade', /estornada\s*=\s*true/.test(PUX) && /baixada\s*=\s*false/.test(PUX));
T('puxar so alcanca quem esta no C.I.', /enviado_ci\s*=\s*true/.test(PUX));

// ═════════════════════════════════════════════════════════════════════════════
S('6. C — CADASTRAR PC: A FINAL E PREENCHIDA PELO SERVIDOR');

const fin = pcNova.montar({ tipo: 'final' }, '2021TR000123').linha;
T('sufixo -PFINAL', fin.codigo_pc === '2021TR000123-PFINAL');
T('parcela_seq 999', fin.parcela_seq === 999);
T('codigo_nl NULA', fin.codigo_nl === null);
T('valor ZERO', fin.valor === 0);
T('tipo final', fin.tipo === 'final');
T("parcial_num 'FINAL'", fin.parcial_num === 'FINAL');
T('o que a tela mandar nesses campos e IGNORADO',
  pcNova.montar({ tipo: 'final', codigo_pc: 'INVENTADO', valor: 999, codigo_nl: '2021NL1',
                  parcela_seq: 3 }, '2021TR000123').linha.codigo_pc === '2021TR000123-PFINAL');
T('e o valor continua zero mesmo se mandarem outro',
  pcNova.montar({ tipo: 'final', valor: 5000 }, '2021TR000123').linha.valor === 0);
T('a TR entra em maiuscula', pcNova.codigoFinal(' 2021tr000123 ') === '2021TR000123-PFINAL');
T('sem TR, sem codigo', pcNova.codigoFinal('') === null);
T('prazo da final e 90 dias', pcNova.PRAZO_FINAL_DIAS === 90);

S('6b. C — A PARCIAL');
T('parcial sem codigo recusa', !!pcNova.montar({ tipo: 'parcial', parcial_num: '2' }, 'TR').erro);
T('parcial sem numero recusa', !!pcNova.montar({ tipo: 'parcial', codigo_pc: 'X' }, 'TR').erro);
T('parcial com sufixo -PFINAL RECUSA',
  !!pcNova.montar({ tipo: 'parcial', codigo_pc: '2021TR1-PFINAL', parcial_num: '2' }, 'TR').erro);
T("parcial com numero 'FINAL' recusa",
  !!pcNova.montar({ tipo: 'parcial', codigo_pc: 'X', parcial_num: 'FINAL' }, 'TR').erro);
T('parcial boa passa',
  pcNova.montar({ tipo: 'parcial', codigo_pc: '2021pc9', parcial_num: '2', valor: 10 }, 'tr1').linha
    .codigo_pc === '2021PC9');
T('valor negativo recusa',
  !!pcNova.montar({ tipo: 'parcial', codigo_pc: 'X', parcial_num: '2', valor: -1 }, 'TR').erro);
T('parcela_seq fica NULO quando nao informado — nao e a ordem do SIGEF',
  pcNova.montar({ tipo: 'parcial', codigo_pc: 'X', parcial_num: '2' }, 'TR').linha.parcela_seq === null);
T('tipo invalido recusa', !!pcNova.montar({ tipo: 'complementar' }, 'TR').erro);
T('sem TR recusa', !!pcNova.montar({ tipo: 'parcial', codigo_pc: 'X', parcial_num: '1' }, '').erro);

S('6c. C — QUEM CADASTRA');
const acervo = [{ codigo_pc: 'A', analista_id: 10 }, { codigo_pc: 'B', analista_id: 10 }];
T('o dono da TR cadastra', pcNova.podeCadastrar('analista', 10, acervo).pode === true);
T('quem nao e dono NAO cadastra', pcNova.podeCadastrar('analista', 99, acervo).pode === false);
T('TR inexistente recusa — TR nasce no SIGEF', pcNova.podeCadastrar('analista', 10, []).pode === false);
T('o tecnico cadastra em qualquer TR', pcNova.podeCadastrar('superadmin', 4, []).pode === true);
T('a PC nova nasce COM dono e grupo — senao cai em "livre" no Estoque',
  /analista_id/.test(pcNova.SQL_INSERIR) && /grupo/.test(pcNova.SQL_INSERIR));
T('e nasce status livre, nao baixada',
  /'livre'/.test(pcNova.SQL_INSERIR) && /false/.test(pcNova.SQL_INSERIR));

// ═════════════════════════════════════════════════════════════════════════════
S('7. D — O PEDIDO AO COORDENADOR');

const bom = { codigo_pc: 'X', analista_id: 10, acao: 'puxar_ci', motivo: 'encaminhei errado' };
T('pedido bom passa', solCor.validarPedido(bom) === null);
T('sem codigo_pc recusa', !!solCor.validarPedido({ ...bom, codigo_pc: '' }));
T('acao invalida recusa', !!solCor.validarPedido({ ...bom, acao: 'apagar' }));
T('motivo curto recusa', !!solCor.validarPedido({ ...bom, motivo: 'x' }));
T('corrigir_situacao SEM destino recusa',
  !!solCor.validarPedido({ ...bom, acao: 'corrigir_situacao' }));
T('corrigir_situacao COM destino passa',
  solCor.validarPedido({ ...bom, acao: 'corrigir_situacao', situacao_destino: 'Em análise' }) === null);
T('decisao sem motivo recusa', !!solCor.validarDecisao({ status: 'aprovada' }));
T('decisao com status invalido recusa',
  !!solCor.validarDecisao({ status: 'talvez', motivo_decisao: 'porque sim mesmo' }));
T('decisao boa passa',
  solCor.validarDecisao({ status: 'negada', motivo_decisao: 'a baixa esta correta' }) === null);

S('7b. D — QUEM DECIDE');
const pedido = { analista_id: 10, analista_grupo: '3' };
T('coordenador do MESMO grupo decide',
  solCor.podeDecidir({ id: 56, perfil: 'coordenador', grupo: '3' }, pedido, 'coordenador') === true);
T('coordenador de OUTRO grupo NAO decide',
  solCor.podeDecidir({ id: 5, perfil: 'coordenador', grupo: '1' }, pedido, 'coordenador') === false);
T('o solicitante NAO decide o proprio',
  solCor.podeDecidir({ id: 10, perfil: 'coordenador', grupo: '3' }, pedido, 'coordenador') === false);
T('o superadmin decide o proprio — nao ha ninguem acima',
  solCor.podeDecidir({ id: 10, perfil: 'superadmin' }, { ...pedido, analista_id: 10 }, 'superadmin') === true);
T('analista comum nao decide nada',
  solCor.podeDecidir({ id: 99, perfil: 'analista', grupo: '3' }, pedido, 'analista') === false);
T('coordenador SEM grupo nao decide',
  solCor.podeDecidir({ id: 7, perfil: 'coordenador', grupo: '' }, { ...pedido, analista_grupo: '' }, 'coordenador') === false);
T('superadmin no papel analista NAO decide o dos outros',
  solCor.podeDecidir({ id: 4, perfil: 'superadmin' }, pedido, 'analista') === false);
T('autodecidido sai de decidido_por = analista_id',
  solCor.autodecidido({ analista_id: 10, decidido_por: 10 }) === true);
T('e e falso quando sao pessoas diferentes',
  solCor.autodecidido({ analista_id: 10, decidido_por: 56 }) === false);
T('pendente nao e autodecidido', solCor.autodecidido({ analista_id: 10, decidido_por: null }) === false);

// ═════════════════════════════════════════════════════════════════════════════
S('8. O QUE O SERVIDOR FAZ COM ISSO');

const srv = fs.readFileSync('./server.js', 'utf8');
T('as tres libs entram no server',
  /require\('\.\/lib\/correcao'\)/.test(srv) && /require\('\.\/lib\/pc-nova'\)/.test(srv)
  && /require\('\.\/lib\/solicitacao-correcao'\)/.test(srv));
T('a rota de corrigir situacao existe', /app\.post\('\/parcela\/corrigir_situacao'/.test(srv));
T('a rota de puxar do C.I. existe', /app\.post\('\/parcela\/puxar_ci'/.test(srv));
T('a rota de cadastrar PC existe', /app\.post\('\/prestacoes_contas\/nova'/.test(srv));
T('as tres rotas do pedido existem',
  /app\.post\('\/solicitacao_correcao'/.test(srv) && /app\.get\('\/solicitacao_correcao'/.test(srv)
  && /app\.patch\('\/solicitacao_correcao\/:id'/.test(srv));
T('a rota que diz o que pode existe', /app\.get\('\/parcela\/acoes'/.test(srv));

// ⚠️ Armadilha 13: rota de nome fixo ANTES da rota com :id. `/prestacoes_contas/nova` tem de
// vir antes de `PATCH /prestacoes_contas/:codigo_pc`? Nao — sao metodos diferentes (POST x
// PATCH), e o Express casa por metodo. Mas `/parcela/acoes` e GET, e nao ha `/parcela/:x`.
T('nao existe GET /parcela/:algo que engula /parcela/acoes',
  !/app\.get\('\/parcela\/:[a-z]/.test(srv));

// As quatro frentes gravam trilha — a auditoria da CGE depende disso.
for (const ev of ['correcao_situacao', 'puxar_ci', 'pc_nova', 'solicitacao_correcao', 'correcao_negada'])
  T(`grava evento '${ev}' em parcela_historico`, new RegExp(`evento: '${ev}'`).test(srv));

T('a decisao aprovada usa as MESMAS funcoes da rota direta',
  /aplicarPuxarCi\(cli, alvo/.test(srv) && /aplicarCorrecaoSituacao\(cli, alvo/.test(srv));
T('a permissao e conferida DENTRO da transacao, com a linha travada',
  srv.indexOf('carregarAlvoCorrecao(cli, b.codigo_pc)') < srv.indexOf('correcao.podeCorrigirBaixa(pe, quem.id, alvo.pc)'));
T('o perfil vem do BANCO pelo perfilEfetivo, nunca do corpo',
  !/req\.body\.perfil/.test(srv.slice(srv.indexOf('CORRIGIR SITUAÇÃO'))));

// ═════════════════════════════════════════════════════════════════════════════
S('9. AS COLUNAS DE AUTORIA SAO PREENCHIDAS — nao so lidas');

// ⚠️ ESTA SECAO EXISTE POR UM DEFEITO REAL. A migracao de 18/08/2026 criou `baixado_por` e
// `enviado_ci_por` e fez o backfill (234 baixas, 926 encaminhamentos), mas NENHUMA rota as
// gravava. Toda baixa nova nascia com autor NULO, caia no caso 3 da regra ("sem autoria
// registrada") e liberava QUALQUER analista a corrigir a baixa de QUALQUER outro — o oposto
// exato do que as colunas existem para fazer. Passou pelas 1.059 checagens porque todas
// mediam a LEITURA da regra, e nenhuma media a escrita.
T('existe um so lugar que decide QUEM CLICOU', /function executorDe\(b\)/.test(srv));
T('e ele prefere o executor ao dono', /b\?\._autoria\?\.executado_por \?\? /.test(srv));

// As QUATRO rotas que criam baixa ou encaminhamento.
T('POST /parcela/parecer grava baixado_por', /baixado_por = \$7/.test(srv));
T('registrar_parecer grava baixado_por', /baixado_por = \$5::int/.test(srv));
T('POST /parcela/ci grava enviado_ci_por', /enviado_ci_por = \$5/.test(srv));
T('POST /parcela/ci_lote grava enviado_ci_por', /enviado_ci_por = \$4/.test(srv));
T('as quatro passam pelo executorDe',
  (srv.match(/executorDe\(b\)/g) || []).length >= 4,
  `${(srv.match(/executorDe\(b\)/g) || []).length} usos`);

// ⚠️ E OS DOIS ESTORNOS LIMPAM. PC nao baixada carregando `baixado_por` afirma a autoria de
// algo que nao existe, e a migracao tem conferencia exata para isso.
T('os dois estornos limpam baixado_por',
  (srv.match(/baixado_por = NULL/g) || []).length >= 2,
  `${(srv.match(/baixado_por = NULL/g) || []).length} ocorrencias`);
T('e a correcao de situacao tambem', /baixado_por    = NULL/.test(
  require('fs').readFileSync('./lib/correcao.js', 'utf8')));

// ⚠️ O CRITERIO AQUI E DIFERENTE DO parcela_historico.executado_por, e isso e proposital:
// la nulo quer dizer "foi o proprio dono"; aqui nulo quer dizer "sem autoria registrada".
// Confundir os dois faria toda baixa normal nascer sem dono conhecido.
T('o porque da diferenca esta escrito', /NÃO É O MESMO CRITÉRIO DO/.test(srv));

// ⚠️ A ROTA MORTA NAO PODE VOLTAR. `PATCH /prestacoes_contas/baixar` foi removida em
// 18/08/2026: era o TERCEIRO caminho de baixa, sem transacao, sem historico, sem
// `AND baixada = false` e sem gravar `baixado_por` — o unico que continuaria criando baixa
// sem autoria depois de as outras quatro passarem a grava-la. Ressuscita-la reabre o buraco
// que a secao 9 inteira existe para fechar.
T('a rota morta /prestacoes_contas/baixar continua removida',
  !/app\.patch\('\/prestacoes_contas\/baixar'/.test(srv));
T('e ficou escrito por que ela saiu', /FOI REMOVIDA em 18\/08\/2026, e não comentada/.test(srv));

// ⚠️ Armadilha 13: rota de nome fixo ANTES da rota com :param. Removida a /baixar, sobra a
// /estornar — e ela nao pode escorregar para depois da /:codigo_pc.
T('/estornar continua declarada ANTES de /:codigo_pc',
  srv.indexOf("app.patch('/prestacoes_contas/estornar'") <
  srv.indexOf("app.patch('/prestacoes_contas/:codigo_pc'"));

// ═════════════════════════════════════════════════════════════════════════════
S('10. O BURACO DO PUXAR_CI — a PC que o C.I. JA TOCOU  (26/08/2026)');

// ⚠️ O QUE ESTA SECAO EXISTE PARA IMPEDIR.
//
// `SQL_PUXAR_CI` derruba `baixada`, `enviado_ci` e `parecer_tipo`, marca `estornada` e TIRA
// a PC da produtividade. O `WHERE` dele era so `enviado_ci = true` — e as 1.737 PCs que o
// C.I. ja encerrou tem `enviado_ci = true` e `enviado_ci_por` NULO (vieram da carga de
// 16/08). O caso 3 de `podePuxarCi` ("sem autoria registrada o analista passa") deixava a
// PROPRIA analista apagar a produtividade de um trabalho que o C.I. ja aprovou. Nenhum erro
// na tela, nenhum erro no log.
//
// Medido em 26/08 no acervo inteiro: `enviado_ci = true` ⟺ `ci_situacao IS NOT NULL`, em
// 14.658 de 14.658 linhas (11.527 nulas · 1.392 na_fila · 2 com_analista · 1.737 encerrado).
// Logo bloquear por `ci_situacao` nao muda NADA para PC que nunca foi encaminhada.

const ENC = (o = {}) => PC({ enviado_ci: true, enviado_ci_por: null, ci_situacao: 'encerrado', ...o });
const DEV = (o = {}) => PC({ enviado_ci: true, enviado_ci_por: 10, ci_situacao: 'com_analista', ...o });

T('o C.I. ja se manifestou: encerrado', correcao.ciJaSeManifestou(ENC()) === true);
T('o C.I. ja se manifestou: com_analista', correcao.ciJaSeManifestou(DEV()) === true);
T('na_fila NAO e manifestacao — o C.I. ainda nao olhou',
  correcao.ciJaSeManifestou(NOCI()) === false);
T('e ci_situacao nula tambem nao', correcao.ciJaSeManifestou(PC({ enviado_ci: false })) === false);
T('sem PC nenhuma, nao inventa manifestacao', correcao.ciJaSeManifestou(null) === false);

T('ENCERRADA: a analista NAO puxa, mesmo sem autoria registrada',
  correcao.podePuxarCi('analista', 10, ENC()).pode === false);
T('e essa recusa NAO vira pedido ao coordenador — nao ha o que aprovar',
  correcao.podePuxarCi('analista', 10, ENC()).viaSolicitacao === false);
T('DEVOLVIDA pelo C.I.: tambem nao puxa',
  correcao.podePuxarCi('analista', 10, DEV()).pode === false);
// ⚠️ A CONFERENCIA VEM ANTES DO SUPERADMIN, e e o ponto da correcao. Ele e isento em todo o
// resto do sistema; aqui a isencao o deixaria apagar a produtividade de uma analista por um
// caminho que existe para consertar engano de encaminhamento.
T('NEM O TECNICO DO SISTEMA puxa uma encerrada',
  correcao.podePuxarCi('superadmin', 4, ENC()).pode === false);
T('nem uma devolvida', correcao.podePuxarCi('superadmin', 4, DEV()).pode === false);
T('a recusa da encerrada aponta para a porta certa',
  /Reabrir no C\.I\./.test(correcao.podePuxarCi('analista', 10, ENC()).motivo));

// ⚠️ O QUE NAO PODE TER MUDADO: a acao existe para desfazer engano de encaminhamento, e
// esse caso e `na_fila`. Se ele quebrar, a correcao curou o paciente matando-o.
T('na_fila: quem encaminhou CONTINUA puxando',
  correcao.podePuxarCi('analista', 10, NOCI()).pode === true);
T('na_fila sem autoria: a analista CONTINUA puxando',
  correcao.podePuxarCi('analista', 99, NOCI({ enviado_ci_por: null })).pode === true);
T('na_fila de outro: continua virando solicitacao',
  correcao.podePuxarCi('analista', 99, NOCI()).viaSolicitacao === true);
T('e o tecnico continua puxando na_fila', correcao.podePuxarCi('superadmin', 4, NOCI()).pode === true);
T('PC fora do C.I.: a recusa continua sendo a de sempre',
  /não está no Controle Interno/.test(correcao.podePuxarCi('analista', 10, PC({ enviado_ci: false })).motivo));

// A segunda tranca: o WHERE do banco, para o caminho novo que esquecer de perguntar.
const wPux = correcao.SQL_PUXAR_CI.slice(correcao.SQL_PUXAR_CI.indexOf('WHERE'),
                                         correcao.SQL_PUXAR_CI.indexOf('RETURNING'));
T('o WHERE do UPDATE tambem barra quem o C.I. tocou',
  /ci_situacao IS NULL OR ci_situacao = 'na_fila'/.test(wPux));
T('e continua exigindo enviado_ci = true', /enviado_ci = true/.test(wPux));
// ⚠️ `IS NULL OR = 'na_fila'`, e nao `= 'na_fila'` seco: uma PC encaminhada com ci_situacao
// nula e uma PC que o C.I. NAO tocou. Hoje nao existe nenhuma; recusa-la seria mudar o
// comportamento de um caso que este ciclo nao veio mudar.
T('a PC encaminhada sem ci_situacao continua alcancada — nao e caso deste ciclo',
  /ci_situacao IS NULL/.test(wPux));

// E a aprovacao do coordenador reconfere AGORA, nao no instante do pedido.
T('a aprovacao do pedido reconfere se o C.I. se manifestou no meio do caminho',
  /p\.acao === 'puxar_ci' && correcao\.ciJaSeManifestou\(alvo\.pc\)/.test(srv));
T('e usa a MESMA funcao de podePuxarCi — duas copias divergiriam',
  (srv.match(/correcao\.ciJaSeManifestou/g) || []).length >= 1);
T('a reabertura e oferecida como a saida certa para a encerrada',
  /POST \/ci\/reabrir/.test(fs.readFileSync('./lib/correcao.js', 'utf8')));

// ═════════════════════════════════════════════════════════════════════════════
S('9. A FOTO DO ESTADO ANTERIOR, E O DESFAZER DA PUXADA (26/08/2026)');

const corr = fs.readFileSync('./lib/correcao.js', 'utf8');

// ── a foto: o que ela cobre ──────────────────────────────────────────────────
// As colunas que o SQL_PUXAR_CI escreve, lidas do proprio SQL. O teste nao repete a lista a
// mao: uma coluna nova no UPDATE tem de aparecer na foto sozinha, ou aqui falha.
const escritas = [...correcao.SQL_PUXAR_CI
  .slice(correcao.SQL_PUXAR_CI.indexOf('SET'), correcao.SQL_PUXAR_CI.indexOf('WHERE'))
  // O `SET` divide a linha com a primeira coluna (`SET enviado_ci = false`); sem tira-lo
  // daqui a primeira coluna escapa da contagem — e era justamente a `enviado_ci`.
  .replace(/\bSET\b/, '   ')
  .matchAll(/^\s*(\w+)\s*=/gm)].map(m => m[1]);
T('o SQL_PUXAR_CI escreve as 20 colunas conhecidas', escritas.length === 20, `achou ${escritas.length}`);
const faltando = escritas.filter(c => c !== 'atualizado_em' && !correcao.COLUNAS_FOTO.includes(c));
T('TODA coluna escrita pelo puxar_ci esta na foto', faltando.length === 0, faltando.join(', '));
T('menos atualizado_em, que e o carimbo de "acabou de ser mexida"',
  !correcao.COLUNAS_FOTO.includes('atualizado_em'));
T('e data_baixa esta na foto mesmo sem ser escrita — ela e a PROVA',
  correcao.COLUNAS_FOTO.includes('data_baixa') && !escritas.includes('data_baixa'));
T('os quatro campos que se perdiam estao na foto',
  ['dt_envio_ci', 'parecer_tipo', 'estornada', 'baixada'].every(c => correcao.COLUNAS_FOTO.includes(c)));

// ⚠️ A armadilha 18: o JSON tem de ser montado pelo Postgres, nunca por JSON.stringify(Date).
T('a foto e montada com to_jsonb no banco, nao em JavaScript', /to_jsonb\(x\)/.test(correcao.SQL_FOTO));
T('e chaveada por codigo_pc — uma parcela leva ate 7 PCs que divergem',
  /jsonb_object_agg\(x\.codigo_pc/.test(correcao.SQL_FOTO));

// ── a restauracao: nenhuma data nova ─────────────────────────────────────────
const setRestaura = correcao.SQL_RESTAURAR_FOTO.slice(
  correcao.SQL_RESTAURAR_FOTO.indexOf('SET'), correcao.SQL_RESTAURAR_FOTO.indexOf('FROM jsonb_each'));
T('a restauracao NAO carimba NOW() em data original',
  (setRestaura.match(/NOW\(\)/g) || []).length === 1);
T('e o unico NOW() e o do atualizado_em', /atualizado_em\s*=\s*NOW\(\)/.test(setRestaura));
T('data_baixa NAO e escrita na restauracao — ela nunca foi apagada',
  !/data_baixa\s*=/.test(setRestaura));
['dt_envio_ci', 'data_estorno', 'dt_situacao'].forEach(c =>
  T(`${c} sai da FOTO, com cast de timestamp`,
    new RegExp(`${c}\\s*=\\s*\\(e\\.v->>'${c}'\\)::timestamp`).test(setRestaura)));
T('ci_rodada leva COALESCE — e a unica NOT NULL da lista',
  /ci_rodada\s*=\s*COALESCE\(\(e\.v->>'ci_rodada'\)::integer, 0\)/.test(setRestaura));
T('toda coluna da foto (menos data_baixa) e restaurada',
  correcao.COLUNAS_FOTO.filter(c => c !== 'data_baixa')
    .every(c => new RegExp(`\\b${c}\\s*=`).test(setRestaura)));

// ── quem desfaz ──────────────────────────────────────────────────────────────
const HIST = (over = {}) => ({ id: 9, evento: 'puxar_ci', estado_anterior: { '2020PC000001': {} }, ...over });

T('so o superadmin desfaz', correcao.podeDesfazerPuxarCi('superadmin', HIST()).pode === true);
T('o analista NAO desfaz', correcao.podeDesfazerPuxarCi('analista', HIST()).pode === false);
T('o coordenador tambem NAO', correcao.podeDesfazerPuxarCi('coordenador', HIST()).pode === false);
// ⚠️ Papel analista: o superadmin e analista aqui tambem — e o perfilEfetivo que chega.
T('superadmin no papel analista NAO desfaz',
  correcao.podeDesfazerPuxarCi('analista', HIST()).pode === false);
T('evento que nao e puxar_ci: recusa',
  correcao.podeDesfazerPuxarCi('superadmin', HIST({ evento: 'estorno' })).pode === false);
T('evento inexistente: recusa', correcao.podeDesfazerPuxarCi('superadmin', null).pode === false);

// ⚠️ O CORACAO DA DECISAO DO RICHARD, 26/08: SEM FOTO NAO DESFAZ, E DIZ POR QUE.
T('puxada SEM foto (null) NAO pode ser desfeita',
  correcao.podeDesfazerPuxarCi('superadmin', HIST({ estado_anterior: null })).pode === false);
T('puxada com foto VAZIA tambem nao',
  correcao.podeDesfazerPuxarCi('superadmin', HIST({ estado_anterior: {} })).pode === false);
T('e o motivo diz que a foto nao existe, para a tela mostrar',
  /NÃO TEM FOTO/.test(correcao.podeDesfazerPuxarCi('superadmin', HIST({ estado_anterior: null })).motivo));
T('e diz que desfazer seria inventar valor',
  /inventar valor/.test(correcao.podeDesfazerPuxarCi('superadmin', HIST({ estado_anterior: null })).motivo));

// ── a PC ainda esta como a puxada deixou? ────────────────────────────────────
const DEIXADA = (over = {}) => ({
  codigo_pc: '2020PC000001', enviado_ci: false, dt_envio_ci: null, enviado_ci_por: null,
  ci_situacao: null, ci_rodada: 0, baixada: false, parecer_tipo: null, estornada: true,
  data_baixa: '2026-08-21T18:40:42.186', ...over,
});
const FOTO1 = { data_baixa: '2026-08-21T18:40:42.186' };

T('intacta: passa', correcao.conferirIntacta(DEIXADA(), FOTO1) === null);
T('foi baixada de novo: RECUSA', /baixada de novo/.test(correcao.conferirIntacta(DEIXADA({ baixada: true }), FOTO1)));
T('tem parecer de novo: RECUSA', /parecer de novo/.test(correcao.conferirIntacta(DEIXADA({ parecer_tipo: 'X' }), FOTO1)));
T('foi reencaminhada ao C.I.: RECUSA', /reencaminhada/.test(correcao.conferirIntacta(DEIXADA({ enviado_ci: true }), FOTO1)));
T('voltou ao ciclo do C.I.: RECUSA', /ciclo do C\.I\./.test(correcao.conferirIntacta(DEIXADA({ ci_situacao: 'na_fila' }), FOTO1)));
T('mudou de rodada: RECUSA', /rodada 1/.test(correcao.conferirIntacta(DEIXADA({ ci_rodada: 1 }), FOTO1)));
T('deixou de estar estornada: RECUSA', /estornada/.test(correcao.conferirIntacta(DEIXADA({ estornada: false }), FOTO1)));
T('a PC sumiu: RECUSA', correcao.conferirIntacta(null, FOTO1) === 'a PC não existe mais');
// ⚠️ O CASO REAL DA 2023PC002107 — baixa de 17/08 refeita a mao virou baixa de 20/08.
T('a data da baixa MUDOU (a baixa foi refeita a mao): RECUSA',
  /a data da baixa mudou/.test(correcao.conferirIntacta(DEIXADA({ data_baixa: '2026-08-20T23:45:25.674' }), FOTO1)));

// ── a conferencia DEPOIS de gravar ───────────────────────────────────────────
const F = { '2020PC000001': { baixada: true, data_baixa: '2026-08-21T18:40:42.186', status: 'baixada',
  situacao_atual: null, parecer_tipo: 'Parecer Regular com Ressalvas', baixado_por: 33,
  enviado_ci: true, dt_envio_ci: '2026-08-21T18:40:54.458', enviado_ci_por: 33, parecer_ci: null,
  ci_situacao: 'na_fila', ci_rodada: 1, ci_encerrado_em: null, ci_encerrado_por: null,
  estornada: false, data_estorno: null, motivo_estorno: null, estornado_por: null,
  dt_situacao: null, obs_situacao: null } };
// ⚠️ OS DOIS LADOS SAO FOTOS — objetos chaveados por codigo_pc, vindos do mesmo `to_jsonb`.
// Comparar contra uma LINHA lida em JavaScript era o defeito que a prova de banco achou em
// 26/08: o `Date` do JS trunca o microssegundo do `timestamp` e a conferencia acusava
// divergencia numa restauracao correta, derrubando tudo no ROLLBACK.
const outra = { '2020PC000001': { ...F['2020PC000001'], parecer_tipo: 'outro' } };
T('foto == foto depois: bate', correcao.conferirRestauracao(F, F).length === 0);
T('uma coluna fora do lugar: acusa', correcao.conferirRestauracao(F, outra).length === 1);
T('e diz qual coluna e o que esperava',
  /parecer_tipo: esperado/.test(correcao.conferirRestauracao(F, outra)[0]));
T('PC que sumiu: acusa', /sumiu/.test(correcao.conferirRestauracao(F, {})[0]));
// ⚠️ O microssegundo TEM de sobreviver a comparacao — e o digito que o Date comia.
const micro = { '2020PC000001': { ...F['2020PC000001'], dt_envio_ci: '2026-08-19T17:54:40.866734' } };
T('microssegundo identico: bate', correcao.conferirRestauracao(micro, micro).length === 0);
T('microssegundo truncado no milissegundo: ACUSA',
  correcao.conferirRestauracao(micro,
    { '2020PC000001': { ...micro['2020PC000001'], dt_envio_ci: '2026-08-19T17:54:40.866' } }).length === 1);

// ⚠️ ARMADILHA 18 — o Date do pg e comparado pelos componentes LOCAIS, nunca por toISOString.
const dtLocal = new Date(2026, 7, 21, 18, 40, 54, 458);   // 21/08/2026 18:40:54.458 local
T('textoData le o Date pelo relogio de parede, como o to_jsonb do Postgres',
  correcao.textoData(dtLocal) === '2026-08-21T18:40:54.458');
T('e NAO usa toISOString, que somaria o fuso',
  correcao.textoData(dtLocal) !== dtLocal.toISOString().replace('Z', ''));
T('milissegundo zero sai sem .000, igual ao to_jsonb',
  correcao.textoData(new Date(2026, 5, 30, 0, 0, 0, 0)) === '2026-06-30T00:00:00');
T('texto que ja veio texto passa direto', correcao.textoData('2026-06-30T00:00:00') === '2026-06-30T00:00:00');
T('null continua null', correcao.textoData(null) === null);
T('a funcao nao usa toISOString em lugar nenhum',
  !/toISOString/.test(corr.slice(corr.indexOf('function textoData'), corr.indexOf('function conferirIntacta'))));

// ── a rota, no server ────────────────────────────────────────────────────────
T('a rota de desfazer existe', /app\.post\('\/parcela\/desfazer_puxar_ci'/.test(srv));
T('e exige motivo pela MESMA validacao das outras',
  /desfazer_puxar_ci[\s\S]{0,700}correcao\.validarMotivo/.test(srv));
T('o puxar_ci grava a foto no historico', /estado_anterior: r\.foto/.test(srv));
T('a foto e tirada ANTES do UPDATE que apaga',
  srv.indexOf('correcao.SQL_FOTO, [alvo]') < srv.indexOf('correcao.SQL_PUXAR_CI, [alvo'));
T('a aprovacao do coordenador tambem grava foto', /estado_anterior: r\.foto \?\? null/.test(srv));
T('registrarHistorico passa a gravar estado_anterior', /observacao, executado_por, estado_anterior/.test(srv));
T('o desfazer confere DEPOIS de gravar, contra a foto',
  srv.indexOf('correcao.SQL_RESTAURAR_FOTO') < srv.indexOf('correcao.conferirRestauracao(foto,'));
// ⚠️ A conferencia NAO pode ler a linha em JavaScript — o Date trunca o microssegundo do
// timestamp e acusa divergencia numa restauracao correta. Os dois lados vem do SQL_FOTO.
const rotaDesfazer = srv.slice(srv.indexOf("app.post('/parcela/desfazer_puxar_ci'"),
                               srv.indexOf("app.post('/prestacoes_contas/nova'"));
T('a rota trava as PCs, mas le os VALORES pelo SQL_FOTO',
  /SQL_TRAVAR_PARA_DESFAZER/.test(rotaDesfazer) && (rotaDesfazer.match(/SQL_FOTO/g) || []).length === 2);
T('nenhuma conferencia da rota passa por textoData',
  !/conferirIntacta\([^)]*textoData|conferirRestauracao\([^)]*textoData/.test(rotaDesfazer));
T('e a lib avisa que textoData nao serve para comparar',
  /NÃO USE ISTO EM CONFERÊNCIA/.test(corr));
T('e faz ROLLBACK quando a conferencia nao bate',
  /conferirRestauracao[\s\S]{0,400}ROLLBACK/.test(srv));
T('o desfazer e idempotente — recusa a puxada ja desfeita',
  /SQL_JA_DESFEITA[\s\S]{0,400}já foi desfeita/.test(srv));
T('a coluna nasce pelo boot, idempotente',
  /ADD COLUMN IF NOT EXISTS estado_anterior jsonb/.test(srv));
T('e o boot chama garantirFotoHistorico', /\.then\(garantirFotoHistorico\)/.test(srv));
T('GET /parcela/acoes diz a tela se da para desfazer, e por que nao',
  /desfazer_puxar_ci: desfazer/.test(srv));
T('o desfazimento vira evento proprio no acompanhamento',
  /desfazer_puxar_ci:\s*\{ rotulo:/.test(fs.readFileSync('./lib/acompanhamento.js', 'utf8')));

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exitCode = falhou ? 1 : 0;
