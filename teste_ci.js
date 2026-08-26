// CAMINHO: sigpc-api/teste_ci.js
//
// Testes do CONTROLE INTERNO (lib/ci.js). Sem rede e sem banco.
//
// ⚠️ O QUE ESTES TESTES PROTEGEM
//
//   · A BAIXA NUNCA É TOCADA. Regra do Richard: encaminhar ao CI já conta como baixa, e a
//     baixa não é estornada, qualquer que seja o desfecho. Há trava que lê o lib e o
//     server e falha se um UPDATE do ciclo mencionar baixada, data_baixa ou enviado_ci.
//   · NENHUMA DAS DUAS DECISÕES exige texto (25/08/2026). Quem ainda exige é a RESPOSTA DO
//     ANALISTA (`exigeTexto`), onde o texto É a manifestação.
//   · A rodada sobe SÓ na devolução. Subir dos dois lados dobraria a contagem.
//   · Uma notificação por PARCELA, não por PC: a parcela 1 da 2020TR000657 tem 7 PCs, e
//     sete avisos idênticos matam o sino.
//
// USO: node teste_ci.js

const C = require('./lib/ci');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// Dublê que grava o SQL e sabe fingir uma transação.
function db(linhas) {
  const ch = [];
  const q = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    ch.push({ sql: s, params });
    if (/FOR UPDATE/.test(s)) return { rows: linhas || [] };
    if (/^INSERT INTO ci_mensagem/i.test(s)) return { rows: (linhas || []).map(() => ({ id: 1 })) };
    return { rows: [] };
  };
  return { ch, query: q, connect: async () => ({ query: q, release() {} }) };
}

const PCS = [
  { codigo_pc: '2020PC000448', tr: '2020TR000657', parcial_num: '1', analista_id: 36, entidade: 'APAE', ci_rodada: 1 },
  { codigo_pc: '2020PC000520', tr: '2020TR000657', parcial_num: '1', analista_id: 36, entidade: 'APAE', ci_rodada: 1 },
  { codigo_pc: '2020PC001823', tr: '2020TR000657', parcial_num: '3', analista_id: 36, entidade: 'APAE', ci_rodada: 1 },
  { codigo_pc: '2021PC002087', tr: '2021TR001610', parcial_num: '1', analista_id: 43, entidade: 'APAE X', ci_rodada: 2 },
];

(async () => {

console.log('\n═══ 1. A BAIXA NUNCA E TOCADA ═══');
{
  for (const decisao of ['de_acordo', 'ressalva']) {
    const d = db(PCS);
    await C.decidir(d, { setorial_id: 'FCEE', tr: '2020TR000657', parcial_num: '1', decisao,
                         texto: 'Verificar o comprovante no SGPe.', autor: { id: 9, nome: 'Marcos', perfil: 'controle_interno' } });
    const updates = d.ch.filter(c => /^UPDATE prestacoes_contas/i.test(c.sql));
    const suja = updates.some(c => /\bbaixada\b|\bdata_baixa\b|\benviado_ci\b/.test(c.sql));
    conf(!suja, `'${decisao}' nao menciona baixada/data_baixa/enviado_ci em nenhum UPDATE`,
         updates.map(u => u.sql.slice(0, 60)).join(' | '));
  }
  const d2 = db(PCS);
  await C.responder(d2, { codigos_pc: ['2020PC000448'], texto: 'Comprovante anexado, fl. 214.',
                          autor: { id: 36, nome: 'Claudia', perfil: 'analista' } });
  const suja2 = d2.ch.filter(c => /^UPDATE prestacoes_contas/i.test(c.sql))
                     .some(c => /\bbaixada\b|\bdata_baixa\b|\benviado_ci\b/.test(c.sql));
  conf(!suja2, 'a resposta do analista tambem nao toca na baixa');
}

console.log('\n═══ 2. AS DUAS SAIDAS ═══');
{
  const d = db(PCS);
  await C.decidir(d, { setorial_id: 'FCEE', tr: '2020TR000657', parcial_num: '1', decisao: 'de_acordo', autor: { id: 9 } });
  const u = d.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(/ci_situacao = 'encerrado'/.test(u.sql), 'de acordo → encerrado');
  conf(/ci_encerrado_em = NOW\(\)/.test(u.sql), 'e carimba quando');
  conf(/ci_encerrado_por/.test(u.sql), 'e quem');
  conf(!/ci_rodada/.test(u.sql), 'encerrar NAO mexe na rodada');

  const d2 = db(PCS);
  await C.decidir(d2, { setorial_id: 'FCEE', tr: '2020TR000657', parcial_num: '1', decisao: 'ressalva', texto: 'Falta o comprovante.', autor: { id: 9 } });
  const u2 = d2.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(/ci_situacao = 'com_analista'/.test(u2.sql), 'ressalva → com o analista');
  conf(/ci_rodada = GREATEST\(ci_rodada, 1\) \+ 1/.test(u2.sql), 'e a rodada SOBE');
}

console.log('\n═══ 3. A RODADA SO SOBE NA IDA ═══');
{
  // Uma ida e volta e UMA rodada. Subir dos dois lados dobraria a contagem, e o "rodada 2"
  // da tela deixaria de bater com o que aconteceu.
  const d = db(PCS);
  await C.responder(d, { codigos_pc: ['2020PC000448'], texto: 'Comprovante anexado.', autor: { id: 36 } });
  const u = d.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(/ci_situacao = 'na_fila'/.test(u.sql), 'responder devolve a PC para a fila do CI');
  conf(!/ci_rodada/.test(u.sql), 'e NAO incrementa a rodada');
}

console.log('\n═══ 4. SO DECIDE O QUE ESTA NA FILA ═══');
{
  const d = db(PCS);
  await C.decidir(d, { setorial_id: 'FCEE', tr: '2020TR000657', parcial_num: '1', decisao: 'de_acordo', autor: { id: 9 } });
  const sel = d.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/ci_situacao = 'na_fila'/.test(sel.sql), 'a selecao exige estar na fila');
  conf(/FOR UPDATE/.test(sel.sql), 'e trava a linha — dois cliques nao decidem duas vezes');

  const vazio = db([]);
  const r = await C.decidir(vazio, { setorial_id: 'FCEE', tr: '2020TR000657', parcial_num: '1', decisao: 'de_acordo', autor: { id: 9 } });
  conf(r.jaDecidido === true, 'nada na fila devolve jaDecidido');
  conf(vazio.ch.some(c => /ROLLBACK/.test(c.sql)), 'e desfaz a transacao');

  const vazio2 = db([]);
  const r2 = await C.responder(vazio2, { codigos_pc: ['x'], texto: 'oi oi oi oi', autor: { id: 36 } });
  conf(r2.jaRespondido === true, 'responder o que nao esta com o analista tambem recusa');
  const sel2 = vazio2.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/ci_situacao = 'com_analista'/.test(sel2.sql), 'a selecao da resposta exige estar com o analista');
}

