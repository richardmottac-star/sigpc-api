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
    await C.decidir(d, { codigos_pc: PCS.map(p => p.codigo_pc), decisao,
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
  await C.decidir(d, { codigos_pc: ['2020PC000448'], decisao: 'de_acordo', autor: { id: 9 } });
  const u = d.ch.find(c => /^UPDATE prestacoes_contas/i.test(c.sql));
  conf(/ci_situacao = 'encerrado'/.test(u.sql), 'de acordo → encerrado');
  conf(/ci_encerrado_em = NOW\(\)/.test(u.sql), 'e carimba quando');
  conf(/ci_encerrado_por/.test(u.sql), 'e quem');
  conf(!/ci_rodada/.test(u.sql), 'encerrar NAO mexe na rodada');

  const d2 = db(PCS);
  await C.decidir(d2, { codigos_pc: ['2020PC000448'], decisao: 'ressalva', texto: 'Falta o comprovante.', autor: { id: 9 } });
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
  await C.decidir(d, { codigos_pc: ['x'], decisao: 'de_acordo', autor: { id: 9 } });
  const sel = d.ch.find(c => /FOR UPDATE/.test(c.sql));
  conf(/ci_situacao = 'na_fila'/.test(sel.sql), 'a selecao exige estar na fila');
  conf(/FOR UPDATE/.test(sel.sql), 'e trava a linha — dois cliques nao decidem duas vezes');

  const vazio = db([]);
  const r = await C.decidir(vazio, { codigos_pc: ['x'], decisao: 'de_acordo', autor: { id: 9 } });
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

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
})();
