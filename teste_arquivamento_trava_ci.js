// CAMINHO: sigpc-api/teste_arquivamento_trava_ci.js
//
// A TRAVA DO PROCESSO QUE AINDA ESTA COM O CONTROLE INTERNO  (23/09/2026)
//
// ⚠️ O QUE ELE GUARDA: que o sistema nao mande arquivar uma parcial cujo processo esta, no
// SGPe, DENTRO do Controle Interno. Ate 23/09/2026 ele mandava: dizia "pronta para arquivar",
// mostrava a pilula verde do acordo e oferecia o botao — sobre processos que o C.I. ainda nao
// tinha devolvido. Medido no mesmo dia pela API de producao: **634 das 797** parciais que o
// sistema chamava de prontas tinham o processo em FCEE/CONIN, em **186 TRs**; o caso que o
// Richard viu estava la havia **167 dias**.
//
// ⚠️ E ARQUIVAR ALI NAO DAVA ERRO — encerrava a parcial e a tirava da lista de trabalho. O
// defeito nao aparecia como defeito: aparecia como tarefa cumprida.
//
// ⚠️ A REGRA MORA NA `bloqueioDeFatos`, que e o unico lugar onde bloqueio se escreve — e e por
// isso que a leitura da tela e a rota `POST /parcela/arquivar` recusam pelo MESMO motivo. Uma
// trava escrita so na tela seria a tela decidindo (armadilha 16), e a rota continuaria aceitando.
//
// USO: node teste_arquivamento_trava_ci.js

const fs = require('fs');
const arq = require('./lib/arquivamento');
const sgpeSit = require('./lib/sgpe-situacao');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

const FONTE = fs.readFileSync('./lib/arquivamento.js', 'utf8');

// Uma PC da parcela, do jeito que a `SQL_PARCELA` entrega para o caminho da ESCRITA.
const pc = (extra) => ({
  codigo_pc: '2020PC003465', tipo: 'parcial', baixada: true, status: 'analise',
  situacao_atual: null, enviado_ci: true, ci_situacao: 'encerrado',
  processo_pc: 'SCC 00008030/2021', sgpe_setor: null, sgpe_setor_nome: null,
  sgpe_dias: null, sgpe_desde: null, ...extra,
});
const NO_CI = { sgpe_setor: 'FCEE/CONIN', sgpe_setor_nome: 'Controle Interno',
                sgpe_dias: 167, sgpe_desde: '2026-04-09' };

// A linha que a `sqlEstado` devolve — os arrays vao vazios porque a regra os le direto.
const linha = (extra) => ({
  s: 'FCEE', t: '2020TR000738', n: '4', n_pcs: 2, tem_final: false, so_final: false,
  arquivada: false, ci_situacao: 'encerrado', ci_col_em: null, ci_ultimo_em: null,
  ci_ultimo_evento: null, tem_tecnico: false, ci_opcao: null, ci_opcao_texto: null,
  dilig: [], nao_baixadas: [], sem_ci: [], na_fila: [], fora: [], com_analista: false,
  n_parciais: 5, n_parciais_arquivadas: 0, pendentes: [], tr_arquivada: false,
  ci_no_sgpe: null, ...extra,
});
const JSONB = { processo: 'SCC 00008030/2021', setor: 'FCEE/CONIN', setor_nome: 'Controle Interno',
                dias: 167, desde: '09/04/2026', lido_em: '23/09/2026 09:04' };

S('1. O SETOR DO C.I. TEM UM DONO SO');
{
  conf(sgpeSit.ehSetorCI('FCEE/CONIN'), 'FCEE/CONIN e setor do C.I.');
  conf(!sgpeSit.ehSetorCI('FCEE/SEPCO'), 'FCEE/SEPCO nao e');
  conf(!sgpeSit.ehSetorCI(null) && !sgpeSit.ehSetorCI(''), 'sem sigla, nao e — e nao estoura');
  conf(sgpeSit.ehSetorCI('fcee/conin'), 'e a comparacao nao depende da caixa');
  // ⚠️ TRES COPIAS DE UM `LIKE '%CONIN%'` DIVERGIRIAM no dia em que a FCEE criasse um segundo
  // setor de controle — e a que ficasse para tras seria justamente a que deixa arquivar.
  conf(!/CONIN/.test(FONTE), 'o arquivamento nao escreve "CONIN" a mao: pergunta a lib');
  conf(!/CONIN/.test(fs.readFileSync('./server.js', 'utf8')), 'nem o server.js escreve');
  conf(sgpeSit.sqlSetorCI('sg.setor_sigla').includes('upper(coalesce(sg.setor_sigla'),
       'e o SQL pergunta a mesma coisa, sobre a expressao dada');
}

