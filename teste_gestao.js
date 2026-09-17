// CAMINHO: sigpc-api/teste_gestao.js
//
// A TELA GESTÃO (17/09/2026): a etapa de cada PC e da TR, o prazo pelo CORTE_PRAZO, as contagens
// por ano e quem pode ver a gestão de quem. SEM BANCO E SEM REDE — a regra é a `lib/gestao.js`,
// e as rotas são conferidas pela forma no `server.js`.
//
// USO: node teste_gestao.js

const fs = require('fs');
const path = require('path');
const g = require('./lib/gestao');
const { CORTE_PRAZO } = require('./lib/datas');

let ok = 0, falhou = 0;
const conf = (v, r) => { if (v) { ok++; console.log('  OK    ' + r) } else { falhou++; console.log('  FALHA  ' + r) } };

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. A ETAPA DA PC ===');
// ═══════════════════════════════════════════════════════════════════════════
conf(g.etapaDaPc({ baixada: false }) === 'analise', 'sem baixa → analise');
conf(g.etapaDaPc({ baixada: true, enviado_ci: false, ci_situacao: null }) === 'baixada', 'baixada e nunca foi ao C.I. → baixada');
conf(g.etapaDaPc({ baixada: true, enviado_ci: true, ci_situacao: null }) === 'baixada',
  'enviado_ci sem ci_situacao → baixada (a mesma pergunta do arquivamento)');
conf(g.etapaDaPc({ baixada: true, enviado_ci: false, ci_situacao: 'na_fila' }) === 'baixada',
  'ci_situacao sem enviado_ci → baixada');
