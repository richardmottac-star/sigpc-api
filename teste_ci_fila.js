// CAMINHO: sigpc-api/teste_ci_fila.js
//
// A FILA DE TRABALHO DO CONTROLE INTERNO (lib/ci-fila.js). Sem rede e sem banco.
//
// ⚠️ COM DUBLÊ, E NÃO CONTRA O BANCO — armadilha 11 do CLAUDE.md. `assumir`, `devolver` e
// `passar` gerenciam a PRÓPRIA transação: o COMMIT interno delas confirmaria a transação
// externa de um teste, e o ROLLBACK do teste não teria mais o que desfazer. Em 12/08 isso
// gravou 7 PCs e 14 mensagens em produção, num teste que parecia isolado.
//
// O que protege, em uma frase cada:
//   · quem é técnico do C.I. tem UMA fonte — o perfil, nunca uma lista paralela;
//   · a trava de "assumir duas vezes" vive DENTRO do INSERT, não numa leitura antes;
//   · passar é UPDATE, nunca delete-e-insere: a TR não pode ficar órfã no meio;
//   · o motivo é obrigatório nas duas ações que tiram a TR de alguém;
//   · os chips fecham a conta: livres + minhas + com outros = todas.
//
// USO: node teste_ci_fila.js

const CF = require('./lib/ci-fila');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// ⚠️ OS INDICES DE params SEGUEM O SQL_HIST, que tem OITO parametros:
//   0 tr · 1 setorial_id · 2 evento · 3 valor_anterior · 4 valor_novo · 5 analista_id(DONO)
//   6 executado_por(EXECUTOR) · 7 observacao
// O `parcial_num` e NULO fixo no comando e nao consome parametro — foi contando com ele que
// a primeira versao deste teste errou por um em oito checagens.

