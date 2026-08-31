// CAMINHO: sigpc-api/teste_busca.js
//
// Testes da normalização de busca (lib/busca.js). Sem rede e sem banco.
//
// O que protege: o mesmo processo está gravado de quatro jeitos no acervo, e quem digita de
// um jeito tem de achar os outros. Antes de 09/08/2026, buscar "SCC 2511" devolvia 0 embora
// "SCC2511/2020" exista em 77 linhas.
//
// USO: node teste_busca.js

const {
  semAcento, chaveProcesso, CHAVE_PROC_SQL, CAMPOS_BUSCA, CAMPOS_PROCESSO, condicaoBusca,
  condicaoTr, condicaoProcesso,
} = require('./lib/busca');
const fs = require('fs');
const path = require('path');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

console.log('\n═══ 1. AS QUATRO GRAFIAS DO ACERVO CONVERGEM ═══');
{
  // Formas reais, medidas em producao:
  //   "SCC 00019172/2020" 6.942 · "ADR2226792017" 5.154 · "ADR03 395/2017" 2.198 · "ADR0108102017" 276
  const grupos = [
    ['SCC 00019172/2020', 'SCC19172/2020', 'SCC 19172/2020', 'scc 19172/2020'],
    ['SCC 00002511/2020', 'SCC2511/2020', 'SCC 2511/2020'],
    ['ADR22 2679/2017', 'ADR2226792017', 'ADR22 00002679/2017'],
    ['ADR20 1233/2017', 'ADR20 00001233/2017', 'ADR20-1233/2017', 'ADR20.00001233/2017'],
    ['FCEE 968/2020', 'FCEE 00000968/2020', 'FCEE968/2020'],
  ];
  for (const g of grupos) {
    const chaves = g.map(chaveProcesso);
    const todosIguais = chaves.every(k => k === chaves[0]);
    conf(todosIguais, `${g.length} grafias de "${g[0]}" dao a mesma chave -> ${chaves[0]}`, chaves.join(' | '));
  }
}

console.log('\n═══ 2. OS CASOS PEDIDOS PELO RICHARD ═══');
{
  // "termo digitado" tem de casar dentro de "como esta gravado".
  const casa = (termo, dado) => chaveProcesso(dado).includes(chaveProcesso(termo));
  conf(casa('SCC 19172/2020', 'SCC 00019172/2020'), '"SCC 19172/2020" acha "SCC 00019172/2020"');
  conf(casa('SCC 00019172/2020', 'SCC 19172/2020'), '"SCC 00019172/2020" acha "SCC 19172/2020"');
  conf(casa('19172', 'SCC 00019172/2020'), '"19172" acha a forma com zeros');
  conf(casa('19172', 'SCC19172/2020'), '"19172" acha a forma sem zeros');
  conf(casa('SCC 2070', 'SCC 00002070/2023'), '"SCC 2070" acha "SCC 00002070/2023"');
  conf(casa('SCC 2511', 'SCC2511/2020'), '"SCC 2511" acha "SCC2511/2020"');
}

console.log('\n═══ 3. A ORDEM DAS ETAPAS — zeros ANTES dos separadores ═══');
{
  // Se os separadores saissem primeiro, "ADR20 00001233" viraria "ADR2000001233" e os zeros
  // deixariam de ser "a esquerda" (passariam a vir depois do 0 de ADR20).
  conf(chaveProcesso('ADR20 00001233/2017') === 'ADR2012332017', 'regiao ADR20 sobrevive aos zeros', chaveProcesso('ADR20 00001233/2017'));
  conf(chaveProcesso('SDR05 00001028/2017') === 'SDR510282017', 'SDR05 tambem (o 0 da regiao e reduzido, mas de forma estavel)', chaveProcesso('SDR05 00001028/2017'));
  conf(chaveProcesso('SDR05 1028/2017') === chaveProcesso('SDR05 00001028/2017'), 'as duas grafias de SDR05 convergem');
}