console.log('\n═══ 5. TEXTO: QUANDO EXIGE E QUANDO NAO ═══');
{
  const base = { codigos_pc: ['a'] };
  // Decisao do Richard: o CI pode encerrar sem escrever nada.
  conf(C.validar({ ...base, decisao: 'de_acordo' }) === null, 'de acordo SEM texto passa');
  conf(C.validar({ ...base, decisao: 'de_acordo', texto: '' }) === null, 'texto vazio tambem');
  // ⚠️ A RESSALVA DEIXOU DE EXIGIR TEXTO EM 25/08/2026, por decisão do Richard. A tela nova
  // põe **Observação (opcional)** nas duas decisões: o rótulo do rádio já diz o que fazer
  // — *Parecer para correção, verificar o processo no SGPe* — e ele viaja inteiro na
  // notificação. A observação virou o complemento, não o recado.
  conf(C.validar({ ...base, decisao: 'ressalva' }) === null, 'ressalva SEM texto passa (25/08/2026)');
  conf(C.validar({ ...base, decisao: 'ressalva', texto: 'curto' }) === null, 'e texto curto tambem');
  conf(C.validar({ ...base, decisao: 'ressalva', texto: 'Falta o comprovante no SGPe.' }) === null, 'ressalva com texto passa');
  conf(C.validar({ ...base, exigeTexto: true }) !== null, 'a resposta do analista exige texto');
  conf(C.validar({ ...base, texto: 'x'.repeat(4001) }) !== null, 'texto acima de 4000 e recusado');
  conf(C.validar({ codigos_pc: [] }) !== null, 'sem PC selecionada e recusado');
  conf(C.validar({ ...base, decisao: 'talvez' }) !== null, 'decisao invalida e recusada');
  conf(C.validar(null) !== null, 'corpo vazio e recusado');
}

console.log('\n═══ 6. A MESMA MENSAGEM PARA AS N PCs DA PARCELA ═══');
{
  // A conversa e por PC (decisao do Richard), mas o encaminhamento e por parcela: sete PCs
  // recebem a mesma mensagem, com a MESMA rodada, sem o tecnico digitar sete vezes.
  const d = db(PCS);
  await C.gravarMensagem(d, PCS.map(p => p.codigo_pc), {
    direcao: 'ci_para_analista', texto: 'Falta o comprovante.', autor: { id: 9, nome: 'Marcos', perfil: 'controle_interno' } });
  const ins = d.ch.find(c => /^INSERT INTO ci_mensagem/i.test(c.sql));
  conf(!!ins, 'grava em ci_mensagem');
  conf(/SELECT p\.codigo_pc, GREATEST\(p\.ci_rodada, 1\)/.test(ins.sql),
       'uma linha por PC, com a rodada lida DA PC');
  // A rodada nao vem da tela: a tela pode estar velha, e duas mensagens na rodada errada
  // embaralhariam a conversa.
  conf(!ins.params.includes(1) || !/\$\d+::int, \$\d+::text.*rodada/.test(ins.sql),
       'a rodada nao e um parametro vindo da tela');
  conf(ins.params[1] === 'ci_para_analista', 'a direcao vai gravada');

  const vazio = db(PCS);
  const n = await C.gravarMensagem(vazio, ['a'], { direcao: 'ci_para_analista', texto: '   ', autor: {} });
  conf(n === 0, 'texto em branco nao grava mensagem nenhuma');
  conf(!vazio.ch.length, 'e nem chega a falar com o banco');
}

