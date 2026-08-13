// CAMINHO: sigpc-api/teste_busca_global.js
//
// BUSCA GLOBAL — a regra de montagem do card e as travas. Sem rede e sem banco.
// A prova contra o Postgres é outra: `_banco_bg.js`, que sobe o Express e chama a rota.

const fs = require('fs');
const bg = require('./lib/busca-global');

let ok = 0, falhou = 0;
const conf = (c, n) => { c ? (ok++, console.log('  OK    ' + n)) : (falhou++, console.log('  FALHA  ' + n)); };
const secao = t => console.log('\n═══ ' + t + ' ═══');

const pc = (o) => ({
  // ⚠️ `'nl' in o`, e não `o.nl ?? padrão`: `null ?? x` devolve x, então a PC final — que
  // TEM de vir com NL nula — recebia a NL padrão e o teste passava por engano.
  codigo_pc: o.c, codigo_nl: ('nl' in o ? o.nl : '2020NL000001'), tipo: o.tipo || 'parcial', tr: o.tr || 'TR1',
  parcial_num: o.pn ?? '1', processo_pc: o.proc || 'SCC 1/2020', processo_mae: 'SCC 9/2020',
  entidade: 'APAE', cnpj_cpf: '00.000.000/0001-00', status: o.st || 'analise',
  situacao_atual: null, parecer_tipo: o.par ?? null, baixada: !!o.bx,
  analista_id: o.aid === undefined ? 36 : o.aid, analista_nome: o.aid === null ? null : 'Claudia',
  grupo: o.aid === null ? null : 3, dt_assumida: o.assum ?? null, dt_inicio_analise: o.ini ?? null,
  dt_limite_pc: o.lim ?? null, ci_situacao: o.ci ?? null, ci_rodada: o.rod ?? 0,
  dt_envio_ci: o.dtci ?? null, ci_encerrado_em: null,
});
const HOJE = '2026-08-13';

// ─────────────────────────────────────────────────────────────
secao('1. VALIDACAO');
conf(bg.validar({ termo: '2020TR000704', usuario_id: 4 }) === null, 'termo e usuario passam');
conf(bg.validar(null) !== null, 'corpo vazio recusado');
conf(bg.validar({ usuario_id: 4 }) !== null, 'sem termo recusa');
conf(bg.validar({ termo: 'a', usuario_id: 4 }) !== null, 'termo de 1 letra recusa');
conf(bg.validar({ termo: '  ', usuario_id: 4 }) !== null, 'termo so de espaco recusa');
conf(bg.validar({ termo: 'ab', usuario_id: 4 }) === null, '2 caracteres passam');
conf(bg.validar({ termo: 'ab' }) !== null, 'sem usuario_id recusa');

// ─────────────────────────────────────────────────────────────
secao('2. A SITUACAO DA TR');
conf(bg.situacaoTr({ com_dono: 0, pcs: 3, baixadas: 0, no_ci: 0 }).chave === 'livre', 'sem dono: no estoque');
conf(bg.situacaoTr({ com_dono: 3, pcs: 3, baixadas: 3, no_ci: 0 }).chave === 'concluida', 'tudo baixado: concluida');
conf(bg.situacaoTr({ com_dono: 3, pcs: 3, baixadas: 1, diligencia: 1, no_ci: 0 }).chave === 'diligencia', 'diligencia');
conf(bg.situacaoTr({ com_dono: 3, pcs: 3, baixadas: 1, reanalise: 1, no_ci: 0 }).chave === 'reanalise', 'reanalise');
conf(bg.situacaoTr({ com_dono: 3, pcs: 3, baixadas: 1, no_ci: 0 }).chave === 'analise', 'em analise');
// ⚠️ O C.I. vem ANTES de "concluida": encaminhar ao C.I. ja conta como baixa, entao uma TR
// toda baixada com PC no ciclo apareceria como concluida — e o que importa e' que ela esta
// pendurada no Controle Interno.
conf(bg.situacaoTr({ com_dono: 3, pcs: 3, baixadas: 3, no_ci: 1 }).chave === 'ci',
     'C.I. vem antes de concluida, mesmo com tudo baixado');