console.log('\n═══ 4. ZEROS INTERNOS NAO PODEM SUMIR ═══');
{
  conf(chaveProcesso('SCC1000/2020') === 'SCC10002020', '"1000" continua 1000', chaveProcesso('SCC1000/2020'));
  conf(chaveProcesso('SCC 00001000/2020') === 'SCC10002020', 'e a versao com zeros a esquerda da o mesmo');
  conf(chaveProcesso('SCC10203/2020') === 'SCC102032020', 'zero no meio do numero fica', chaveProcesso('SCC10203/2020'));
  conf(chaveProcesso('SCC 0000/2020') === 'SCC02020', 'numero so de zeros vira "0", nao vazio', chaveProcesso('SCC 0000/2020'));
}

console.log('\n═══ 5. LIXO E BORDAS ═══');
{
  conf(chaveProcesso(null) === '', 'null vira vazio');
  conf(chaveProcesso(undefined) === '', 'undefined vira vazio');
  conf(chaveProcesso('') === '', 'vazio vira vazio');
  conf(chaveProcesso('-1') === '1', '"-1" (lixo real do acervo) nao estoura', chaveProcesso('-1'));
  conf(chaveProcesso('   ') === '', 'so espacos vira vazio');
  conf(chaveProcesso('Aguardando protocolo') === 'AGUARDANDOPROTOCOLO', 'texto livre passa sem quebrar');
}

console.log('\n═══ 6. ACENTO ═══');
{
  conf(semAcento('São José') === 'Sao Jose', 'tira acento');
  conf(semAcento('APAE') === 'APAE', 'sem acento passa igual');
  conf(semAcento(null) === '', 'null vira vazio');
}

console.log('\n═══ 7. condicaoBusca — a montagem do WHERE ═══');
{
  const values = [];
  const r = condicaoBusca('SCC 2511', values, 1);
  conf(values.length === 2, 'empurra 2 parametros: o ILIKE e a chave', JSON.stringify(values));
  conf(values[0] === '%SCC 2511%', 'o primeiro e o termo entre %', values[0]);
  conf(values[1] === 'SCC2511', 'o segundo e a chave normalizada', values[1]);
  conf(r.proximo === 3, 'devolve o proximo $N livre', String(r.proximo));
  for (const c of CAMPOS_BUSCA) conf(r.condicao.includes(`${c} ILIKE $1`), `cobre ${c} por ILIKE`);
  for (const c of CAMPOS_PROCESSO) conf(r.condicao.includes(`coalesce(${c},'')`), `cobre ${c} pela chave`);

  // Termo que normaliza para vazio NAO pode entrar na comparacao por chave:
  // `position('' in x)` devolve 1 no Postgres, e casaria todas as linhas.
  const v2 = [];
  const r2 = condicaoBusca('///', v2, 1);
  conf(v2.length === 1, 'termo que vira chave vazia empurra so 1 parametro', JSON.stringify(v2));
  conf(!r2.condicao.includes('position('), 'e NAO gera clausula position()', r2.condicao);

  // O SQL da chave tem de trazer o lookbehind — sem ele, zeros internos seriam comidos.
  conf(CHAVE_PROC_SQL('x').includes('(?<![0-9])'), 'o SQL usa lookbehind para nao comer zero interno');
  conf(CHAVE_PROC_SQL('x').includes("' .-/'"), 'o SQL remove espaco, ponto, hifen e barra');
}

console.log('\n═══ 8. PARIDADE COM O SQL (formas reais do acervo) ═══');
{
  // A prova completa roda contra o banco (8.159 valores distintos, 0 divergencias).
  // Aqui ficam as formas que representam cada bucket, para pegar regressao sem precisar de rede.
  const esperado = {
    'SCC 00019172/2020': 'SCC191722020',
    'ADR2226792017': 'ADR2226792017',
    // ⚠️ o zero da REGIAO tambem cai — "ADR03" vira "ADR3". Nao e descuido: a limpeza nao
    // sabe distinguir regiao de numero, e as duas pontas (JS e SQL) fazem igual, que e o que
    // importa. O efeito colateral e ADR03 e ADR3 colidirem — sao a mesma regional escrita de
    // dois jeitos, entao colidir e o comportamento desejado numa busca.
    'ADR03 395/2017': 'ADR33952017',
    'ADR0108102017': 'ADR108102017',
    'AR19  1727/2017': 'AR1917272017',
    'FCEE 00000968/2020': 'FCEE9682020',
  };
  for (const [v, k] of Object.entries(esperado)) {
    conf(chaveProcesso(v) === k, `"${v}" -> ${k}`, chaveProcesso(v));
  }
  conf(chaveProcesso('ADR03 395/2017') === chaveProcesso('ADR3 395/2017'), 'ADR03 e ADR3 colidem — mesma regional, duas grafias');
}