S('2. A PARCIAL COM O PROCESSO NO C.I. NAO ARQUIVA');
{
  const m = arq.bloqueio([pc(NO_CI)]);
  conf(!!m, 'ha bloqueio', String(m));
  conf(/Controle Interno no SGPe/.test(m || ''), 'e ele diz onde o processo esta');
  conf(/SCC 00008030\/2021/.test(m || ''), 'com o numero do processo, que e o que se abre no SGPe');
  conf(/09\/04\/2026/.test(m || '') && /167 dias/.test(m || ''), 'desde quando, e ha quantos dias');
  conf(/não devolver/.test(m || ''), 'e o que falta acontecer para destravar');
  // ⚠️ AS IRMAS ARQUIVAM JUNTAS: nao existe arquivar metade da parcela.
  conf(!!arq.bloqueio([pc({}), pc({ codigo_pc: 'B', ...NO_CI })]),
       'basta UMA PC da parcela com o processo no C.I. para travar a parcela');
  conf(arq.bloqueio([pc({ sgpe_setor: 'FCEE/SEPCO', sgpe_dias: 3 })]) === null,
       'o processo ja devolvido a outro setor nao trava');
  const so1 = arq.bloqueio([pc({ ...NO_CI, sgpe_dias: 1 })]);
  conf(/— 1 dia\./.test(so1), 'um dia e "1 dia", nao "1 dias"', so1);
}

S('3. SEM LEITURA DO SGPe, NADA MUDA — nao afirmar o que nao se leu');
{
  conf(arq.bloqueio([pc({})]) === null, 'sem situacao lida, a parcial segue como estava');
  conf(arq.estadoDaLinha(linha({})).estado === 'pronta', 'e o estado continua "pronta"');
  // ⚠️ AFIRMAR QUE ESTA NO C.I. SEM TER LIDO seria o mesmo erro na direcao contraria: travaria
  // o trabalho de quem nao tem processo nenhum parado. Ordem do Richard: nao inventar.
  const semSetor = arq.bloqueio([pc({ sgpe_setor: '', sgpe_dias: 9 })]);
  conf(semSetor === null, 'setor vazio tambem nao trava', String(semSetor));
}

S('4. A ORDEM DAS FRASES — a acionavel primeiro');
{
  // Todas bloqueiam; o que muda e qual frase a pessoa le. "Falta baixar" ela resolve hoje;
  // "o C.I. ainda esta com o processo" e espera.
  const naoBaixada = arq.bloqueio([pc({ ...NO_CI, baixada: false })]);
  conf(/Falta baixar/.test(naoBaixada), 'PC nao baixada fala antes da trava do C.I.', naoBaixada);
  const dil = arq.bloqueio([pc({ ...NO_CI, status: 'diligencia' })]);
  conf(/diligência aberta/.test(dil), 'diligencia aberta, idem');
  const fila = arq.bloqueio([pc({ ...NO_CI, ci_situacao: 'na_fila' })]);
  conf(/fila do Controle Interno/.test(fila), 'na fila do C.I., idem — ja diz que nao devolveu');
  const semCI = arq.bloqueio([pc({ ...NO_CI, enviado_ci: false, ci_situacao: null })]);
  conf(/ainda não foi encaminhada/.test(semCI), 'e a que nunca foi ao C.I. fala por si');
}

S('5. A LEITURA DA TELA BLOQUEIA PELO MESMO MOTIVO');
{
  const e = arq.estadoDaLinha(linha({ ci_no_sgpe: JSONB }));
  conf(e.estado === 'bloqueada', 'a parcial do caso do Richard fica "bloqueada"', e.estado);
  conf(e.motivo === arq.bloqueio([pc(NO_CI)]),
       'e o motivo e IDENTICO ao que a rota devolve — uma regra, dois caminhos');
  // ⚠️ O MOTIVO SOZINHO NAO DA O LINK: a tela precisa do objeto para abrir o SGPe e para dizer
  // de quando e a leitura que sustenta a afirmacao.
  conf(e.ci_no_sgpe && e.ci_no_sgpe.setor === 'FCEE/CONIN', 'o estado leva o setor para a tela');
  conf(e.ci_no_sgpe.dias === 167 && e.ci_no_sgpe.desde === '09/04/2026', 'com dias e desde');
  conf(e.ci_no_sgpe.lido_em === '23/09/2026 09:04', 'e a hora da leitura do SGPe');
  conf(arq.estadoDaLinha(linha({})).ci_no_sgpe === null, 'quem nao esta no C.I. leva null');
  // A deducao da opcao continua igual — ela nao e o que esta em julgamento aqui.
  conf(e.ci_opcao === 'de_acordo' && e.ci_opcao_deduzida === true,
       'a etiqueta da opcao deduzida (22/09) segue como estava');
}

