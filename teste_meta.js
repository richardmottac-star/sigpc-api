// CAMINHO: sigpc-api/teste_meta.js
//
// A REGUA DE PRODUTIVIDADE DO GT  (30/09/2026)
//
// ⚠️ O QUE ELE GUARDA: que a regua continue reproduzindo, numero por numero, a tabela do item 3
// do documento REGRA_PRODUTIVIDADE_GT_IMPLANTACAO de 18/09/2026 — o mesmo papel que a
// coordenacao leu e confirmou em 27/09. Qualquer mexida que mude uma dessas 14 linhas esta
// mudando o que foi acordado, e nao corrigindo defeito.
//
// ⚠️ E O MOTIVO DE EXISTIR: o quadro-resumo daquele documento tinha DOIS erros de conta (soma
// 6.336 onde a propria tabela dava 5.918, e dois percentuais calculados sobre populacoes
// diferentes). A regua esta certa; quem errou foi a conta feita a mao por cima dela. Este teste
// e a conta feita a maquina.
//
// USO: node teste_meta.js

const fs = require('fs');
const M = require('./lib/meta');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || detalhe == null ? '' : `   [${detalhe}]`}`);
};
const S = (t) => console.log(`\n═══ ${t} ═══`);

const LIB = fs.readFileSync('./lib/meta.js', 'utf8');
// As checagens de "nao faz X" olham o CODIGO, nunca o comentario — os comentarios desta lib
// citam `metas_analistas` e `meta_mensal` justamente para dizer que ela NAO le de la.
const soCodigo = (txt) => String(txt).split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

S('1. O VALOR DE CADA MES (item B1)');
{
  conf(M.metaDoMes(2025, 7) === 0, 'julho de 2025 ainda nao conta');
  conf(M.metaDoMes(2025, 8) === 12, 'agosto de 2025 vale 12');
  conf(M.metaDoMes(2025, 12) === 12, 'dezembro de 2025 vale 12');
  conf(M.metaDoMes(2026, 1) === 0, 'janeiro de 2026 e ZERO');
  conf(M.metaDoMes(2026, 2) === 10, 'fevereiro de 2026 vale 10');
  conf(M.metaDoMes(2026, 9) === 10, 'setembro de 2026 vale 10');
  // ⚠️ "DE FEVEREIRO EM DIANTE" NAO TEM FIM. A primeira versao devolvia zero para ano > 2026, e
  // em janeiro de 2027 a meta do GT inteiro pararia de crescer sem erro nenhum na tela.
  conf(M.metaDoMes(2027, 3) === 10, 'marco de 2027 continua valendo 10 — a regua nao expira');
  conf(M.metaDoMes(2030, 1) === 10, 'e janeiro de 2027 em diante nao repete o zero de 2026');
}

S('2. O ACUMULADO DE QUEM ESTA DESDE O INICIO');
{
  conf(M.metaAcumulada(null, null, '2026-09-30') === 140, '140 ate setembro de 2026 — o numero do documento');
  // ⚠️ A META SOBE SOZINHA (item 2 do documento). Em outubro sao 150, sem ninguem digitar.
  conf(M.metaAcumulada(null, null, '2026-10-31') === 150, '150 ate outubro de 2026');
  conf(M.metaAcumulada(null, null, '2026-12-31') === 170, '170 ate dezembro de 2026');
  conf(M.metaAcumulada(null, null, '2025-12-31') === 60, '60 ate dezembro de 2025 (cinco meses de 12)');
  conf(M.metaAcumulada(null, null, '2026-01-31') === 60, 'janeiro de 2026 nao acrescenta nada');
}

S('3. A TABELA DO ITEM 3 DO DOCUMENTO, LINHA POR LINHA');
{
  // Nome, entrada, saida, meta que o documento imprime. ⚠️ ESTES 14 NUMEROS SAO O ACORDO.
  const DOC = [
    ['Elquier', null, '2026-01-09', 60],
    ['Guilherme', null, '2026-08-11', 124],
    ['Higor', null, '2026-06-12', 104],
    ['Maria Goreti Korb', null, '2026-08-21', 127],
    ['Marilza', null, '2026-03-02', 71],
    ['Samoel', null, '2026-05-14', 95],
    ['Richard Motta Coelho', '2025-10-09', null, 113],
    ['Willian', '2025-10-14', '2026-08-21', 98],
    ['Scheila Zimmermann Furtado', '2026-01-09', null, 80],
    ['Franciani', '2026-03-02', null, 70],
    ['Eduardo Pizolati', '2026-06-12', null, 36],
    ['Jeisson Klein Garcia', '2026-08-11', null, 17],
    ['Carla Goedert Xavier', '2026-08-21', null, 14],
    ['Fabiana Vieira', '2026-08-21', null, 14],
  ];
  for (const [nome, de, ate, esperado] of DOC) {
    const v = M.metaAcumulada(de, ate, '2026-09-30');
    conf(v === esperado, `${nome}: ${esperado}`, `regua deu ${v}`);
  }
}

S('4. A PROPORCIONAL E POR DIAS SOBRE BASE 30 (itens B6 e C3)');
{
  conf(M.BASE_PROPORCIONAL === 30, 'a base e 30, e nao os dias do mes');
  // Quem entra no dia 1 do mes leva o mes cheio; quem entra no dia 31 leva so aquele dia.
  const cheio = M.metaAcumulada('2026-09-01', null, '2026-09-30');
  const ultimo = M.metaAcumulada('2026-09-30', null, '2026-09-30');
  conf(cheio === 10, 'entrada no dia 1 de setembro leva os 10 do mes');
  conf(ultimo === 0, 'entrada no dia 30 leva 10/30 = 0,33, que arredonda para 0');
  // ⚠️ FEVEREIRO NAO VALE MAIS POR DIA: com base nos dias do mes, 28 dias dariam 10 cheios ali
  // e 10 cheios em marco — a mesma presenca valendo diferente conforme o mes.
  conf(M.metaAcumulada('2026-02-01', null, '2026-02-28') === 9,
    'fevereiro inteiro da 28/30 de 10 = 9, e nao 10');
}

S('5. A META CONGELA NA SAIDA, E O MES SEGUINTE NAO SOMA (itens B4 e B8)');
{
  const sai = M.metaAcumulada(null, '2026-06-12', '2026-09-30');
  const mesmo = M.metaAcumulada(null, '2026-06-12', '2026-12-31');
  conf(sai === mesmo, 'apurar meses depois nao muda a meta de quem ja saiu', `${sai} x ${mesmo}`);
  conf(sai === 104, 'e o numero e o do Higor no documento: 104');
}

S('6. OS QUATRO INFORMADOS PELA COORDENACAO (item B9)');
{
  const ids = Object.keys(M.META_INFORMADA).map(Number).sort((a, b) => a - b);
  conf(ids.join(',') === '52,72,74,75', 'sao exatamente quatro, e sao os do documento');
  conf(M.META_INFORMADA[52].meta === 35 && M.META_INFORMADA[72].meta === 17
    && M.META_INFORMADA[75].meta === 12 && M.META_INFORMADA[74].meta === 12,
    'Eduardo 35, Jeisson 17, Carla 12, Fabiana 12');
  // ⚠️ A EXCECAO GUARDA O NUMERO QUE ELA SUBSTITUI. Sem isso, ninguem consegue dizer, daqui a
  // seis meses, se o 12 da Carla e o calculo ou a informacao — e a excecao vira folclore.
  conf(M.META_INFORMADA[75].calculada === 14 && M.META_INFORMADA[52].calculada === 36,
    'e cada uma registra quanto o calculo daria');
  const datas = M.datasPorPortaria([
    { data_publicacao: '2026-08-21', portaria: '203/2026', dispensado_id: 40, substituto_id: 75 },
  ]);
  const carla = M.metaDe({ id: 75, perfil: 'analista' }, datas, '2026-09-30');
  conf(carla.meta === 12 && carla.meta_calculada === 14, 'na saida vale o informado, com o calculo ao lado');
  conf(carla.informada === true && /B9/.test(carla.origem), 'e a origem diz de onde o numero veio');
}

S('7. AS DATAS VEM DAS PORTARIAS — UMA FONTE SO (item 3)');
{
  const subs = [
    { data_publicacao: '2026-08-21', portaria: '203/2026', dispensado_id: 50, substituto_id: 74 },
    { data_publicacao: '2025-10-14', portaria: '289/2025', dispensado_id: null, substituto_id: 50 },
  ];
  const d = M.datasPorPortaria(subs);
  // ⚠️ UMA DATA, DOIS EFEITOS: a publicacao e entrada do substituto E saida do substituido.
  conf(d[50].entrada === '2025-10-14' && d[50].saida === '2026-08-21',
    'o Willian entra por uma portaria e sai por outra');
  conf(d[74].entrada === '2026-08-21' && d[74].saida === null, 'a Fabiana so tem entrada');
  conf(d[50].portEntrada === '289/2025' && d[50].portSaida === '203/2026',
    'e a portaria de cada ponta viaja junto');
  // ⚠️ A LIB NAO LE BANCO, e isso e o que permite testa-la sem producao.
  conf(!/pool\.|db\.query|SELECT /i.test(soCodigo(LIB)), 'a lib nao consulta banco');
  // ⚠️ E NAO LE AS FONTES VELHAS DE META: `metas_analistas` e `usuarios.meta_mensal` ficam como
  // registro do que valia antes. Duas fontes vivas e a segunda ficando velha (armadilha 29).
  conf(!/metas_analistas|meta_mensal/.test(soCodigo(LIB)), 'e nao le metas_analistas nem meta_mensal');
}

S('8. QUEM E APURADO (item F)');
{
  conf(M.apura({ perfil: 'analista' }) === true, 'o analista e apurado');
  // ⚠️ O SUPERADMIN FICA DENTRO: o documento traz o Richard na tabela do item 3, com meta 113.
  // Tira-lo seria mudar a regua, e isso nao e decisao tecnica.
  conf(M.apura({ perfil: 'superadmin' }) === true, 'o superadmin TAMBEM, por decisao do documento');
  conf(M.apura({ perfil: 'coordenador' }) === false, 'o coordenador nao entra');
  conf(M.apura({ perfil: 'controle_interno' }) === false, 'o Controle Interno nao entra');
  const metas = M.metasDe([
    { id: 1, perfil: 'analista' }, { id: 2, perfil: 'coordenador' },
    { id: 3, perfil: 'controle_interno' }, { id: 4, perfil: 'superadmin' },
  ], [], '2026-09-30');
  conf(Object.keys(metas).sort().join(',') === '1,4', 'a regua so devolve quem e apurado');
  conf(metas[1].meta === 140 && metas[1].desde_o_inicio === true,
    'quem nao tem portaria e integrante desde o inicio, com meta cheia (item 4)');
}

S('9. O MES DE APURACAO CORRENTE');
{
  conf(M.ateHoje('2026-10-05') === '2026-10-31', 'a apuracao vai ate o fim do mes corrente');
  conf(M.ateHoje('2026-02-10') === '2026-02-28', 'e fevereiro termina no dia 28 em 2026');
  conf(M.metaAcumulada(null, null, M.ateHoje('2026-10-05')) === 150,
    'em outubro de 2026 o acumulado e 150, e nao os 140 do papel de setembro');
}

S('10. A ROTA QUE ENTREGA A REGUA');
{
  const SRC = fs.readFileSync('./server.js', 'utf8');
  const i = SRC.indexOf("app.get('/produtividade/regua'");
  // ⚠️ A JANELA TERMINA NUM MARCO DO CODIGO, nunca num numero — armadilha 30.
  const rota = i < 0 ? '' : SRC.slice(i, SRC.indexOf('// ══════════════════════════════════════', i));
  conf(i > 0, 'a rota existe');
  conf(/meta\.metasDe\(/.test(rota), 'ela chama a regua, e nao reimplementa a conta');
  conf(/dispensa\.SQL_SUBSTITUICOES/.test(rota), 'as datas vem das portarias');
  // ⚠️ `metas_analistas` E `meta_mensal` NAO PODEM VOLTAR: elas ficam como registro do que
  // valia antes, e duas fontes vivas e a segunda ficando velha.
  conf(!/metas_analistas|meta_mensal/.test(rota), 'e nao le as fontes velhas de meta');
  conf(/meta\.ateHoje\(\)/.test(rota), 'sem data, apura ate o fim do mes corrente');
  // ⚠️ UMA LEITURA SO para os dois lados: quem e apurado e as portarias que dao as datas.
  conf(/Promise\.all\(/.test(rota), 'le usuarios e portarias no mesmo instante');
  conf(/meta_por_grupo/.test(rota), 'devolve a meta somada por grupo, para o Board nao somar');
  // ⚠️ A REGUA VIAJA COM OS NUMEROS: e o que o botao "Fonte" mostra.
  conf(/regra: \{/.test(rota) && /documento:/.test(rota), 'e manda junto a regra que a produziu');
  conf(!/UPDATE |INSERT |DELETE /.test(rota), 'a rota nao escreve nada');
}

S('11. A LEITURA DO PERIODO, AO LADO DO ACUMULADO (itens C1, D1 e E1)');
{
  conf(M.metaAcumulada(null, null, '2026-09-30', '2026-07-01') === 30, 'o trimestre jul-set/2026 vale 30');
  conf(M.metaAcumulada(null, null, '2025-12-31', '2025-10-01') === 36, 'o trimestre out-dez/2025 vale 36 — eram 12 por mes');
  // ⚠️ JANEIRO DE 2026 E ZERO, e o trimestre que o contem vale 20, nao 30.
  conf(M.metaAcumulada(null, null, '2026-03-31', '2026-01-01') === 20, 'o trimestre jan-mar/2026 vale 20');
  // ⚠️ PEDIR UM PERIODO ANTERIOR AO GT NAO INVENTA META: a janela nunca comeca antes de
  // 01/08/2025, por mais para tras que o relatorio peca.
  conf(M.metaAcumulada(null, null, '2025-09-30', '2025-01-01') === 24, 'periodo que comeca antes do GT vale so o que existia');
  // ⚠️ A JANELA TEM DUAS BORDAS: meio mes vale meio mes.
  conf(M.metaAcumulada(null, null, '2026-09-30', '2026-09-15') === 5, 'de 15 a 30 de setembro vale 5');
  // Quem saiu antes do trimestre nao tem meta nele; quem entrou no meio tem a sua parte.
  conf(M.metaAcumulada(null, '2026-06-12', '2026-09-30', '2026-07-01') === 0, 'quem saiu em junho nao tem meta no trimestre seguinte');
  conf(M.metaAcumulada('2026-08-21', null, '2026-09-30', '2026-07-01') === 14, 'quem entrou em 21/08 tem 14 no trimestre jul-set');
  // O acumulado continua o mesmo quando o recorte comeca no proprio inicio.
  conf(M.metaAcumulada(null, null, '2026-10-05') === M.metaAcumulada(null, null, '2026-10-05', '2025-08-01'),
    'recortar a partir de 01/08/2025 e o mesmo que nao recortar');
}

S('12. A META INFORMADA VALE ATE SETEMBRO, E DEPOIS CRESCE (itens B9 e B4)');
{
  const datas = M.datasPorPortaria([
    { data_publicacao: '2026-06-12', portaria: '122/2026', dispensado_id: 43, substituto_id: 52 },
  ]);
  const set = M.metaDe({ id: 52, perfil: 'analista' }, datas, '2026-09-30');
  const out = M.metaDe({ id: 52, perfil: 'analista' }, datas, '2026-10-31');
  const dez = M.metaDe({ id: 52, perfil: 'analista' }, datas, '2026-12-31');
  conf(set.meta === 35, 'em setembro vale o numero informado: 35');
  // ⚠️ SEM ISTO A META DOS QUATRO CONGELA PARA SEMPRE, enquanto os outros 45 sobem 10 por
  // mes — e o percentual deles subiria sozinho, sem ninguem ter produzido nada.
  conf(out.meta === 45, 'em outubro sobe 10, como a de todo mundo');
  conf(dez.meta === 65, 'e em dezembro ja sao 65');
  conf(set.meta_informada_ate_set === 35, 'o numero informado fica registrado a parte');
  conf(/B9/.test(out.origem) && /B4/.test(out.origem), 'e a origem cita os dois itens que o sustentam');
}

S('13. AS BAIXAS SEM DATA CONFIAVEL (item D2)');
{
  // ⚠️ A LISTA E POR ORIGEM, E NAO POR DATA. Cortar "tudo de junho de 2026" levaria junto a
  // baixa de verdade feita naquele mes — ha 24 assim no acervo.
  conf(M.ORIGENS_SEM_DATA_CONFIAVEL.includes('carga_historica'), 'a carga historica entra na lista');
  conf(M.ORIGENS_SEM_DATA_CONFIAVEL.includes('recarga_parcial_20260805'), 'a recarga de 05/08/2026 tambem');
  conf(M.dataDeBaixaConfiavel({ origem_baixa: 'sistema' }) === true, 'a baixa pelo sistema tem data de trabalho');
  conf(M.dataDeBaixaConfiavel({ origem_baixa: 'secretario' }) === true, 'a do secretario tambem');
  conf(M.dataDeBaixaConfiavel({ origem_baixa: 'import_sigef_30082026' }) === true, 'a importada do SIGEF traz a data do SIGEF');
  conf(M.dataDeBaixaConfiavel({ origem_baixa: 'recarga_parcial_20260805' }) === false, 'a da recarga tem data de CARGA');
  conf(M.dataDeBaixaConfiavel({ origem_baixa: null }) === true, 'sem origem registrada, nao se presume carga');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exitCode = falhou ? 1 : 0;