// ─────────────────────────────────────────────────────────────
secao('3. O PRAZO ANTIGO NAO PASSA');
// ⚠️ O `pg` devolve `date` como OBJETO Date. String(d).slice(0,10) num Date da "Thu Mar 31",
// que compara como texto contra "2026-08-01" e PASSA no corte. Foi assim que a busca mostrou
// 9.221 dias de atraso sobre um prazo que nao deveria nem aparecer.
conf(bg.prazoVisivel(new Date('2022-03-31'), HOJE) === null, 'Date antigo (objeto) e barrado');
conf(bg.prazoVisivel('2022-03-31', HOJE) === null, 'string antiga e barrada');
conf(bg.prazoVisivel(null, HOJE) === null, 'sem data, sem prazo');
{
  const p = bg.prazoVisivel(new Date('2026-08-05'), HOJE);
  conf(p && p.data === '2026-08-05', 'data posterior ao corte aparece');
  conf(p && p.vencido && p.dias_atraso === 8, 'e conta 8 dias de atraso');
}
{
  const p = bg.prazoVisivel('2026-09-01', HOJE);
  conf(p && !p.vencido && p.dias_atraso === 0, 'data futura nao esta vencida');
}
conf(bg.CORTE_PRAZO === '2026-08-01', 'o corte e o MESMO do sino (job_notificacoes)');
conf(bg.paraIso(new Date('2022-03-31')) === '2022-03-31', 'paraIso resolve o objeto Date');
conf(bg.paraIso('lixo') === null, 'e recusa o que nao e data');

// ─────────────────────────────────────────────────────────────
secao('4. UM CARD POR TR, COM A TR INTEIRA');
{
  const rows = [
    pc({ c: '2020PC000001', pn: '1' }),
    pc({ c: '2020PC000002', pn: '2', bx: true, st: 'baixada' }),
    pc({ c: '2020PC000003', pn: '3', st: 'diligencia' }),
    pc({ c: 'TR1-PFINAL', tipo: 'final', nl: null, pn: 'FINAL' }),
  ];
  // so UMA casou — como quando se busca uma PC
  const cards = bg.montarCards(rows, new Set(['2020PC000002']), HOJE);
  conf(cards.length === 1, 'um card');
  const c = cards[0];
  conf(c.total_pcs === 4, 'a TR vem INTEIRA (4 PCs), nao so a que casou');
  conf(c.total_parciais === 3, 'e 3 parciais — a final NAO conta como parcial');
  conf(c.baixadas === 1 && c.faltam === 3, 'baixadas e faltam batem');
  conf(c.parciais_casaram === 1, 'uma parcial destacada');
  conf(c.parciais.length === 4, 'mas as 4 linhas aparecem');
  conf(c.parciais[c.parciais.length - 1].final === true, 'e a final vem por ULTIMO');
  conf(c.parciais.find(p => p.final).pcs[0].codigo_nl === null, 'a final nao tem NL');
}

secao('5. O CODIGO DA PC VAI COMPLETO');
{
  const rows = [pc({ c: '2018PC000015' }), pc({ c: '2018TR000093-PFINAL', tipo: 'final', nl: null, pn: 'FINAL' })];
  const c = bg.montarCards(rows, new Set(), HOJE)[0];
  const todos = c.parciais.flatMap(p => p.pcs).map(x => x.codigo_pc);
  conf(todos.includes('2018PC000015'), 'a parcial sai com os 12 caracteres');
  conf(todos.includes('2018TR000093-PFINAL'), 'e a final com os 19, sem truncar');
}

secao('6. A NL EM VARIAS PARCIAIS — UM CARD SO');
{
  // Medido: das 9.933 NLs, ZERO atravessam TR ou analista. 2.351 se espalham por varias
  // parciais DA MESMA TR (max. 17). Entao nunca ha ambiguidade a resolver.
  const rows = [];
  for (let i = 1; i <= 17; i++) rows.push(pc({ c: '2022PC00000' + i, pn: String(i), nl: '2022NL008336' }));
  rows.push(pc({ c: 'TR1-PFINAL', tipo: 'final', nl: null, pn: 'FINAL' }));
  const cards = bg.montarCards(rows, new Set(rows.filter(r => r.codigo_nl === '2022NL008336').map(r => r.codigo_pc)), HOJE);
  conf(cards.length === 1, 'UM card, com as 17');
  conf(cards[0].parciais_casaram === 17, 'as 17 parciais destacadas');
  conf(cards[0].parciais.length === 18, 'e a final aparece junto, sem destaque');
  conf(cards[0].parciais.some(p => p.final && !p.casou), 'a final nao esta destacada');
}