console.log('\n═══ 7. UMA NOTIFICACAO POR PARCELA, NAO POR PC ═══');
{
  const g = C.agruparPorParcela(PCS);
  conf(g.length === 3, '4 PCs viram 3 encaminhamentos', String(g.length));
  const p1 = g.find(x => x.tr === '2020TR000657' && x.parcial_num === '1');
  conf(p1.pcs.length === 2, 'a parcela 1 juntou as suas 2 PCs');
  conf(p1.analista_id === 36, 'e leva o analista junto');
  conf(g.every(x => x.analista_id), 'todo grupo tem destinatario');
  // Sem o agrupamento, a parcela de 7 PCs mandaria 7 avisos identicos.
  conf(new Set(g.map(x => `${x.tr}|${x.parcial_num}`)).size === g.length, 'nao ha grupo repetido');
}

console.log('\n═══ 8. A FILA LISTA POR ci_situacao, NAO POR enviado_ci ═══');
{
  const d = db([]);
  await C.fila(d, 'na_fila');
  const s = d.ch[0].sql;
  // ⚠️ Se a fila filtrasse por enviado_ci, a PC devolvida ao analista continuaria aparecendo
  // na fila do CI — que e exatamente o defeito que este ciclo veio corrigir.
  conf(/WHERE p\.ci_situacao = \$1/.test(s), 'o WHERE e por ci_situacao');
  conf(!/enviado_ci/.test(s), 'e nao menciona enviado_ci');
  conf(d.ch[0].params[0] === 'na_fila', 'a situacao vai parametrizada');

  const d2 = db([]);
  await C.fila(d2, 'lixo_qualquer');
  conf(d2.ch[0].params[0] === 'na_fila', 'situacao invalida cai na fila, nao vira SQL solto');
  const d3 = db([]);
  await C.fila(d3, 'encerrado');
  conf(d3.ch[0].params[0] === 'encerrado', 'e as validas passam');
  conf(/ORDER BY p\.dt_envio_ci/.test(d3.ch[0].sql), 'mais antigas primeiro');
}

