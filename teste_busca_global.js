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

// ⚠️ TRES ENTRADAS, E BASTA UMA (31/08/2026). A TR e o processo ganharam caixa propria na
// barra, como nas outras sete telas. Exigir `termo` recusaria com "Digite o que procura."
// quem preencheu a TR — a caixa cheia, e a resposta dizendo que esta vazia.
conf(bg.validar({ tr: '2020TR000704', usuario_id: 4 }) === null, 'so a TR passa, sem termo');
conf(bg.validar({ processo: 'SCC 197/2021', usuario_id: 4 }) === null, 'so o processo passa');
conf(bg.validar({ tr: '2020', processo: 'SCC', usuario_id: 4 }) === null, 'os dois juntos passam');
conf(bg.validar({ termo: '', tr: '', processo: '', usuario_id: 4 }) !== null,
     'as tres vazias recusam');
// ⚠️ O MINIMO DE 2 CARACTERES E SO DO `termo`. Ele existe porque o campo livre varre entidade,
// NL e PC com ILIKE — uma letra traria milhares de TRs e o teto esconderia o resto sem dizer.
// A TR e o processo sao filtros de COLUNA, e o pedaco curto ali e busca legitima.
conf(bg.validar({ tr: '2', usuario_id: 4 }) === null, 'um caractere na TR passa — e filtro de coluna');
conf(bg.validar({ termo: 'a', tr: '2020TR000704', usuario_id: 4 }) !== null,
     'mas o termo curto continua recusado, mesmo com a TR preenchida');

console.log('\n═══ 1b. AS TRES ENTRADAS VIRAM UMA CONDICAO, COM AND ═══');
// ⚠️ AND, E NAO OR — a mesma escolha das outras barras. Quem preenche a TR E o processo esta
// estreitando: com OR, acrescentar um segundo criterio AUMENTARIA o resultado, que e o
// contrario do que uma barra de filtro promete.
{
  const v1 = [];
  const c1 = bg.condicaoAlvo({ tr: '2020TR000704', processo: 'SCC 197/2021' }, v1);
  conf(/ AND /.test(c1), 'TR e processo entram com AND', c1);
  conf(v1.length === 2, 'com um parametro para cada', v1.length);

  const v2 = [];
  const c2 = bg.condicaoAlvo({ termo: 'APAE' }, v2);
  conf(!/ AND /.test(c2), 'so o termo nao inventa AND nenhum');
  conf(v2.length >= 1, 'e leva os parametros do termo', v2.length);

  // ⚠️ OS $n TEM DE BATER COM O TAMANHO DE `valores` — foi o erro medido em 25/08 na fila do
  // C.I.: "bind message supplies N parameters, but prepared statement requires M". O `pg`
  // recusa parametro que a consulta nao usa, e nenhum teste com duble pega isso.
  const v3 = [];
  const c3 = bg.condicaoAlvo({ termo: 'APAE', tr: '2020TR000704', processo: 'SCC 197/2021' }, v3);
  const usados = new Set((c3.match(/\$(\d+)/g) || []).map(x => parseInt(x.slice(1), 10)));
  conf(usados.size === v3.length, 'todo $n declarado e usado, e nenhum sobra',
       'usados=' + usados.size + ' valores=' + v3.length);
  conf(Math.max(...usados) === v3.length, 'e a numeracao vai de 1 ate o ultimo, sem buraco',
       'maior=' + Math.max(...usados) + ' valores=' + v3.length);
  conf((c3.match(/ AND /g) || []).length === 2, 'as tres entradas juntas dao dois ANDs');

  conf(bg.condicaoAlvo({}, []) === null, 'nada informado devolve null');
  conf(bg.condicaoAlvo({ termo: '   ', tr: '  ' }, []) === null, 'e so espaco tambem');
}

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
// ⚠️ A JANELA NAO E MAIS UM NUMERO CHUTADO. Ela era 3600 caracteres, e o caminho restrito do
// repasse (01/09/2026) empurrou metade das conferencias para fora dela — seis passaram a
// FALHAR sem que a rota tivesse defeito nenhum. Uma janela fixa mede o tamanho do arquivo, e
// nao o que a rota faz: agora ela vai ate a proxima rota, que e onde a busca global acaba.
const _iniBG = src.indexOf("app.get('/busca_global'");
const _fimBG = src.indexOf("app.", _iniBG + 40) > 0 ? src.indexOf("\napp.", _iniBG) : src.length;
const rota = src.slice(_iniBG, _fimBG > _iniBG ? _fimBG : src.length);