console.log('\n═══ condicaoTr e condicaoProcesso — os filtros próprios (31/08/2026) ═══');
{
  // ⚠️ AUSENTE OU VAZIO NÃO FILTRA, e devolver `null` é o que garante isso: quem chama só
  // acrescenta condição quando vem algo. Um `''` virando `LIKE '%%'` casaria tudo, o que
  // parece inofensivo e é o começo de um filtro que não filtra.
  for (const vazio of [undefined, null, '', '   ']) {
    conf(condicaoTr(vazio, [], 1) === null, `condicaoTr(${JSON.stringify(vazio)}) não filtra`);
    conf(condicaoProcesso(vazio, [], 1) === null, `condicaoProcesso(${JSON.stringify(vazio)}) não filtra`);
  }
  // E o que não sobra chave também não filtra — `position('' in x)` devolve 1 e casaria tudo.
  conf(condicaoProcesso('///', [], 1) === null, 'processo sem nada aproveitável não filtra');

  {
    const v = [];
    const r = condicaoTr('2021TR000411', v, 1);
    conf(r.condicao === 'tr ILIKE $1', 'a TR é uma condição direta na coluna', r.condicao);
    conf(v[0] === '%2021TR000411%', 'com % dos dois lados, para aceitar o pedaço', v[0]);
    conf(r.proximo === 2, 'e consome UM parâmetro');
  }
  {
    // ⚠️ `%` e `_` do usuário são ESCAPADOS: sem isso, digitar "%" no filtro de TR devolveria
    // o acervo inteiro — um curinga que ninguém pediu.
    const v = [];
    condicaoTr('20%TR_1', v, 1);
    conf(v[0] === '%20\\%TR\\_1%', 'e o curinga digitado é escapado', v[0]);
  }
  {
    const v = [];
    const r = condicaoProcesso('SCC 197/2021', v, 1);
    conf(v[0] === chaveProcesso('SCC 197/2021'), 'o processo vai pela CHAVE, não pelo texto cru', v[0]);
    conf(v[0] === chaveProcesso('SCC197/2021') && v[0] === chaveProcesso('SCC 00000197/2021'),
         'e as quatro grafias do acervo caem na mesma chave');
    // Só os dois campos de processo — nunca entidade, NL ou código de PC.
    for (const c of CAMPOS_PROCESSO) conf(r.condicao.includes(c), `cobre ${c}`);
    for (const c of ['entidade', 'codigo_nl', 'codigo_pc'])
      conf(!r.condicao.includes(c), `e NÃO cobre ${c} — para isso existe o campo livre`);
    conf(r.proximo === 2, 'e consome UM parâmetro');
  }
  {
    // Os três somam, e cada um continua com o seu próprio $N.
    const v = [];
    let i = 1;
    const b = condicaoBusca('creche', v, i); i = b.proximo;
    const t = condicaoTr('2021TR000411', v, i); i = t.proximo;
    const p = condicaoProcesso('SCC 197/2021', v, i); i = p.proximo;
    conf(v.length === i - 1, 'os três empilham parâmetros sem se atropelar', `${v.length} vs ${i - 1}`);
    // ⚠️ Os índices são DERIVADOS, não escritos à mão: o `condicaoBusca` consome um ou dois
    // parâmetros conforme sobre chave do termo, e cravar "$4" aqui faria este teste reprovar
    // no dia em que aquela regra mudasse — por um motivo que não é o desta checagem.
    conf(t.condicao.includes(`$${b.proximo}`), 'a TR usa o $N seguinte ao do busca', t.condicao);
    conf(p.condicao.includes(`$${t.proximo}`), 'e o processo, o seguinte ao da TR', p.condicao);
  }
}