// Dublê: guarda todo SQL e devolve o que o teste mandar, na ordem.
function db(respostas) {
  const ch = [];
  const fila = [...(respostas || [])];
  const cli = {
    ch,
    query: async (sql, params) => {
      ch.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return fila.length ? fila.shift() : { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { ch, connect: async () => cli, query: cli.query };
}
const sqlDe = (ch) => ch.map(c => c.sql).join(' || ');

const MARCIA  = { id: 62, nome: 'Marcia Terezinha Miranda', perfil: 'controle_interno', ativo: true, papel_ativo: 'analista' };
const ATEM    = { id: 63, nome: 'Atemilson Bispo dos Santos', perfil: 'controle_interno', ativo: true, papel_ativo: 'analista' };
const RICHARD = { id: 4,  nome: 'Richard Motta Coelho', perfil: 'superadmin', papel_ativo: 'tecnico' };
const ANALISTA = { id: 13, nome: 'Gabriele', perfil: 'analista', papel_ativo: 'analista' };

(async () => {

console.log('\n═══ 1. QUEM PODE MEXER NA FILA ═══');
{
  conf(CF.podeAgir(MARCIA) === true, 'tecnico do C.I. pode');
  conf(CF.podeAgir(RICHARD) === true, 'superadmin tambem, sem restricao');
  conf(CF.podeAgir(ANALISTA) === false, 'analista NAO');
  conf(CF.podeAgir(null) === false, 'ninguem logado, ninguem mexe');
  conf(CF.podeAgir({ ...ANALISTA, perfil: 'coordenador' }) === false,
       'coordenador tambem nao — a fila e do C.I.');
  // ⚠️ O SUPERADMIN NO PAPEL ANALISTA E ANALISTA EM TODA PARTE (regra unica de 14/08).
  conf(CF.podeAgir({ ...RICHARD, papel_ativo: 'analista' }) === false,
       'o superadmin no papel analista NAO mexe na fila do C.I.');

  // ⚠️ A FONTE DE "QUEM E DO C.I." E UMA SO — o perfil. Uma lista de ids aqui dentro seria a
  // segunda resposta para a mesma pergunta, e um dia divergiria do cadastro sem erro nenhum.
  conf(/perfil = 'controle_interno'/.test(CF.SQL_TECNICOS), 'a lista de tecnicos sai do PERFIL');
  conf(/ativo = true/.test(CF.SQL_TECNICOS), 'e so os ativos');
  conf(!/\b(62|63|64)\b/.test(CF.SQL_TECNICOS), 'e NAO ha id fixo no codigo');
}

console.log('\n═══ 2. A FILA LE ci_situacao, NUNCA enviado_ci ═══');
{
  // As duas colunas respondem perguntas diferentes: `enviado_ci` diz "foi ao C.I." e sustenta
  // a baixa; `ci_situacao` diz onde a parcela esta no ciclo. Confundi-las foi o defeito que o
  // ciclo do C.I. corrigiu em 12/08.
  conf(/ci_situacao = 'na_fila'/.test(CF.SQL_FILA), 'o WHERE e por ci_situacao = na_fila');
  conf(!/enviado_ci/.test(CF.SQL_FILA), 'e enviado_ci nao aparece na consulta');
  conf(/LEFT JOIN ci_responsavel/.test(CF.SQL_FILA),
       'o responsavel entra por LEFT JOIN — TR sem dono continua na lista');
  conf(/GROUP BY p\.tr/.test(CF.SQL_FILA), 'e a unidade e a TR');
}

console.log('\n═══ 3. ESPERA E FAIXA ═══');
{
  const hoje = new Date(2026, 7, 24);
  conf(CF.diasEspera(new Date(2026, 6, 30), hoje) === 25, '25 dias entre 30/07 e 24/08',
       String(CF.diasEspera(new Date(2026, 6, 30), hoje)));
  conf(CF.diasEspera(null, hoje) === null, 'sem data, sem espera — e nao zero');
  // ⚠️ ARMADILHA 25: o `pg` devolve timestamp como OBJETO Date. Tratar so texto daria NaN.
  conf(CF.diasEspera('2026-07-30T00:00:00.000Z', new Date(2026, 7, 24)) === 25,
       'texto ISO tambem e aceito', String(CF.diasEspera('2026-07-30T00:00:00.000Z', new Date(2026, 7, 24))));
  conf(CF.diasEspera('nao e data', hoje) === null, 'lixo nao vira NaN na tela');

  conf(CF.faixaEspera(0) === 'ok' && CF.faixaEspera(15) === 'ok', 'ate 15 dias e ok');
  conf(CF.faixaEspera(16) === 'atencao' && CF.faixaEspera(30) === 'atencao', '16 a 30 e atencao');
  conf(CF.faixaEspera(31) === 'critica', 'acima de 30 e critica');
  conf(CF.faixaEspera(null) === null, 'sem dias, sem faixa');
}

console.log('\n═══ 4. OS CHIPS FECHAM A CONTA ═══');
{
  const linhas = [
    { tr:'A', pcs:9,  tecnico_id: null, dias_espera: 55 },
    { tr:'B', pcs:1,  tecnico_id: 62,   dias_espera: 10 },
    { tr:'C', pcs:33, tecnico_id: 63,   dias_espera: 40 },
    { tr:'D', pcs:2,  tecnico_id: null, dias_espera: 3  },
  ];
  const r = CF.resumir(linhas, [{ id:62, nome:'Marcia' }, { id:63, nome:'Atemilson' }], 62);
  conf(r.chips.todas === 4, 'todas = 4');
  conf(r.chips.livres === 2, 'livres = 2');
  conf(r.chips.minhas === 1, 'minhas = 1 (a do 62)');
  conf(r.chips.outros === 1, 'com outros = 1');
  // ⚠️ ESTA E A CONTA QUE NAO PODE QUEBRAR: se os tres recortes nao somarem o total, um deles
  // esconde TR — e TR escondida na fila do C.I. e exatamente o que esta tela existe para acabar.
  conf(r.chips.livres + r.chips.minhas + r.chips.outros === r.chips.todas,
       'livres + minhas + com outros = todas');
  conf(r.chips.mais30 === 2, 'mais de 30 dias = 2 (55 e 40)');
  conf(r.total_pcs === 45, 'o cabecalho soma as PCs', String(r.total_pcs));

  // A equipe: um card por tecnico + o "sem responsavel", sempre por ultimo.
  conf(r.equipe.length === 3, 'dois tecnicos + sem responsavel');
  conf(r.equipe[r.equipe.length - 1].tecnico_id === null, 'o "sem responsavel" e o ultimo');
  conf(r.equipe[r.equipe.length - 1].trs === 2, 'e conta as duas livres');
  conf(r.equipe[0].pcs === 1, 'as PCs de cada tecnico sao somadas');
  // Tecnico sem nada continua aparecendo — card que some faz o layout dancar e esconde quem
  // esta livre para pegar trabalho.
  const vazio = CF.resumir([], [{ id:62, nome:'Marcia' }], 62);
  conf(vazio.equipe.length === 2 && vazio.equipe[0].trs === 0, 'tecnico sem TR nenhuma continua no quadro');
}

console.log('\n═══ 5. O MOTIVO ═══');
{
  conf(CF.MOTIVO_MIN === 10, 'o minimo e 10 caracteres');
  conf(!!CF.validarMotivo(''), 'vazio e recusado');
  conf(!!CF.validarMotivo('   '), 'so espaco tambem');
  conf(!!CF.validarMotivo('curto'), 'menos de 10 e recusado');
  conf(/10/.test(CF.validarMotivo('curto')), 'e a mensagem diz quantos faltam');
  conf(CF.validarMotivo('devolvo porque estou de ferias') === null, 'motivo de verdade passa');
  conf(!!CF.validarMotivo('x'.repeat(501)), 'texto absurdo e recusado');
  // ⚠️ O corte e no texto APARADO: dez espacos nao sao um motivo.
  conf(!!CF.validarMotivo('     a     '), 'o corte e sobre o texto aparado');
}

console.log('\n═══ 6. ASSUMIR — a trava vive DENTRO do INSERT ═══');
{
  const d = db([{ rows: [] }, { rows: [{ tr:'2020TR000657', tecnico_id: 62 }] }, { rows: [] }, { rows: [] }]);
  const r = await CF.assumir(d, { tr:'2020TR000657', setorial_id:'FCEE', quem: MARCIA });
  const sql = sqlDe(d.ch);
  conf(/BEGIN/.test(sql), 'abre transacao');
  // ⚠️ SEM ISTO, dois cliques simultaneos passariam os dois por uma conferencia feita FORA do
  // comando. Com o NOT EXISTS dentro do INSERT, o segundo nao acha linha para inserir.
  conf(/INSERT INTO ci_responsavel[\s\S]*WHERE NOT EXISTS/.test(sql),
       'o INSERT carrega a propria trava (NOT EXISTS)');
  conf(!/SELECT[\s\S]*FROM ci_responsavel[\s\S]*BEGIN/.test(sql),
       'e nao ha leitura antes do INSERT para decidir');
  conf(r.ok === true, 'assumiu');
  conf(/INSERT INTO parcela_historico/.test(sql), 'e gravou no historico');
  const pa = d.ch.find(c => /parcela_historico/.test(c.sql)).params;
  conf(pa[2] === 'ci_assumiu', 'com o evento ci_assumiu', String(pa[2]));
  conf(pa[5] === 62 && pa[6] === null, 'dono 62, executor nulo — foi ele mesmo');
  conf(/COMMIT/.test(sql), 'e confirmou');

  // Segunda tentativa: o INSERT nao devolve linha.
  const d2 = db([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ tecnico_id: 63, tecnico_nome: 'Atemilson' }] }]);
  const r2 = await CF.assumir(d2, { tr:'X', setorial_id:'FCEE', quem: MARCIA });
  conf(r2.ok === false, 'a segunda tentativa NAO assume');
  conf(/ROLLBACK/.test(sqlDe(d2.ch)), 'e desfaz');
  conf(r2.jaTem && r2.jaTem.tecnico_nome === 'Atemilson', 'e diz QUEM chegou primeiro');

  // ⚠️ ASSUMIR NAO TOCA NO CICLO. Quem esta com a TR e outra pergunta.
  conf(!/prestacoes_contas|ci_situacao|baixada|enviado_ci/.test(sql),
       'assumir nao menciona prestacoes_contas, ci_situacao, baixada nem enviado_ci');
}

console.log('\n═══ 7. DEVOLVER — a TR volta a ficar livre ═══');
{
  const d = db([{ rows: [] }, { rows: [{ tr:'A', tecnico_id: 62, tecnico_nome:'Marcia' }] }, { rows: [] }, { rows: [] }]);
  const r = await CF.devolver(d, { tr:'A', setorial_id:'FCEE', quem: MARCIA, motivo:'vou entrar de ferias amanha' });
  const sql = sqlDe(d.ch);
  conf(r.ok === true, 'devolveu');
  conf(/DELETE FROM ci_responsavel WHERE tr = \$1 AND setorial_id = \$2/.test(sql),
       'a linha de responsavel e apagada por chave explicita');
  const params = d.ch.find(c => /parcela_historico/.test(c.sql)).params;
  conf(params[2] === 'ci_devolveu', 'o evento e ci_devolveu');
  // ⚠️ AUTORIA DUPLA: o DONO e quem estava com a TR; o EXECUTOR some quando sao o mesmo.
  conf(params[5] === 62, 'o dono da linha e quem estava com a TR');
  conf(params[6] === null, 'e o executor fica NULO quando foi ele mesmo');
  conf(/vou entrar de ferias amanha/.test(params[7]), 'o motivo vai para o historico');

  // Outro tecnico devolvendo a TR de alguem: os dois papeis passam a diferir.
  const d2 = db([{ rows: [] }, { rows: [{ tr:'A', tecnico_id: 62, tecnico_nome:'Marcia' }] }, { rows: [] }, { rows: [] }]);
  await CF.devolver(d2, { tr:'A', setorial_id:'FCEE', quem: ATEM, motivo:'a Marcia esta afastada' });
  const p2 = d2.ch.find(c => /parcela_historico/.test(c.sql)).params;
  conf(p2[5] === 62 && p2[6] === 63, 'devolvida por outro: dono 62, executor 63');
  conf(/por Atemilson/.test(p2[7]), 'e o texto diz quem executou');

  // TR que ja estava livre.
  const d3 = db([{ rows: [] }, { rows: [] }]);
  const r3 = await CF.devolver(d3, { tr:'B', setorial_id:'FCEE', quem: MARCIA, motivo:'qualquer motivo aqui' });
  conf(r3.ok === false && r3.semDono === true, 'TR sem dono nao e "devolvida" duas vezes');
  conf(/ROLLBACK/.test(sqlDe(d3.ch)), 'e desfaz');
}

console.log('\n═══ 8. PASSAR — a TR nunca fica orfa no meio ═══');
{
  const d = db([{ rows: [] }, { rows: [{ tecnico_id: 62, tecnico_nome:'Marcia' }] },
                { rows: [{ tecnico_id: 63 }] }, { rows: [] }, { rows: [] }]);
  const r = await CF.passar(d, { tr:'A', setorial_id:'FCEE', quem: MARCIA, destino: ATEM, motivo:'ela conhece esta entidade' });
  const sql = sqlDe(d.ch);
  conf(r.ok === true, 'passou');
  // ⚠️ INSERT ... ON CONFLICT DO UPDATE, e nao DELETE + INSERT. Entre um e outro, mesmo na
  // mesma transacao, uma falha deixaria a demanda ORFA — o estado que a tela existe para acabar.
  conf(/ON CONFLICT \(tr, setorial_id\) DO UPDATE/.test(sql), 'e um UPDATE por cima, nao um delete-e-insere');
  conf(!/DELETE FROM ci_responsavel/.test(sql), 'nenhum DELETE aparece no caminho de passar');
  conf(/FOR UPDATE/.test(sql), 'a linha e travada antes de trocar de dono');
  const p = d.ch.find(c => /parcela_historico/.test(c.sql)).params;
  conf(p[2] === 'ci_passou', 'o evento e ci_passou');
  conf(p[3] === 'Marcia' && p[4] === 'Atemilson Bispo dos Santos', 'de quem para quem fica gravado');
  conf(p[5] === 63, 'o DONO passa a ser o destino');
  conf(p[6] === 62, 'e o executor e quem clicou');
  conf(/ela conhece esta entidade/.test(p[7]), 'com o motivo');
}

console.log('\n═══ 9. OS ROTULOS DO HISTORICO ═══');
{
  conf(CF.ROTULO_EVENTO.ci_assumiu === 'assumiu a demanda', 'assumiu a demanda');
  conf(CF.ROTULO_EVENTO.ci_devolveu === 'devolveu à fila', 'devolveu a fila');
  conf(CF.ROTULO_EVENTO.ci_passou === 'passou a demanda', 'passou a demanda');
}

console.log('\n═══ 10. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/app\.get\('\/ci\/fila_trabalho'/.test(src), 'GET /ci/fila_trabalho existe');
  ['assumir', 'devolver', 'passar'].forEach(a =>
    conf(new RegExp(`app\\.post\\('/ci/tr/${a}'`).test(src), `POST /ci/tr/${a} existe`));

  // ⚠️ QUEM PEDE E LIDO DO BANCO. Quatro rotas ja confiaram no `perfil` do corpo, e bastava
  // mandar `perfil: 'superadmin'` para passar.
  const g = src.slice(src.indexOf('async function guardaCi'), src.indexOf('async function guardaCi') + 700);
  conf(/lerUsuario\(pool, \(req\.body \|\| \{\}\)\.usuario_id\)/.test(g), 'a guarda le o usuario do BANCO');
  conf(/ciFila\.podeAgir\(quem\)/.test(g), 'e usa a regra unica da lib');

  // ⚠️ O DESTINO TAMBEM E CONFERIDO CONTRA O BANCO. Sem isto, passar a demanda para um
  // analista qualquer a tiraria da fila do C.I. sem sair do ciclo — orfa.
  const p = src.slice(src.indexOf("app.post('/ci/tr/passar'"), src.indexOf("app.post('/ci/tr/passar'") + 1800);
  conf(/lerUsuario\(pool, req\.body\.destino_id\)/.test(p), 'o destino e lido do banco');
  conf(/perfilEfetivo\(d\) !== 'controle_interno'/.test(p), 'e precisa ser tecnico do C.I.');
  conf(/d\.id === g\.quem\.id/.test(p), 'passar para si mesmo e recusado — para isso ha o Assumir');

  // ⚠️ NENHUMA DAS TRES MEXE NO CICLO NEM NA BAIXA.
  const bloco = src.slice(src.indexOf("app.get('/ci/fila_trabalho'"), src.indexOf("app.post('/ci/decidir'"));
  conf(!/UPDATE prestacoes_contas/.test(bloco), 'nenhuma das rotas da fila escreve em prestacoes_contas');
  conf(!/data_baixa|enviado_ci = /.test(bloco), 'e nao mencionam data_baixa nem escrevem enviado_ci');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
})();