S('6. A PARCIAL JA ARQUIVADA NAO VOLTA A SER BLOQUEADA');
{
  // ⚠️ A PARCIAL JA ARQUIVADA nao pode virar "bloqueada" por causa da trava nova: elas
  // "bloqueada" por causa da trava nova: ela saiu do caminho, e reabrir esse julgamento mudaria
  // o passado na tela de quem ja terminou.
  const e = arq.estadoDaLinha(linha({ arquivada: true, arquivada_em: '2026-09-15', ci_no_sgpe: JSONB }));
  conf(e.estado === 'arquivada', 'arquivada continua arquivada', e.estado);
  conf(e.motivo === null, 'e sem motivo de bloqueio');
}

S('7. O SQL — a escrita ve o setor, e a contagem das PCs nao infla');
{
  conf(/LEFT JOIN sgpe_situacao/.test(arq.SQL_PARCELA),
       'a rota que arquiva le a situacao do SGPe junto com as PCs');
  conf(/FOR UPDATE OF p\b/.test(arq.SQL_PARCELA),
       'e tranca so as PCs: a linha do cache e do job do rodizio, que escreve nela a cada hora');
  const q = arq.sqlEstado('q.tr = $1');
  conf(/arq_sgpe AS \(/.test(q), 'a leitura ganhou a CTE do setor');
  conf(/DISTINCT ON \(q\.setorial_id, q\.tr, q\.parcial_num\)/.test(q),
       'com DISTINCT ON: uma linha por parcela');
  conf(/LEFT JOIN arq_sgpe asg/.test(q), 'presa ao estado por LEFT JOIN — quem nao tem, fica sem');
  // ⚠️ O JOIN NAO PODE MORAR DENTRO DE `arq_parc`: la se faz COUNT(*) AS n_pcs e se montam as
  // listas de codigos. Uma linha de situacao repetida pela chave normalizada multiplicaria as
  // PCs e inflaria numero que a tela mostra — defeito que nao da erro, so numero errado.
  const parc = q.split('arq_parc AS (')[1].split('arq_ci AS (')[0];
  conf(!/sgpe_situacao/.test(parc), 'e a CTE que conta as PCs nao toca em sgpe_situacao', parc.length);
  conf(/COUNT\(\*\)::int AS n_pcs/.test(parc), 'ela continua contando as PCs como antes');
  conf(q.includes(sgpeSit.sqlSetorCI('sg.setor_sigla')), 'o recorte do setor vem da lib, montado');
  // A chave do processo e a mesma dos dois lados — a base escreve `SCC8137/2021` e
  // `SCC 00008137/2021` para o mesmo processo.
  conf((q.match(/regexp_replace\(upper/g) || []).length >= 2,
       'e a comparacao normaliza os DOIS lados da chave');
}

S('8. E O SETOR CHEGA EM CADA PC DA LISTAGEM');
{
  conf(/ci_no_sgpe: e\.ci_no_sgpe/.test(FONTE),
       '`anexarEstado` leva ci_no_sgpe junto do estado (GET /prestacoes_contas?arquivamento=1)');
  conf(/ci_no_sgpe: naoDevolvido\(pcs\)/.test(FONTE), 'e `fatosDe` o monta no caminho da escrita');
  // ⚠️ OS DOIS CAMINHOS ENTREGAM A MESMA FORMA — e o que permite a regra existir uma vez so.
  const viaSQL = arq.estadoDaLinha(linha({ ci_no_sgpe: JSONB })).motivo;
  const viaPC = arq.bloqueio([pc(NO_CI)]);
  conf(viaSQL === viaPC, 'a frase do SQL e a frase das PCs sao a mesma string');
  conf(Object.keys(JSONB).every((k) => FONTE.includes(`'${k}'`) || FONTE.includes(`${k}:`)),
       'e os campos do objeto existem nos dois lados', Object.keys(JSONB).join(','));
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exitCode = falhou ? 1 : 0;