console.log('\n═══ GET /prestacoes_contas/resumo_tr — como a rota usa as três ═══');
{
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/prestacoes_contas/resumo_tr'");
  // ⚠️ O RECORTE PARA NO `const where`, e não num "GROUP BY": um comentário da própria rota
  // cita o GROUP BY, e cortar ali deixava o bloco terminar ANTES do código a conferir — as
  // checagens reprovavam por estarem olhando um pedaço curto, não por defeito no código.
  const bloco = src.slice(i, src.indexOf('const where =', i));

  conf(/const \{ analista_id, setorial_id, busca, tr, processo \} = req\.query/.test(bloco),
       'a rota lê `tr` e `processo` além do `busca`');
  // ⚠️ AND, NUNCA OR: preencher mais campos tem de RESTRINGIR.
  conf(/conditions\.join\(' AND '\)/.test(bloco), 'e as condições se combinam com AND');

  // ⚠️ O PONTO QUE ESTRAGA EM SILÊNCIO: o processo TEM de entrar por subconsulta. Aplicado
  // direto no WHERE de um GROUP BY tr, ele deixaria passar só as LINHAS cujo processo casou,
  // e o `total_pcs` de uma TR de 44 PCs viraria 3. Número menor, plausível e errado.
  conf(/condicaoProcesso\(processo, values, i\)/.test(bloco), 'o processo usa a condição da lib');
  const trechoProc = bloco.slice(bloco.indexOf('condicaoProcesso(processo'));
  conf(/tr IN \(SELECT tr FROM prestacoes_contas WHERE \$\{escopoSub\}\$\{cProc\.condicao\}\)/.test(trechoProc),
       'e entra por SUBCONSULTA, para o GROUP BY continuar contando a TR inteira');
  // A TR não precisa, e o teste diz por quê — todas as linhas da TR têm o mesmo `tr`.
  const trechoTr = bloco.slice(bloco.indexOf('condicaoTr(tr'), bloco.indexOf('condicaoProcesso(processo'));
  conf(/conditions\.push\(cTr\.condicao\)/.test(trechoTr), 'a TR entra direto, sem subconsulta');

  // ⚠️ O ESCOPO VALE DENTRO DA SUBCONSULTA: filtrar não pode revelar TR de fora do recorte.
  conf((bloco.match(/\$\{escopoSub\}/g) || []).length === 2,
       'e o escopo do usuário entra nas DUAS subconsultas', (bloco.match(/\$\{escopoSub\}/g) || []).length);
  // O `busca` não mudou de forma.
  conf(/const r = condicaoBusca\(busca, values, i\)/.test(bloco), 'o `busca` continua exatamente como era');
}

console.log('\n═══ o prefixo de tabela — nem toda consulta tem uma tabela só ═══');
{
  // ⚠️ SEM QUALIFICAR, O POSTGRES ESCOLHE SOZINHO OU RECUSA POR AMBIGUIDADE, e o primeiro
  // caso é o que estraga calado. O C.I. chama a coluna de `p.tr`; o Acompanhamento alcança o
  // processo por `x.` dentro de um EXISTS, porque o histórico não tem essa coluna.
  const v1 = [], v2 = [];
  conf(condicaoTr('2021TR', v1, 1).condicao === 'tr ILIKE $1', 'sem prefixo, a coluna sai nua');
  conf(condicaoTr('2021TR', v2, 1, 'p.').condicao === 'p.tr ILIKE $1', 'com prefixo, sai qualificada');
  const cp = condicaoProcesso('SCC 197/2021', [], 1, 'x.');
  conf(cp.condicao.includes('x.processo_pc') && cp.condicao.includes('x.processo_mae'),
       'e o processo qualifica os DOIS campos', cp.condicao.slice(0, 80));
  conf(!condicaoProcesso('SCC 197/2021', [], 1).condicao.includes('x.'), 'o padrão continua sem prefixo');
}

