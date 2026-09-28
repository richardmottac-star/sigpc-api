// CAMINHO: sigpc-api/teste_ci_sgpe.js
//
// A DEVOLUTIVA DO C.I. PROVADA PELA TRAMITACAO DO SGPe  (28/09/2026)
//
// ⚠️ O QUE ELE GUARDA: que este caminho nunca afirme o que o SGPe nao mostra. A analista Clara
// mandou o caso — parcial 1 da 2020TR000764, baixada e com parecer, processo SCC 12315/2020 que
// entrou no FCEE/CONIN em 01/12/2025 e saiu em 02/12/2025 — e o sistema pedia para mandar de
// novo ao C.I., so para eles registrarem o que ja tinham feito dez meses antes.
//
// ⚠️ E A LINHA QUE NAO PODE SER CRUZADA: a tramitacao prova a PASSAGEM, nao o TEOR. Este caminho
// nao grava `ci_opcao`, nao grava tecnico, e o evento tem nome proprio (`ci_pelo_sgpe`) para que
// quem varra o historico atras de decisao do C.I. NAO encontre isto no meio.
//
// USO: node teste_ci_sgpe.js

const fs = require('fs');
const L = require('./lib/ci-sgpe');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

const SRC = fs.readFileSync('./server.js', 'utf8');
const LIB = fs.readFileSync('./lib/ci-sgpe.js', 'utf8');
const t = (linhas, setor) => L.analisarTramitacao(linhas, setor);
// ⚠️ AS CHECAGENS DE 'NAO ESCREVE X' OLHAM O CODIGO, E NAO O COMENTARIO. Tres delas falharam
// na primeira versao porque os comentarios CONTAM a historia — citam o setor do caso da Clara
// e explicam que o evento NAO e o 'ci_decidiu'. Era o teste lendo prosa como se fosse regra.
const soCodigo = (txt) => String(txt).split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

S('1. A TRAMITACAO PROVA, OU NAO PROVA');
{
  const clara = [
    { setor_sigla: 'SCC/NCPN', dt_recebto: '2025-11-01', dt_encaminha: '2025-11-30' },
    { setor_sigla: 'FCEE/CONIN', dt_recebto: '2025-12-01', dt_encaminha: '2025-12-02' },
    { setor_sigla: 'FCEE/SEPCO', dt_recebto: '2025-12-14', dt_encaminha: null },
  ];
  const r = t(clara, 'FCEE/SEPCO');
  conf(r.prova === true, 'o caso da Clara: entrou no C.I. e saiu — prova');
  conf(r.entrada === '2025-12-01' && r.saida === '2025-12-02', 'com as datas REAIS do SGPe', `${r.entrada} → ${r.saida}`);
  // ⚠️ ESTAR NO C.I. AGORA MANDA MAIS QUE QUALQUER PASSAGEM ANTIGA: o processo pode ter ido,
  // voltado e ido de novo, e e a ida de agora que vale.
  const voltou = t([...clara, { setor_sigla: 'FCEE/CONIN', dt_recebto: '2026-09-01', dt_encaminha: null }], 'FCEE/CONIN');
  conf(voltou.prova === false && /AGORA/.test(voltou.motivo), 'foi, voltou e foi de novo: nao prova nada');
  conf(t([{ setor_sigla: 'FCEE/SEPCO', dt_recebto: '2026-01-01' }], 'FCEE/SEPCO').prova === false,
       'nunca passou pelo C.I.: nao prova');
  conf(t([{ setor_sigla: 'FCEE/CONIN', dt_recebto: '2026-04-09', dt_encaminha: null }], 'FCEE/SEPCO').prova === false,
       'entrou e nao ha saida registrada: nao prova');
  conf(t([], null).prova === false, 'sem tramitacao lida: nao prova');
  // ⚠️ E A PASSAGEM QUE VALE E A MAIS RECENTE COM SAIDA.
  const duas = t([
    { setor_sigla: 'FCEE/CONIN', dt_recebto: '2024-01-10', dt_encaminha: '2024-01-20' },
    { setor_sigla: 'FCEE/CONIN', dt_recebto: '2026-03-01', dt_encaminha: '2026-03-05' },
  ], 'FCEE/SEPCO');
  conf(duas.saida === '2026-03-05', 'duas passagens: vale a mais recente', duas.saida);
}

S('2. O SETOR DO C.I. CONTINUA TENDO UM DONO SO');
{
  conf(/require\('\.\/sgpe-situacao'\)/.test(LIB), 'a lib pergunta a `sgpe-situacao` o que e setor do C.I.');
  conf(!/CONIN/.test(soCodigo(LIB)), 'e nao escreve a sigla a mao no codigo');
  conf(t([{ setor_sigla: 'fcee/conin', dt_recebto: '2025-12-01', dt_encaminha: '2025-12-02' }], 'FCEE/SEPCO').prova,
       'a comparacao nao depende da caixa');
}