console.log('\n═══ 9. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/app\.get\('\/ci\/fila'/.test(src), 'GET /ci/fila existe');
  conf(/app\.post\('\/ci\/decidir'/.test(src), 'POST /ci/decidir existe');
  conf(/app\.post\('\/ci\/responder'/.test(src), 'POST /ci/responder existe');
  // Quem decide e conferido pelo BANCO, nao pelo `perfil` do corpo.
  // ⚠️ Em 14/08 entrou o PERFIL EFETIVO: no papel analista o superadmin não decide no C.I.
  conf(/SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = \$1[\s\S]{0,400}?papel\.perfilEfetivo\(autor\)/.test(src),
       'so o CI (ou coordenacao) decide, conferido pelo banco e pelo PAPEL ATIVO');
  // A rodada no ref_id e o que faz a SEGUNDA volta avisar.
  conf(/ci_ressalva\|\$\{\(g\.rodada \|\| 1\) \+ 1\}/.test(src), 'o ref_id da ressalva carrega a rodada');
  conf(/ci_resposta\|\$\{g\.rodada \|\| 1\}/.test(src), 'e o da resposta tambem');
  // O encaminhamento tem de entrar na fila, senao nao aparece para o CI.
  conf(/ci_situacao = 'na_fila',[\s\S]{0,80}?ci_rodada = GREATEST\(ci_rodada, 1\)/.test(src),
       'POST /parcela/ci poe a parcela na fila do CI');
  // E o boot repara o que faltar.
  conf(/async function garantirCi\(\)/.test(src) && /\.then\(garantirCi\)/.test(src),
       'a migracao do CI roda no boot');
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /parcela/ci_lote — encaminhar VARIAS parcelas numa transacao so (16/08/2026)
//
// Existe porque sao 764 parcelas baixadas com parecer e fora do CI, em 41 analistas:
// a Geisa clicaria 63 vezes. E e ROTA, nao laco na tela — armadilha 16 do sigpc-gt.
// ══════════════════════════════════════════════════════════════════════════════
{
  // `src` da secao 9 e local dela — leio de novo, que e barato e nao acopla os blocos.
  const srv = fs.readFileSync('./server.js', 'utf8');
  const ini = srv.indexOf("app.post('/parcela/ci_lote'");
  const fim = srv.indexOf("app.post('/parcela/estornar'");
  conf(ini > 0 && fim > ini, 'a rota /parcela/ci_lote existe');
  const rota = srv.slice(ini, fim);
  // sem os comentarios: teste de posicao/ausencia que le prosa mede a prosa, nao o programa
  const cod = rota.split('\n').filter(l => !/^\s*(\/\/|--|\*)/.test(l.trim() ? l : '//')).join('\n');

  conf(/await cli\.query\('BEGIN'\)/.test(rota) && (rota.match(/COMMIT/g) || []).length === 1,
       'UMA transacao: um BEGIN e um COMMIT so');
  conf(/parcial_num = ANY\(\$3\)/.test(rota),
       'escreve por LISTA EXPLICITA de parciais (regra 12), nao por condicao derivada');
  conf(/carregarParcela\(cli, b\.tr, num, setorial_id\)/.test(rota),
       'usa a MESMA carregarParcela das outras cinco rotas — com FOR UPDATE');
  conf(/resolverAutoria/.test(rota), 'resolve o dono e o executor contra o perfil do BANCO');
  conf(/barrouPreparacao/.test(rota), 'respeita o modo preparacao');

  // ── as travas, uma por uma ──
  conf(/CI exige parecer previo|CI exige parecer prévio/.test(rota), 'recusa parcela sem parecer');
  conf(/Parcial não está baixada|nao esta baixada/.test(rota), 'recusa parcela nao baixada');
  conf(/Já encaminhada|Ja encaminhada/.test(rota), 'recusa parcela ja encaminhada');
  conf(/AND baixada = true/.test(rota),
       'e o UPDATE so pega baixada = true — enviado_ci sustenta a baixa');

  // ⚠️ TUDO OU NADA: uma recusada aborta o lote. A tela so oferece as do passo 2, entao uma
  // recusa quer dizer que o estado mudou embaixo da pessoa.
  conf(/if \(recusadas\.length\)[\s\S]{0,200}ROLLBACK[\s\S]{0,200}409/.test(rota),
       'TUDO OU NADA: qualquer recusa faz ROLLBACK e devolve 409 com a lista');
  conf(rota.indexOf('recusadas.push') < rota.indexOf('UPDATE prestacoes_contas'),
       'e confere TODAS antes de escrever qualquer uma');

  // ⚠️ UMA LINHA DE HISTORICO POR PARCELA: parcela_historico e chaveado por (tr, parcial_num),
  // e uma linha so para as sete nao apareceria em seis delas.
  conf(/for \(const a of aceitas\)[\s\S]{0,400}registrarHistorico/.test(rota),
       'grava UMA linha de historico por parcela, num laco sobre as aceitas');

  // ⚠️ A BAIXA NUNCA E TOCADA — a mesma trava que as outras rotas do ciclo tem.
  // ⚠️ SO O `SET`, NUNCA ATE O `RETURNING`. A primeira versao deste teste pegava o UPDATE
  // inteiro e reprovava o codigo CERTO: o `AND baixada = true` do WHERE — que e' exatamente
  // a trava que se quer — casava com o padrao de "mexe em baixada". Ler o WHERE aqui e' o
  // mesmo erro de medir a prosa do comentario.
  const sets = (rota.match(/UPDATE prestacoes_contas[\s\S]*?SET([\s\S]*?)WHERE/g) || [])
    .map(u => u.slice(u.indexOf('SET'))).join(' ');
  conf(sets.length > 0, 'o UPDATE tem um SET legivel');
  conf(!/\bbaixada\s*=/.test(sets) && !/\bdata_baixa\s*=/.test(sets)
       && !/\bparecer_tipo\s*=/.test(sets) && !/\bvalor\s*=/.test(sets),
       'o SET NAO mexe em baixada, data_baixa, parecer_tipo nem valor');
  conf(/\bbaixada = true\b/.test(rota.slice(rota.indexOf('UPDATE prestacoes_contas'))),
       'e o WHERE do UPDATE exige baixada = true');

  conf(/lock_timeout/.test(rota), 'e tem lock_timeout — o lote segura linhas de varias parcelas');
  conf(/parciais\.length > 200/.test(rota), 'e recusa lote grande demais');
}

// ══════════════════════════════════════════════════════════════════════════════
// REABRIR UMA PC ENCERRADA — a porta de volta que o ciclo nao tinha (26/08/2026)
//
// ⚠️ O QUE ESTES TESTES PROTEGEM
//   · a reabertura NAO carimba ci_tecnico_id/ci_tecnico_em — ordem do Richard: as duas
//     colunas continuam com UM caminho de escrita, que e ci.decidir;
//   · ela NAO toca baixada, data_baixa nem enviado_ci — a PC reaberta e trabalho FEITO
//     que precisa de mais uma volta, nao trabalho anulado;
//   · o destino e `com_analista`, nao `na_fila`: `na_fila` devolveria a PC para o C.I.,
//     que e justamente quem esta pedindo para devolve-la;
//   · e o alvo e `ci_situacao = 'encerrado'`, o que a torna idempotente.
console.log('\n═══ 15. REABRIR UMA PC ENCERRADA ═══');
{
  const ENC = [
    { codigo_pc: '2020PC001898', tr: '2020TR000680', parcial_num: '6', analista_id: 16, entidade: 'APAE', ci_rodada: 1 },
    { codigo_pc: '2020PC002958', tr: '2020TR000680', parcial_num: '6', analista_id: 16, entidade: 'APAE', ci_rodada: 1 },
  ];
  const d = db(ENC);
  const r = await C.reabrir(d, { codigos_pc: ENC.map(p => p.codigo_pc),
                                 texto: 'O processo voltou pelo SGPe apos o encerramento.',
                                 autor: { id: 62, nome: 'Marcia', perfil: 'controle_interno' } });
  const upd = d.ch.filter(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  const set = upd.map(u => u.sql.slice(u.sql.indexOf('SET'), u.sql.indexOf('WHERE'))).join(' ');

  conf(upd.length === 1, 'UM UPDATE so', `${upd.length}`);
  conf(/ci_situacao\s*=\s*'com_analista'/.test(set), "vai para 'com_analista', nao para 'na_fila'");
  conf(!/'na_fila'/.test(set), "e NAO menciona 'na_fila' em lugar nenhum do SET");
  conf(/ci_rodada\s*=\s*GREATEST\(ci_rodada, 1\) \+ 1/.test(set), 'a rodada sobe uma');
  conf(/ci_encerrado_em\s*=\s*NULL/.test(set) && /ci_encerrado_por\s*=\s*NULL/.test(set),
       'zera ci_encerrado_em e ci_encerrado_por');

  // ⚠️ A TRAVA DO CARIMBO. Se um dia alguem acrescentar ci_tecnico_* aqui "para ficar
  // completo", este teste cai — e e' esse o ponto: a coluna deixaria de responder "quem
  // deu o parecer" e passaria a responder "quem mexeu por ultimo".
  conf(!/ci_tecnico_id/.test(set) && !/ci_tecnico_em/.test(set),
       'NAO carimba ci_tecnico_id nem ci_tecnico_em — a escrita deles e so de ci.decidir');
  conf(!/\bbaixada\b|\bdata_baixa\b|\benviado_ci\b|\bestornada\b|\bparecer_tipo\b/.test(set),
       'NAO toca baixada, data_baixa, enviado_ci, estornada nem parecer_tipo');

  // O alvo, e a idempotencia que sai dele.
  const sel = d.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/ci_situacao = 'encerrado'/.test(sel.sql), "so alcanca quem esta 'encerrado'");
  conf(/codigo_pc = ANY\(\$1\)/.test(sel.sql), 'e a chave e codigo_pc, nunca parcial_num');
  conf(!/parcial_num\s*=/.test(sel.sql), 'nada de filtrar por parcial_num');
  conf(/ci_situacao = 'encerrado'/.test(upd[0].sql.slice(upd[0].sql.indexOf('WHERE'))),
       'o WHERE do UPDATE tambem exige encerrado — e o que faz a segunda passada nao somar rodada');

  // A conversa e a trilha.
  const msg = d.ch.filter(c => /^INSERT INTO ci_mensagem/i.test(c.sql));
  conf(msg.length === 1 && msg[0].params[1] === 'ci_para_analista',
       'grava UMA mensagem, ci_para_analista');
  conf(d.ch.indexOf(msg[0]) < d.ch.indexOf(upd[0]),
       'e a mensagem vem ANTES do UPDATE — a rodada dela e a de quem escreveu');
  const hist = d.ch.filter(c => /^INSERT INTO parcela_historico/i.test(c.sql));
  conf(hist.length === ENC.length, 'uma linha de historico POR PC', `${hist.length}`);
  conf(/'ci_reabriu'/.test(hist[0].sql), 'com o evento ci_reabriu');
  conf(/'encerrado'/.test(hist[0].sql) && /'com_analista'/.test(hist[0].sql),
       'de encerrado para com_analista, escrito na trilha');
  conf(d.ch.some(c => /COMMIT/.test(c.sql)) && d.ch.indexOf(hist[0]) < d.ch.findIndex(c => /COMMIT/.test(c.sql)),
       'tudo dentro da MESMA transacao');
  conf(r.pcs.length === ENC.length && r.jaReaberto === false, 'devolve as PCs para a rota notificar');

  // Nada encerrado -> 409, e nenhuma escrita.
  const vazio = db([]);
  const r2 = await C.reabrir(vazio, { codigos_pc: ['X'], texto: 'nada', autor: { id: 62 } });
  conf(r2.jaReaberto === true && r2.pcs.length === 0,
       'nenhuma PC encerrada: avisa jaReaberto, para a rota responder 409');
  conf(!vazio.ch.some(c => /^UPDATE|^INSERT/i.test(c.sql)) && vazio.ch.some(c => /ROLLBACK/.test(c.sql)),
       'e nao escreve nada — ROLLBACK');

  // O texto do historico.
  const t = C.textoReabertura('Marcia', '2020PC001898', 'voltou pelo SGPe');
  conf(/Marcia/.test(t) && /2020PC001898/.test(t), 'o texto nomeia quem reabriu e a PC');
  conf(/baixa e o encaminhamento ao C\.I\. seguem valendo/.test(t),
       'e diz, na propria trilha, que a baixa nao caiu');
  conf(/Motivo: voltou pelo SGPe/.test(t), 'e carrega o motivo');
  conf(!/Motivo:/.test(C.textoReabertura('M', 'X', '  ')),
       'sem motivo, nao sobra um rotulo "Motivo:" vazio');
}

console.log('\n═══ 16. A ROTA POST /ci/reabrir ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  const ini = src.indexOf("app.post('/ci/reabrir'");
  conf(ini > 0, 'a rota existe');
  const rota = src.slice(ini, src.indexOf("app.get('/limite_tr_excecao'"));
  const cod = rota.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  conf(/ci\.validar\(\{ \.\.\.b, codigos_pc: \['-'\], exigeTexto: true \}\)/.test(cod),
       'o motivo e OBRIGATORIO — vai para a ci_mensagem');
  // ⚠️ O `codigos_pc: ['-']` NAO E' GAMBIARRA — e' o que sobrou de `ci.validar` depois de a
  // lista de PCs sair do corpo. Quem escolhe as PCs agora e' o BANCO, pela parcela; o que a
  // rota ainda precisa validar e' a decisao e o tamanho do texto. Um placeholder explicito
  // diz isso melhor que uma segunda funcao de validacao quase igual.
  conf(/tr && b\.parcial_num !== undefined|!b\.tr \|\| b\.parcial_num === undefined/.test(cod),
       'e a rota exige tr + parcial_num antes de qualquer coisa');
  conf(/SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = \$1/.test(cod),
       'quem reabre e lido do BANCO, nao do corpo do pedido');
  conf(/ciFila\.podeReabrir\(autor\)/.test(cod), 'e passa por ciFila.podeReabrir');
  conf(cod.indexOf('podeReabrir') < cod.indexOf('await ci.reabrir('),
       'a conferencia vem ANTES de escrever');
  conf(/status\(409\)/.test(cod), 'jaReaberto responde 409, nao 200 sobre coisa nenhuma');
  conf(/ci_reabriu\|\$\{\(g\.rodada \|\| 1\) \+ 1\}/.test(cod),
       'o ref_id do sino carrega a rodada NOVA — senao a segunda volta nao avisa');
  conf(!/ci_tecnico/.test(cod), 'a rota nao menciona ci_tecnico — nem para ler');
}

// ══════════════════════════════════════════════════════════════════════════════
// A UNIDADE DO PARECER E' A PARCELA — nao a PC.  (26/08/2026)
//
// ⚠️ O QUE ESTES TESTES PROTEGEM
//   · a chave e (setorial_id, tr, parcial_num), a MESMA de carregarParcela e a mesma que
//     `POST /parcela/parecer` usa. Duas unidades para o mesmo trabalho foi o defeito;
//   · o alvo e `ci_situacao = 'na_fila'` DENTRO da parcela: o C.I. decide so o que a
//     analista encaminhou, e o que ela nao mandou nao e tocado nem bloqueia;
//   · a escrita vai por LISTA EXPLICITA de codigos travados no SELECT (armadilha 12),
//     nunca repetindo a condicao da parcela;
//   · e o historico vira UMA linha por parcela, porque agora e UM ato.
console.log('\n═══ 17. A UNIDADE E A PARCELA ═══');
{
  const PARC = { setorial_id: 'FCEE', tr: '2020TR000633', parcial_num: '1' };
  const NAFILA = [
    { codigo_pc: '2020PC000429', tr: '2020TR000633', parcial_num: '1', setorial_id: 'FCEE', analista_id: 25, entidade: 'APAE', ci_rodada: 1 },
    { codigo_pc: '2020PC000575', tr: '2020TR000633', parcial_num: '1', setorial_id: 'FCEE', analista_id: 25, entidade: 'APAE', ci_rodada: 1 },
    { codigo_pc: '2020PC000917', tr: '2020TR000633', parcial_num: '1', setorial_id: 'FCEE', analista_id: 25, entidade: 'APAE', ci_rodada: 1 },
  ];
  const d = db(NAFILA);
  const r = await C.decidir(d, { ...PARC, decisao: 'de_acordo', texto: 'Conferido.',
                                 autor: { id: 62, nome: 'Marcia', perfil: 'controle_interno' } });

  const sel = d.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/setorial_id = \$1 AND tr = \$2 AND parcial_num = \$3/.test(sel.sql),
       'o alvo e a PARCELA — a mesma chave de carregarParcela');
  conf(!/codigo_pc = ANY/.test(sel.sql), 'e NAO entra mais por lista de codigo_pc');
  conf(/ci_situacao = 'na_fila'/.test(sel.sql),
       "e so alcanca o que esta 'na_fila' — o C.I. decide so o que foi encaminhado");
  conf(sel.params[0] === 'FCEE' && sel.params[1] === '2020TR000633' && sel.params[2] === '1',
       'os tres parametros sao a chave da parcela');

  const upd = d.ch.filter(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(upd.length === 1, 'UM UPDATE para a parcela inteira', `${upd.length}`);
  conf(/codigo_pc = ANY\(\$1\)/.test(upd[0].sql),
       'a escrita vai por LISTA EXPLICITA dos codigos travados (armadilha 12)');
  conf(Array.isArray(upd[0].params[0]) && upd[0].params[0].length === NAFILA.length,
       `a lista tem as ${NAFILA.length} PCs da parcela, nao uma`, JSON.stringify(upd[0].params[0]));
  conf(!/parcial_num\s*=/.test(upd[0].sql.slice(upd[0].sql.indexOf('WHERE'))),
       'e o WHERE do UPDATE nao repete a condicao da parcela — a janela entre SELECT e UPDATE fica fechada');
  conf(r.pcs.length === NAFILA.length, 'devolve as PCs da parcela para a rota notificar');

  // ⚠️ A NOTIFICACAO PASSA A DIZER O NUMERO REAL — e' o mesmo agruparPorParcela de sempre,
  // alimentado por um alvo que agora e' a parcela. Antes ele recebia UMA PC e a parcela de
  // duas virava "Parcela 3 — 1 PC".
  const g = C.agruparPorParcela(r.pcs);
  conf(g.length === 1, 'a parcela inteira vira UM aviso', `${g.length}`);
  conf(g[0].pcs.length === NAFILA.length,
       `e o aviso conta ${NAFILA.length} PCs, nao 1 — era esta a mentira`, `${g[0].pcs.length}`);

  // O historico: uma linha, na chave da parcela, nomeando as PCs.
  const hist = d.ch.filter(c => /INSERT INTO parcela_historico/i.test(c.sql));
  conf(hist.length === 1, 'UMA linha de historico por parcela, nao uma por PC', `${hist.length}`);
  conf(/'ci_decidiu'/.test(hist[0].sql), 'com o evento ci_decidiu');
  conf(hist[0].params[0] === '2020TR000633' && hist[0].params[1] === '1',
       'gravada na chave (tr, parcial_num)');
  conf(NAFILA.every(p => hist[0].params[5].includes(p.codigo_pc)),
       'e o texto nomeia TODAS as PCs alcancadas — a tabela nao tem coluna codigo_pc');
  conf(/3 PCs/.test(hist[0].params[5]), 'e diz quantas foram');

  // A conversa continua por PC — decisao do Richard, e nao mudou.
  const msg = d.ch.filter(c => /^INSERT INTO ci_mensagem/i.test(c.sql));
  conf(msg.length === 1 && Array.isArray(msg[0].params[0]) && msg[0].params[0].length === NAFILA.length,
       'a ci_mensagem continua POR PC: um INSERT que grava uma linha para cada uma');

  // ⚠️ E NADA DISSO TOCA A BAIXA. A trava vale igual depois da mudanca de unidade.
  const set = upd[0].sql.slice(upd[0].sql.indexOf('SET'), upd[0].sql.indexOf('WHERE'));
  conf(!/\bbaixada\b|\bdata_baixa\b|\benviado_ci\b|\bestornada\b/.test(set),
       'o SET nao menciona baixada, data_baixa, enviado_ci nem estornada');
  conf(/ci_tecnico_id/.test(set),
       'e o carimbo do tecnico continua AQUI — o unico caminho de escrita da coluna');
}

console.log('\n═══ 18. PARCELA PARCIALMENTE NA FILA ═══');
{
  // ⚠️ O CASO REAL: 6 parcelas hoje tem parte na fila e parte fora, e o que esta fora e PC
  // NAO BAIXADA — o `AND baixada = true` de POST /parcela/ci a deixou para tras de proposito.
  // A regra do Richard: decide-se o que esta na fila, o resto nao e tocado e NAO bloqueia.
  //
  // O duble devolve so as duas que "estao na fila"; a terceira nem aparece no SELECT, porque
  // o `ci_situacao = 'na_fila'` esta no WHERE. E isso que faz a regra cair de graca.
  const SO_DUAS = [
    { codigo_pc: '2023PC000959', tr: '2022TR001248', parcial_num: '7', setorial_id: 'FCEE', analista_id: 30, entidade: 'X', ci_rodada: 1 },
    { codigo_pc: '2023PC002339', tr: '2022TR001248', parcial_num: '7', setorial_id: 'FCEE', analista_id: 30, entidade: 'X', ci_rodada: 1 },
  ];
  const d = db(SO_DUAS);
  const r = await C.decidir(d, { setorial_id: 'FCEE', tr: '2022TR001248', parcial_num: '7',
                                 decisao: 'ressalva', autor: { id: 62, nome: 'Marcia' } });
  conf(r.jaDecidido === false && r.pcs.length === 2,
       'a parcela parcialmente na fila E decidida — as de fora nao bloqueiam');
  const upd = d.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(upd.params[0].length === 2 && upd.params[0].join() === '2023PC000959,2023PC002339',
       'e a escrita alcanca SO as duas que estavam na fila', JSON.stringify(upd.params[0]));
  const hist = d.ch.find(c => /INSERT INTO parcela_historico/i.test(c.sql));
  conf(/2 PCs/.test(hist.params[5]) && !/2023PC003998/.test(hist.params[5]),
       'o historico diz 2 PCs e nao inventa as que ficaram de fora');
}

console.log('\n═══ 19. REABRIR TAMBEM E POR PARCELA ═══');
{
  const ENC = [
    { codigo_pc: '2020PC001898', tr: '2020TR000680', parcial_num: '6', setorial_id: 'FCEE', analista_id: 16, entidade: 'APAE', ci_rodada: 1 },
    { codigo_pc: '2020PC002958', tr: '2020TR000680', parcial_num: '6', setorial_id: 'FCEE', analista_id: 16, entidade: 'APAE', ci_rodada: 1 },
  ];
  const d = db(ENC);
  await C.reabrir(d, { setorial_id: 'FCEE', tr: '2020TR000680', parcial_num: '6',
                       texto: 'Voltou pelo SGPe.', autor: { id: 62, nome: 'Marcia' } });
  const sel = d.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/setorial_id = \$1 AND tr = \$2 AND parcial_num = \$3/.test(sel.sql),
       'pela parcela, o alvo e a chave da parcela');
  conf(/ci_situacao = 'encerrado'/.test(sel.sql), 'e so o que esta encerrado');
  const hist = d.ch.filter(c => /INSERT INTO parcela_historico/i.test(c.sql));
  conf(hist.length === 1, 'UMA linha de historico — e UM ato', `${hist.length}`);
  conf(/2 PCs/.test(hist[0].params[4]), 'e ela diz quantas PCs voltaram');

  // ⚠️ A PORTA POR LISTA DE PCs CONTINUA — e' a do script de correcao em lote, cujo alvo
  // nasce de uma lista de processos do SGPe e nao de uma parcela. Se ela sumir, o script de
  // 26/08 deixa de rodar.
  const d2 = db(ENC);
  await C.reabrir(d2, { codigos_pc: ENC.map(p => p.codigo_pc), texto: 'x', autor: { id: 62 } });
  const sel2 = d2.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/codigo_pc = ANY\(\$1\)/.test(sel2.sql), 'pela lista, o alvo e a lista de codigos');
  const hist2 = d2.ch.filter(c => /INSERT INTO parcela_historico/i.test(c.sql));
  conf(hist2.length === ENC.length, 'e ai o historico volta a ser um POR PC', `${hist2.length}`);

  // ⚠️ E OS DOIS CAMINHOS DESEMBOCAM NO MESMO UPDATE. Duas escritas "iguaizinhas" divergem
  // no primeiro ajuste — foi assim que o mapa de nomes curtos chegou a ter tres copias.
  const u1 = d.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql)).sql;
  const u2 = d2.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql)).sql;
  conf(u1 === u2, 'o UPDATE da reabertura e o MESMO nas duas portas');
}