// ⚠️ Em 14/08 a conferência passou a usar o PERFIL EFETIVO: a busca global é do TÉCNICO do
// sistema, e no papel analista o superadmin leva 403 como qualquer analista.
conf(/papel\.perfilEfetivo\(u\[0\]\) !== 'superadmin'/.test(rota), 'a rota confere o PAPEL ATIVO');
// ⚠️ `data_saida` ENTROU NA CONSULTA em 01/09/2026, e nao e enfeite: o caminho restrito do
// repasse deixa passar COORDENADOR EM EXERCICIO, e "em exercicio" e `data_saida IS NULL` —
// nunca `ativo`, que nos dispensados continua true.
conf(/SELECT id, nome, perfil, grupo, papel_ativo, data_saida FROM usuarios WHERE id/.test(rota),
     'e o perfil vem do BANCO');
conf(/403/.test(rota), 'quem nao e superadmin leva 403');
// ⚠️ O defeito de 09/08: com a busca no mesmo WHERE das agregacoes, as contagens passam a
// ver so as linhas que casaram.
conf(/tr = ANY\(\$1\)/.test(rota), 'as linhas vem por tr = ANY(...), nao pelo termo');
conf(rota.indexOf('condicaoBusca') < rota.indexOf('tr = ANY'),
     'o termo escolhe as TRs ANTES, e depois a TR vem inteira');
// ⚠️ A ROTA PASSOU A CHAMAR A `condicaoAlvo` (31/08/2026), que e quem junta as tres entradas
// com AND — e ela continua reaproveitando a `condicaoBusca` por dentro, para o campo livre.
conf(/bg\.condicaoAlvo\(b, vCasa\)/.test(rota), 'a rota monta a condicao pelas TRES entradas');
conf(/req\.query\.tr/.test(rota) && /req\.query\.processo/.test(rota),
     'e le tr e processo do query, como as outras barras');
// ⚠️ `String(b.termo)` VIRARIA A PALAVRA "undefined" quando a tela manda so as caixas — uma
// busca por entidade chamada "undefined", que nao casa com nada e devolve zero como se a TR
// nao existisse. E o tipo de defeito que nao da erro: a tela diz "Nada encontrado".
conf(/String\(b\.termo \?\? ''\)/.test(rota), 'e o termo ausente nao vira a palavra "undefined"');
conf(/linksDeLinhas/.test(rota), 'e linksDeLinhas para o SGPe');
conf(/MAX_TRS/.test(rota) && /total_trs/.test(rota), 'ha teto, e o total real vai junto');
// a busca NAO escreve nada
conf(!/UPDATE |INSERT |DELETE /.test(rota), 'a rota nao escreve nada');

// ─────────────────────────────────────────────────────────────
secao('11. O CAMINHO RESTRITO DO TERMO DE REPASSE (01/09/2026)');
// ⚠️ A BUSCA GLOBAL CONTINUA EXCLUSIVA DO SUPERADMIN. O que existe agora e uma fresta NOMEADA:
// com `repasse_id`, quem o repasse envolve e a coordenacao em exercicio leem as TRs DAQUELE
// repasse — porque e disso que o termo e feito, e o aviso do sino leva a ele.
conf(/req\.query\.repasse_id/.test(rota), 'a fresta tem nome: repasse_id');
conf(/A busca global e|A busca global é exclusiva do superadmin/.test(rota),
     'sem repasse_id, quem nao e superadmin continua levando 403');
// ⚠️ DUAS TRANCAS, NAO UMA. A primeira e QUEM; a segunda e O QUE — a TR pedida tem de estar
// NAQUELE repasse. Sem a segunda, quem e ponta de um repasse qualquer mandaria o id do seu
// junto com a TR de outra pessoa e leria o acervo inteiro: a guarda pareceria fechada.
conf(/podeVerRepasse\(u\[0\], lote\[0\]\)/.test(rota), 'primeira tranca: QUEM abre o repasse');
conf(/nao faz parte deste repasse|não faz parte deste repasse/.test(rota),
     'segunda tranca: a TR tem de ser DAQUELE repasse');
conf(rota.indexOf('podeVerRepasse') < rota.indexOf('nao faz parte deste repasse') ||
     rota.indexOf('podeVerRepasse') < rota.indexOf('não faz parte deste repasse'),
     'e o QUEM e conferido antes do O QUE');
// ⚠️ O RECORTE E REESCRITO, e nao so conferido: com `repasse_id` a consulta e a TR e nada
// mais. Deixar `termo` e `processo` seguirem junto abriria por fora a porta que o `tr` fechou.
conf(/b\.termo = ''/.test(rota) && /b\.processo = ''/.test(rota),
     'o termo e o processo sao zerados no caminho restrito');
// A guarda mora numa funcao SO — as duas rotas do termo entram pela mesma porta.
conf(/async function podeVerRepasse/.test(src), 'a regra do acesso e uma funcao unica no server.js');
conf((src.match(/podeVerRepasse\(/g) || []).length >= 3,
     'e as duas rotas do termo a chamam', String((src.match(/podeVerRepasse\(/g) || []).length));

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