S('3. O ESTADO DA PARCELA');
{
  const base = { baixada: true, parecer_tipo: 'Regular', ci_situacao: null };
  conf(L.estadoPermite([base]) === null, 'baixada, com parecer e sem C.I.: pode');
  // ⚠️ A PARCELA NA FILA ENTRA — decisao do Richard: sao 270 cujo processo o C.I. ja devolveu no
  // SGPe sem registrar aqui, e deixa-las de fora manteria na mesa deles o que ja saiu.
  conf(L.estadoPermite([{ ...base, ci_situacao: 'na_fila' }]) === null, 'na fila do C.I.: tambem pode');
  conf(!!L.estadoPermite([{ ...base, ci_situacao: 'encerrado' }]), 'ja devolvida no sistema: nao ha o que registrar');
  conf(!!L.estadoPermite([{ ...base, ci_situacao: 'com_analista' }]), 'devolvida com ressalva: idem');
  conf(!!L.estadoPermite([{ ...base, baixada: false }]), 'com PC sem baixa: nao');
  conf(!!L.estadoPermite([{ ...base, parecer_tipo: null }]), 'com PC sem parecer: nao');
  conf(!!L.estadoPermite([{ ...base, arquivada: true }]), 'ja arquivada: nao');
}

S('4. QUEM PODE CLICAR — decisao do Richard, 28/09');
{
  const pcs = [{ analista_id: 9 }];
  conf(L.podeRegistrar({ id: 9 }, 'analista', pcs).pode, 'o analista dono');
  conf(L.podeRegistrar({ id: 4 }, 'superadmin', pcs).pode, 'o superadmin');
  conf(L.podeRegistrar({ id: 56 }, 'coordenador', pcs).pode, 'o coordenador');
  conf(!L.podeRegistrar({ id: 25 }, 'analista', pcs).pode, 'outro analista, nao');
  conf(!L.podeRegistrar(null, 'analista', pcs).pode, 'e sem usuario identificado, nao');
  // Parcela de dono misto: basta UMA de outro dono para o analista nao alcancar.
  conf(!L.podeRegistrar({ id: 9 }, 'analista', [{ analista_id: 9 }, { analista_id: 25 }]).pode,
       'numa parcela de dono misto o analista nao registra sozinho');
}

S('5. O QUE A ESCRITA GRAVA — E O QUE ELA NAO GRAVA');
{
  conf(/ci_situacao = 'encerrado'/.test(L.SQL_REGISTRAR), 'a parcela passa a constar como devolvida');
  // ⚠️ AS DATAS SAO AS DO SGPe, e nao NOW(): o fato aconteceu naquele dia, e datar de hoje
  // inventaria um evento que nao houve.
  conf(/dt_envio_ci = COALESCE\(dt_envio_ci, \$4::date\)/.test(L.SQL_REGISTRAR), 'com a data REAL da entrada no C.I.');
  conf(/ci_encerrado_em = \$6::date/.test(L.SQL_REGISTRAR), 'e a data REAL da saida');
  conf(!/NOW\(\)/.test(L.SQL_REGISTRAR.replace('atualizado_em = NOW()', '')), 'nenhuma outra data e inventada');
  // ⚠️ A LINHA QUE NAO SE CRUZA: a tramitacao prova a passagem, nao o teor.
  conf(!/ci_opcao/.test(L.SQL_REGISTRAR), 'NAO grava a opcao do C.I.');
  conf(!/ci_tecnico/.test(L.SQL_REGISTRAR), 'NAO grava tecnico');
  conf(!/parecer_ci/.test(L.SQL_REGISTRAR), 'NAO grava parecer do C.I.');
  conf(!/SET[sS]*?baixadas*=/.test(L.SQL_REGISTRAR.split('WHERE')[0]), 'e o SET nao toca em baixada');
  conf(/AND baixada = true/.test(L.SQL_REGISTRAR), 'so alcanca PC baixada — a mesma familia de 16/08');
}

S('6. AS DUAS ROTAS');
{
  const get = SRC.slice(SRC.indexOf("app.get('/parcela/ci_sgpe'"), SRC.indexOf("app.post('/parcela/ci_sgpe'"));
  const post = SRC.slice(SRC.indexOf("app.post('/parcela/ci_sgpe'"), SRC.indexOf("app.post('/parcela/ci',"));
  // ⚠️ UM BOTAO QUE SO DESCOBRE O IMPEDIMENTO DEPOIS DO CLIQUE e o beco da armadilha 15.
  conf(get.length > 300 && !/UPDATE |INSERT |BEGIN/.test(get), 'a conferencia le e nao escreve nada');
  conf(/pode: !!\(perm\.pode && !impedimento && prova\.prova\)/.test(get),
       'e `pode` e a conjuncao das tres: quem clica, o estado e a prova');
  // ⚠️ A ESCRITA RELE TUDO: entre a conferencia e o clique, o rodizio pode ter achado o processo
  // de volta no C.I.
  conf(/FOR UPDATE/.test(post), 'a escrita trava as linhas');
  conf(/analisarTramitacao/.test(post), 'e confere a tramitacao DE NOVO, dentro da transacao');
  conf(/evento: 'ci_pelo_sgpe'/.test(post), 'o historico usa evento proprio');
  conf(!/evento: 'ci'/.test(soCodigo(post)) && !/ci_decidiu/.test(soCodigo(post)),
       'e NAO se disfarca de encaminhamento nem de decisao do C.I.');
  conf(/ROLLBACK/.test(post), 'e qualquer recusa desfaz a transacao');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exitCode = falhou ? 1 : 0;