console.log('\n═══ as outras três rotas — como cada uma liga tr e processo ═══');
{
  const leia = (arq) => fs.readFileSync(path.join(__dirname, arq), 'utf8');
  const src = leia('server.js');

  // ── GET /prestacoes_contas ────────────────────────────────────────────────
  const iPc = src.indexOf("app.get('/prestacoes_contas'");
  const bPc = src.slice(iPc, src.indexOf('const where =', iPc));
  conf(/tr, processo, codigo_pc/.test(bPc), '/prestacoes_contas lê `processo` junto do `tr`');
  conf(/const cTr = condicaoTr\(tr, values, i\)/.test(bPc), 'e o `tr` passou a sair da lib');
  // ⚠️ O `tr = $n` EXATO SAIU. A barra de filtro precisa aceitar o pedaço — só o ano —, e a
  // igualdade devolveria zero calado. Medido em 31/08: das 1.560 TRs do acervo, ZERO são
  // substring de outra, então quem manda o código inteiro recebe as mesmas linhas de antes.
  conf(!/conditions\.push\(`tr = \$/.test(bPc), 'e a igualdade exata não ficou para trás');
  // ⚠️ AQUI SEM SUBCONSULTA, ao contrário da resumo_tr: a lista é de PCs, não agregada.
  conf(/const cProc = condicaoProcesso\(processo, values, i\);\s*\n\s*if \(cProc\) \{ i = cProc\.proximo; conditions\.push\(cProc\.condicao\); \}/.test(bPc),
       'e o processo entra DIRETO, sem subconsulta — não há GROUP BY para estragar');
  conf(/conditions\.join\(' AND '\)/.test(src.slice(iPc, iPc + 4000)), 'os filtros somam com AND');

  // ── GET /ci/fila ──────────────────────────────────────────────────────────
  const ci = leia('lib/ci-fila.js');
  conf(/function montarFiltro\(\{ chip, meuId, q, sgpe, tr, processo, analista_id, espera \}\)/.test(ci),
       '/ci/fila recebe `tr` e `processo`');
  conf(/condicaoTr\(tr, params, params\.length \+ 1, 'p\.'\)/.test(ci), 'com o prefixo `p.`');
  conf(/condicaoProcesso\(processo, params, params\.length \+ 1, 'p\.'\)/.test(ci), 'nos dois');
  // ⚠️ ELES SOMAM COM O `q`, E NÃO COM O `sgpe`. O bloco do `sgpe` tem um `return` antecipado
  // — é o "leve-me a este processo", que ignora o chip por decisão do Richard (25/08) e
  // continua ignorando. Os novos entram DEPOIS dele: são as caixas da barra de filtro, que
  // estreitam o recorte aberto. Se entrassem antes, mudariam o `sgpe` sem ninguém pedir.
  const iSg = ci.indexOf('if (sgpe) {'), iTr = ci.indexOf('condicaoTr(tr, params');
  conf(iSg > 0 && iTr > iSg, 'e entram DEPOIS do return antecipado do `sgpe`');
  conf(/const t = String\(q \?\? ''\)\.trim\(\);/.test(ci), 'o `q` continua exatamente como era');

  // ── GET /acompanhamento ───────────────────────────────────────────────────
  const ac = leia('lib/acompanhamento.js');
  conf(/condicaoTr\(q\.tr, params, params\.length \+ 1, 'h\.'\)/.test(ac),
       '/acompanhamento passou a usar a lib no `tr`, com o prefixo `h.`');
  conf(!/h\.tr ILIKE \$\{p\$\('%' \+ String\(q\.tr\)/.test(ac), 'e a regra escrita à mão saiu');
  // ⚠️ O PROCESSO ATRAVESSA POR `EXISTS`: o histórico guarda (tr, parcial_num) e NÃO tem
  // processo. Com um JOIN a linha do histórico se multiplicaria por PC da parcela.
  conf(/condicaoProcesso\(q\.processo, params, params\.length \+ 1, 'x\.'\)/.test(ac),
       'e o processo entra com o prefixo `x.`');
  conf(/EXISTS \(SELECT 1 FROM prestacoes_contas x[\s\S]{0,200}\$\{cProc\.condicao\}\)/.test(ac),
       'dentro de um EXISTS, e não de um JOIN');
  conf(/const t = String\(q\.q \?\? ''\)\.trim\(\);/.test(ac), 'a busca livre `q` continua igual');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