conf(g.etapaDaPc({ baixada: true, enviado_ci: true, ci_situacao: 'na_fila' }) === 'no_ci', 'na fila → no_ci');
conf(g.etapaDaPc({ baixada: true, enviado_ci: true, ci_situacao: 'encerrado' }) === 'devolvida', 'encerrado → devolvida');
conf(g.etapaDaPc({ baixada: true, enviado_ci: true, ci_situacao: 'com_analista' }) === 'devolvida', 'com_analista → devolvida');
conf(g.etapaDaPc({ baixada: true, enviado_ci: true, ci_situacao: 'encerrado', arquivada: true }) === 'arquivada', 'arquivada vence tudo');
conf(g.etapaDaPc({ baixada: false, arquivada: true }) === 'arquivada', 'arquivada mesmo sem baixa (a coluna é que diz)');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. A ETAPA DA TR — a PC mais atrasada, sem as arquivadas ===');
// ═══════════════════════════════════════════════════════════════════════════
conf(g.etapaDaTr(['arquivada', 'devolvida']) === 'devolvida', 'arquivada + devolvida → devolvida');
conf(g.etapaDaTr(['arquivada', 'analise', 'no_ci']) === 'analise', 'a mais atrasada manda');
conf(g.etapaDaTr(['arquivada', 'arquivada']) === 'encerrada', 'todas arquivadas → encerrada');
conf(g.etapaDaTr(['no_ci', 'baixada']) === 'baixada', 'baixada vem antes do C.I.');
conf(g.etapaDaTr([]) === 'analise', 'TR sem PC não quebra');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 3. A SITUAÇÃO E A DILIGÊNCIA ===');
// ═══════════════════════════════════════════════════════════════════════════
conf(g.situacaoDaPc({ status: 'diligencia' }) === 'Diligência', 'status diligencia → Diligência');
conf(g.situacaoDaPc({ status: 'analise', situacao_atual: 'Diligência' }) === 'Diligência', 'situacao_atual Diligência → Diligência');
conf(g.situacaoDaPc({ status: 'analise', situacao_atual: 'Aguardando documentação' }) === 'Aguardando documentação', 'situacao_atual manda');
conf(g.situacaoDaPc({ status: 'reanalise' }) === 'Reanálise', 'reanalise sem texto → Reanálise');
conf(g.situacaoDaPc({ status: 'xyz' }) === 'Em análise', 'status desconhecido → Em análise');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 4. O PRAZO — o CORTE_PRAZO vale aqui também ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const hoje = '2026-09-17';
  conf(g.prazoDaPc({ dt_limite_pc: '2023-04-05' }, 'analise', hoje).tipo === 'importado',
    'data antes do corte → importado, NUNCA vencido');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-09-10' }, 'analise', hoje).tipo === 'vencido', 'depois do corte e no passado → vencido');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-09-10' }, 'analise', hoje).dias === -7, 'vencido há 7 dias');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-10-17' }, 'analise', hoje).tipo === 'vence', '30 dias → vence');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-10-18' }, 'analise', hoje).tipo === 'ok', '31 dias → ok');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-09-17' }, 'analise', hoje).tipo === 'vence', 'vence hoje → vence (0 dias)');
  conf(g.prazoDaPc({ dt_limite_pc: null }, 'analise', hoje).tipo === 'sem', 'sem data → sem');
  conf(g.prazoDaPc({ dt_limite_pc: '2026-09-10' }, 'baixada', hoje) === null, 'PC baixada não tem prazo');
  conf(g.prazoDaPc({ dt_limite_pc: CORTE_PRAZO }, 'analise', '2026-09-17').tipo === 'vencido', 'o próprio dia do corte já é prazo');
  conf(g.prazoDaPc({ dt_limite_pc: new Date('2026-09-10T00:00:00Z') }, 'analise', hoje).tipo === 'vencido',
    'Date do pg vira AAAA-MM-DD (armadilha 25)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 5. MONTAR — a resposta inteira ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const base = { setorial_id: 'FCEE', entidade: 'APAE X', grupo: 3, processo_mae: 'SCC 00008411/2019', valor: '100.50' };
  const sit = (pre, setor) => ({ [`${pre}checado_em`]: new Date('2026-09-16T10:00:00Z'), [`${pre}resultado`]: 'OK',
    [`${pre}setor_sigla`]: setor, [`${pre}dias_no_setor`]: 3, [`${pre}desde`]: '2026-09-13' });
  const rows = [
    // TR A: parcial arquivada + final devolvida pronta
    { ...base, ...sit('m_', 'MAE/A'), ...sit('s_', 'CI/A'), tr: '2021TR000001', codigo_pc: 'P1', parcial_num: '1', tipo: 'parcial',
      baixada: true, enviado_ci: true, ci_situacao: 'encerrado', arquivada: true, ultima_mov_br: '2026-09-14',
      arquivamento: { estado: 'arquivada', ci_devolveu_em: '2026-09-09 18:00:00' }, arquivada_em_br: '2026-09-14' },
    { ...base, ...sit('m_', 'MAE/A'), ...sit('s_', 'FINAL/A'), tr: '2021TR000001', codigo_pc: '2021TR000001-PFINAL', parcial_num: 'FINAL', tipo: 'final',
      baixada: true, enviado_ci: true, ci_situacao: 'encerrado', arquivada: false, valor: null, ultima_mov_br: '2026-09-14',
      arquivamento: { estado: 'pronta', ci_devolveu_em: '2026-09-09 18:00:00' } },
    // TR B (2023): duas em análise — uma em diligência vencida, uma importada
    { ...base, tr: '2023TR000002', codigo_pc: 'Q1', parcial_num: '2', tipo: 'parcial', status: 'diligencia',
      baixada: false, dt_limite_pc: '2026-09-01', ultima_mov_br: null, dt_assumida: '2026-08-28 10:00:00' },
    { ...base, tr: '2023TR000002', codigo_pc: 'Q0', parcial_num: '1', tipo: 'parcial', status: 'analise',
      baixada: false, dt_limite_pc: '2023-04-05', dt_assumida: '2026-08-28 10:00:00' },
    // TR C (2023): todas arquivadas
    { ...base, tr: '2023TR000003', codigo_pc: 'R1', parcial_num: '1', tipo: 'parcial', baixada: true, enviado_ci: true,
      ci_situacao: 'encerrado', arquivada: true, ultima_mov_br: '2026-09-15' },
  ];
  const d = g.montar(rows, '2026-09-17');
  const A = d.trs.find((t) => t.tr === '2021TR000001');
  const B = d.trs.find((t) => t.tr === '2023TR000002');
  const C = d.trs.find((t) => t.tr === '2023TR000003');

  conf(d.trs.length === 3, '3 TRs');
  conf(d.trs[0].tr === '2023TR000002' && d.trs[2].tr === '2023TR000003', 'ordem: em análise primeiro, encerrada por último');
  conf(A.etapa === 'devolvida' && B.etapa === 'analise' && C.etapa === 'encerrada', 'etapas das três TRs');
  conf(A.n_parciais === 1 && A.tem_final && A.n_pcs === 2, 'A: 1 parcial + final, 2 PCs');
  conf(A.n_arquivadas === 1 && A.n_baixadas === 2, 'A: 1 arquivada, 2 baixadas');
  conf(A.n_ci_devolvidas === 2 && A.n_no_ci === 0, 'A: o C.I. devolveu as duas (a arquivada conta), nenhuma na fila');
  conf(B.n_ci_devolvidas === 0 && C.n_ci_devolvidas === 1, 'B nunca foi ao C.I.; C tem a arquivada devolvida');
  conf(Math.abs(A.valor_total - 100.5) < 1e-9, 'valor em texto do pg vira número; nulo vira 0');
  conf(A.pcs[0].codigo_pc === 'P1' && A.pcs[1].final, 'a final vem por último');
  conf(A.sgpe_atual && A.sgpe_atual.setor_sigla === 'FINAL/A', 'o SGPe da TR é o da PC que define a etapa');
  conf(A.sgpe_mae && A.sgpe_mae.setor_sigla === 'MAE/A', 'o SGPe da mãe vem separado');
  conf(B.sgpe_atual === null, 'sem linha sincronizada → null, sem quebrar');
  conf(A.pcs[1].ci_devolveu_em === '2026-09-09', 'devolvida em sai só com a data');
  conf(A.dias_parado === 3, 'A parada há 3 dias (última movimentação 14/09)');
  conf(B.ultima_mov === '2026-08-28' && B.dias_parado === 20, 'sem histórico → cai para dt_assumida');
  conf(B.diligencia && B.situacoes.includes('Diligência') && B.situacoes.includes('Em análise'), 'B: situações e diligência');
  conf(B.prazo_proximo && B.prazo_proximo.tipo === 'vencido' && B.prazo_proximo.data === '2026-09-01',
    'prazo mais próximo ignora o importado');
  conf(B.pcs[0].parcial_num === '1', 'parciais em ordem numérica');

  const t = d.contagens.todos;
  conf(t.trs === 3 && t.trs_encerradas === 1 && t.pcs === 5, 'todos: 3 TRs, 1 encerrada, 5 PCs');
  conf(t.analise === 2 && t.devolvida === 1 && t.arquivada === 2 && t.baixada === 0 && t.no_ci === 0, 'todos: funil');
  conf(t.vencidas === 1 && t.vencem === 0 && t.diligencias === 1 && t.prontas === 1, 'todos: vencidas, diligências e prontas');
  conf(t.situacoes['Diligência'] === 1 && t.situacoes['Em análise'] === 1, 'todos: situações');
  conf(d.contagens['2023'].trs === 2 && d.contagens['2021'].trs === 1, 'recorte por ano');
  conf(d.anos[0] === '2023' && d.anos[1] === '2021', 'anos do mais novo para o mais antigo');
  conf(d.corte_prazo === CORTE_PRAZO && d.hoje === '2026-09-17', 'hoje e o corte vão na resposta');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 6. QUEM VÊ A GESTÃO DE QUEM ===');
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const db = { query: async (sql, v) => ({ rows: v[0] === 20 ? [{ grupo: 3 }] : v[0] === 30 ? [{ grupo: 1 }] : [] }) };
  const ana = { id: 4, perfil: 'analista' };
  const sup = { id: 4, perfil: 'superadmin', papel_ativo: 'tecnico' };
  const supAna = { id: 4, perfil: 'superadmin', papel_ativo: 'analista' };
  const coord = { id: 56, perfil: 'coordenador', grupo: 3 };
  const ci = { id: 62, perfil: 'controle_interno' };

  conf((await g.escopo(db, null, null)).status === 401, 'sem usuário → 401');
  conf((await g.escopo(db, ana, null)).analista_id === 4, 'analista sem pedido → a própria');
  conf((await g.escopo(db, ana, 20)).status === 403, 'analista pedindo outro → 403');
  conf((await g.escopo(db, sup, 20)).analista_id === 20, 'superadmin (técnico) vê qualquer um');
  conf((await g.escopo(db, supAna, 20)).status === 403, 'superadmin no papel analista NÃO vê outro (perfil efetivo)');
  conf((await g.escopo(db, coord, 20)).analista_id === 20, 'coordenador vê o do próprio grupo');
  conf((await g.escopo(db, coord, 30)).status === 403, 'coordenador não vê de outro grupo');
  conf((await g.escopo(db, ci, null)).status === 403, 'Controle Interno não tem Gestão');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n=== 7. O SQL ===');
  // ═════════════════════════════════════════════════════════════════════════
  const s = g.SQL_PCS;
  conf((s.match(/LEFT JOIN sgpe_situacao/g) || []).length === 2, 'dois LEFT JOIN com sgpe_situacao (PC e mãe)');
  conf(!/INNER JOIN|\bJOIN sgpe_situacao/.test(s.replace(/LEFT JOIN sgpe_situacao/g, '')), 'nenhum INNER JOIN');
  conf(s.includes('p.analista_id = $1'), 'recorte por analista_id, nunca por nome (armadilha 1)');
  conf(/NOT p\.invalidada/.test(s), 'PC invalidada fica de fora (lib/invalidada)');
  conf(!/CURRENT_DATE/.test(s) && !/CURRENT_DATE/.test(g.SQL_HOJE), 'sem CURRENT_DATE — hoje é HOJE_BR');
  conf((s.match(/AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/Sao_Paulo'/g) || []).length === 3,
    'as três datas UTC passam pelos DOIS AT TIME ZONE (armadilha 18)');
  conf(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(s), 'a leitura não escreve');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n=== 8. AS ROTAS NO server.js ===');
  // ═════════════════════════════════════════════════════════════════════════
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const ig = srv.indexOf("app.get('/gestao'");
  conf(ig > 0, 'GET /gestao existe');
  // ⚠️ A JANELA TERMINA NUM MARCO DO CÓDIGO, nunca no primeiro "});" (armadilha 30 do sigpc-gt).
  const blocoG = srv.slice(ig, srv.indexOf('// POST /parcela/arquivar', ig));
  conf(blocoG.includes('lerUsuario(') && blocoG.includes('gestao.escopo('), 'lê o usuário do banco e confere o escopo');
  conf(blocoG.includes('arquivamento.anexarEstado'), 'o estado do arquivamento é o da lib do arquivamento');
  conf(blocoG.includes('linksDeLinhas('), 'manda os links do SGPe junto');
  conf(!/app\.(get|post)\('\/gestao\/:/.test(srv), 'nenhuma rota /gestao/:param (armadilha 13)');

  const ia = srv.indexOf("app.post('/sgpe/situacao/atualizar'");
  conf(ia > 0 && srv.indexOf("app.get('/sgpe/situacao'") > 0, 'as duas rotas do SGPe existem');
  const blocoA = srv.slice(ia, srv.indexOf("// POST /sgpe/link_manual", ia));
  conf(blocoA.includes('sgpeSit.SQL_GRAVAR_SITUACAO') && blocoA.includes('sgpeSit.SQL_GRAVAR_TRAMITE'),
    'o atualizar grava pelo MESMO SQL do job');
  conf(blocoA.indexOf('ERROS.REDE') < blocoA.indexOf("'BEGIN'"), 'falha de rede responde ANTES de abrir transação — não grava');
  conf(blocoA.includes('SGPE_ATUALIZAR_JANELA_MS') && /2 \* 60 \* 1000/.test(srv), 'dois minutos de cortesia com o portal');
  conf(blocoA.includes('lerUsuario('), 'só usuário identificado atualiza');
  conf(blocoA.includes('chavesDeValores('), 'a chave é a do rodízio');

  console.log(`\n${ok} checagens · ${falhou} falharam\n`);
  process.exitCode = falhou ? 1 : 0;
})();