console.log('\n═══ 20. A LISTA E OS NUMEROS CONTAM PARCELA ═══');
{
  const CF = require('./lib/ci-fila');
  const lista = CF.sqlLista("p.ci_situacao = 'na_fila'");
  conf(/GROUP BY p\.setorial_id, p\.tr, p\.parcial_num/.test(lista),
       'a lista agrupa pela chave da parcela');
  conf(/COUNT\(\*\)::int\s+AS n_pcs/.test(lista), 'e devolve quantas PCs tem');
  conf(/array_agg\(p\.codigo_pc ORDER BY p\.codigo_pc\)\s+AS codigos_pc/.test(lista),
       'e QUAIS sao, em ordem estavel');
  conf(/MIN\(p\.dt_envio_ci\)/.test(lista),
       'a espera sai da data MAIS ANTIGA da parcela — quem espera ha mais tempo manda');
  conf(/COUNT\(DISTINCT p\.processo_pc\)::int\s+AS n_processos/.test(lista),
       'onde o dado PODE variar, a linha diz quanto varia em vez de escolher (processo e N:N)');
  conf(/COUNT\(DISTINCT p\.codigo_nl\)::int\s+AS n_nls/.test(lista),
       'idem para a NL — uma NL e quitada por ate 19 PCs');
  conf(/SUM\(\(SELECT COUNT\(\*\) FROM ci_mensagem/.test(lista),
       'e as mensagens SOMAM, porque a conversa continua por PC');

  const contar = CF.sqlContar("p.ci_situacao = 'na_fila'");
  conf(/GROUP BY p\.setorial_id, p\.tr, p\.parcial_num/.test(contar),
       'o total tambem conta parcelas — senao a paginacao compara PCs com um LIMITE de parcelas');
  conf(/COUNT\(DISTINCT/.test(CF.SQL_RESUMO),
       'e os cards/chips contam parcelas: um chip de 1.395 sobre uma lista de 875 e a mesma mentira');
  conf(/AVG\(/.test(CF.SQL_RESUMO),
       'a media de espera continua por PC — ela responde quanto servico esta parado');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
})();