secao('7. SEM ANALISTA');
{
  const rows = [pc({ c: 'A', aid: null }), pc({ c: 'B', aid: null })];
  const dev = new Map([['TR1', '2026-08-10']]);
  const c = bg.montarCards(rows, new Set(), HOJE, dev)[0];
  conf(c.analista_nome === null, 'nao inventa analista');
  conf(c.situacao.chave === 'livre', 'e a situacao e "No estoque"');
  conf(c.no_estoque_desde === '2026-08-10', 'com a data da devolucao');
  // ⚠️ TR que NUNCA teve dono nao tem "desde quando": inventar a data da carga seria mostrar
  // um numero que nao quer dizer o que parece.
  const c2 = bg.montarCards(rows, new Set(), HOJE, new Map())[0];
  conf(c2.no_estoque_desde === null, 'sem devolucao registrada, nao inventa data');
}

secao('8. AS DATAS DA TR');
{
  const rows = [
    pc({ c: 'A', assum: '2026-08-05', ini: '2026-08-06' }),
    pc({ c: 'B', pn: '2', assum: '2026-08-01', ini: '2026-08-02' }),
  ];
  const c = bg.montarCards(rows, new Set(), HOJE)[0];
  conf(String(c.dt_assumida).slice(0, 10) === '2026-08-01', 'a assuncao e a MAIS ANTIGA da TR');
  conf(c.dias_em_analise === 11, 'e os dias contam do inicio mais antigo');
}

secao('9. O BLOCO DO C.I.');
{
  const rows = [
    pc({ c: 'A', ci: 'na_fila', rod: 1, dtci: '2026-08-10', bx: true }),
    pc({ c: 'B', pn: '2' }),
  ];
  const c = bg.montarCards(rows, new Set(), HOJE)[0];
  conf(c.no_ci === 1, 'conta as PCs no ciclo');
  conf(c.situacao.chave === 'ci', 'e a TR aparece como "No Controle Interno"');
  const comCi = c.parciais.filter(p => p.ci);
  conf(comCi.length === 1 && comCi[0].ci.situacao === 'na_fila', 'a parcial traz o ponto do ciclo');
}

// ─────────────────────────────────────────────────────────────
secao('10. TRAVAS NO server.js');
const src = fs.readFileSync('./server.js', 'utf8');
const rota = src.slice(src.indexOf("app.get('/busca_global'"), src.indexOf("app.get('/busca_global'") + 3600);

conf(/perfil !== 'superadmin'/.test(rota), 'a rota confere superadmin');
conf(/SELECT id, nome, perfil FROM usuarios WHERE id/.test(rota), 'e o perfil vem do BANCO');
conf(/403/.test(rota), 'quem nao e superadmin leva 403');
// ⚠️ O defeito de 09/08: com a busca no mesmo WHERE das agregacoes, as contagens passam a
// ver so as linhas que casaram.
conf(/tr = ANY\(\$1\)/.test(rota), 'as linhas vem por tr = ANY(...), nao pelo termo');
conf(rota.indexOf('condicaoBusca') < rota.indexOf('tr = ANY'),
     'o termo escolhe as TRs ANTES, e depois a TR vem inteira');
conf(/bg\.condicaoBusca/.test(rota) || /condicaoBusca/.test(rota), 'reaproveita condicaoBusca');
conf(/linksDeLinhas/.test(rota), 'e linksDeLinhas para o SGPe');
conf(/MAX_TRS/.test(rota) && /total_trs/.test(rota), 'ha teto, e o total real vai junto');
// a busca NAO escreve nada
conf(!/UPDATE |INSERT |DELETE /.test(rota), 'a rota nao escreve nada');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
