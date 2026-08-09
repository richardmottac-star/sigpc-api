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
} = require('./lib/busca');

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

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
