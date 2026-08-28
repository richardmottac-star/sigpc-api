// CAMINHO: sigpc-api/teste_dispensa.js
//
// A DISPENSA DE ANALISTAS — a regra mora em `lib/dispensa.js`, e e ela que se testa.
//
// USO: node teste_dispensa.js

const fs = require('fs');
const d = require('./lib/dispensa');

let ok = 0, falhou = 0;
const conf = (x, r, det) => { x ? ok++ : falhou++; console.log(`  ${x ? 'OK  ' : 'FALHA'}  ${r}${x || !det ? '' : `   [${det}]`}`); };
const secao = (t) => console.log(`\n=== ${t} ===`);

const ATIVO = { id: 7, nome: 'Aline', ativo: true, data_saida: null, portaria: null };
const DISP = { id: 48, nome: 'Samoel', ativo: true, data_saida: '2026-05-14', portaria: '95/2026' };

secao('1. QUEM ESTA DISPENSADO');
{
  conf(d.ehDispensado(DISP) === true, 'quem tem data_saida esta dispensado');
  conf(d.ehDispensado(ATIVO) === false, 'quem nao tem, nao esta');
  conf(d.ehDispensado(null) === false, 'ninguem nao esta dispensado');
  conf(d.ehDispensado({ data_saida: '' }) === false, 'string vazia nao e data');
  // ⚠️ A RESPOSTA E UMA COLUNA, E SO UMA. `ativo` continua true no dispensado — decisao do
  // Richard, porque ele precisa terminar o que ficou em curso. Deduzir a dispensa de `ativo`
  // marcaria como dispensado quem so foi desativado por outro motivo, e vice-versa.
  conf(d.ehDispensado({ ...ATIVO, ativo: false }) === false,
       'ativo = false NAO significa dispensado');
  conf(d.ehDispensado({ ...DISP, ativo: true }) === true,
       'e o dispensado continua ativo — as duas coisas convivem');
  conf(d.ehDispensado({ data_saida: new Date(2026, 4, 14) }) === true, 'um objeto Date tambem conta');
}

secao('2. A META');
{
  conf(d.contaMeta(ATIVO) === true, 'o analista em atividade entra na conta de meta');
  conf(d.contaMeta(DISP) === false, 'o dispensado NAO entra');
  // ⚠️ Nao entrar na conta e diferente de sumir. Os numeros continuam atribuidos a ele, e a
  // linha em `metas_analistas` continua la — apagar reescreveria o passado.
  conf(d.contaMeta({ ...DISP, ativo: false }) === false, 'e continua fora se for desativado');
  conf(d.contaMeta(ATIVO) === !d.ehDispensado(ATIVO), 'a meta e o inverso exato da dispensa');
  conf(d.contaMeta(DISP) === !d.ehDispensado(DISP), 'nos dois casos');
}

secao('3. AS DATAS');
{
  // ⚠️ ARMADILHA 25: o `pg` devolve `date` como objeto Date, e `String(d).slice(0,10)` daria
  // "Thu May 14" — que comparado como texto e MAIOR que qualquer "2026-..".
  conf(d.paraIso(new Date(2026, 4, 14)) === '2026-05-14', 'um Date vira ISO de verdade');
  conf(d.paraIso('2026-05-14') === '2026-05-14', 'e uma string ISO passa direto');
  conf(d.paraIso('2026-05-14T03:00:00.000Z') === '2026-05-14', 'timestamp e cortado no dia');
  conf(d.paraIso(null) === null, 'nulo continua nulo');
}

secao('4. O INDICE DE SUBSTITUICOES');
{
  const linhas = [
    { id: 1, dispensado_id: null, dispensado_nome: 'Caroline', substituto_id: 50, substituto_nome: 'Willian' },
    { id: 2, dispensado_id: 50, dispensado_nome: 'Willian', substituto_id: null, substituto_nome: 'Fabiana' },
    { id: 3, dispensado_id: 48, dispensado_nome: 'Samoel', substituto_id: 56, substituto_nome: 'Gustavo' },
  ];
  const { porDispensado, porSubstituto } = d.indexar(linhas);

  // ⚠️ AS LINHAS COM id NULO FICAM DE FORA DOS INDICES, e e o certo: nao ha cadastro a quem
  // pregar a tag. Casar por NOME aqui seria a armadilha 1 de volta, com dado de pessoal.
  conf(!porDispensado.has(null) && !porSubstituto.has(null), 'id nulo nao vira chave');
  conf(porDispensado.size === 2, 'so os dispensados COM id entram', String(porDispensado.size));
  conf(porSubstituto.size === 2, 'so os substitutos COM id entram', String(porSubstituto.size));

  // ⚠️ O WILLIAN E AS DUAS COISAS: entrou no lugar da Caroline e saiu substituido pela
  // Fabiana. Um indice que guardasse so a ultima apagaria metade da historia dele.
  conf(porDispensado.has(50) && porSubstituto.has(50), 'o Willian aparece nos DOIS indices');
  conf(porSubstituto.get(50)[0].dispensado_nome === 'Caroline', 'como substituto, da Caroline');
  conf(porDispensado.get(50)[0].substituto_nome === 'Fabiana', 'e como dispensado, pela Fabiana');

  // O valor e uma LISTA: uma pessoa pode substituir mais de uma.
  conf(Array.isArray(porSubstituto.get(56)), 'o valor do indice e uma lista');
  const dupla = d.indexar([...linhas,
    { id: 4, dispensado_id: 29, dispensado_nome: 'Marilza', substituto_id: 56, substituto_nome: 'Gustavo' }]);
  conf(dupla.porSubstituto.get(56).length === 2, 'quem substitui duas pessoas tem DUAS linhas');

  conf(d.indexar(null).porDispensado.size === 0, 'nada nao indexa nada');
  conf(d.indexar([]).porSubstituto.size === 0, 'lista vazia tambem nao');
}

secao('5. O SQL');
{
  // ⚠️ ORDEM COM DESEMPATE: a 203/2026 dispensou DUAS pessoas no mesmo dia, e sem o desempate
  // por id a listagem trocaria de ordem entre dois pedidos iguais.
  conf(/ORDER BY data_publicacao DESC, id DESC/.test(d.SQL_SUBSTITUICOES), 'a ordem tem desempate por id');
  conf(/data_publicacao::text/.test(d.SQL_SUBSTITUICOES), 'a data sai como TEXTO, nao como Date (armadilha 25)');
  conf(/FROM substituicao/.test(d.SQL_SUBSTITUICOES), 'le da tabela substituicao');
  // Nada de escrita nesta lib.
  for (const proibido of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP']) {
    conf(!new RegExp(proibido).test(d.SQL_SUBSTITUICOES), `o SQL nao contem ${proibido}`);
  }
}

secao('6. A LIB E O SERVER');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/require\('\.\/lib\/dispensa'\)/.test(src), 'o server usa a lib');
  conf(/app\.get\('\/substituicao'/.test(src), 'e expoe GET /substituicao');
  // ⚠️ SEM ROTA DE ESCRITA. As linhas entram por script de migracao, com dry-run e
  // conferencias: sao ato administrativo, nao dado que alguem digita na tela.
  conf(!/app\.(post|patch|put|delete)\('\/substituicao/.test(src),
       'e NAO ha rota de escrita em /substituicao');
  const i = src.indexOf("app.get('/substituicao'");
  const bloco = i < 0 ? '' : src.slice(i, i + 1200);
  // A tela nao pode quebrar num ambiente sem a migracao de 28/08.
  conf(/does not exist/.test(bloco), 'a rota devolve lista vazia se a tabela nao existir');
  conf(/dispensa\.SQL_SUBSTITUICOES/.test(bloco), 'e o SQL vem da lib, nao copiado');
}

secao('7. A TELA');
{
  const html = fs.readFileSync('../sigpc-gt/index.html', 'utf8');
  conf(/function ehDispensado\(u\)/.test(html), 'a tela tem o predicado da dispensa');
  conf(/function contaMeta\(u\)/.test(html), 'e o da meta');
  // ⚠️ A META DO DISPENSADO VIRA ZERO — e com ela o percentual, o anel e o "faltam N".
  conf(/contaMeta\(u\) \? \(metaPorId\[analistaId\] \|\| 0\) : 0/.test(html),
       'o dispensado nao recebe meta no calculo');
  conf(/function tagPessoa\(u, opts\)/.test(html), 'ha UM componente de tag de pessoa');
  conf(/Dispensado<\/span>/.test(html), 'com a tag cinza "Dispensado"');
  conf(/Substituto<\/span>/.test(html), 'e a tag verde "Substituto"');
  conf(/Números congelados em/.test(html), 'o card do dispensado diz que os numeros congelaram');
  conf(/Designado em/.test(html), 'e o do substituto diz desde quando');
    // ⚠️ O TEXTO MUDOU EM 28/08 e a mudanca e o ponto: ele dizia 'Produtividade apurada ate a
  // data da dispensa', e a conta NAO recorta por data. O texto prometia um recorte que o
  // codigo nao faz. Agora diz o que a conta faz — a meta encerra, os numeros ficam.
  conf(/Meta encerrada em/.test(html), 'o relatorio diz que a META encerrou');
  conf(!/Produtividade apurada até a data da dispensa'/.test(html),
       'e nao promete mais um recorte por data que nao existe');
  // ⚠️ O anel de meta NAO aparece no card do dispensado: um anel em 0% diria "nao bateu a
  // meta", quando o certo e nao haver meta a bater.
  conf(/\$\{disp \? '' : `/.test(html), 'e o anel de meta some no card do dispensado');
  // A tela nao inventa dispensa a partir de `ativo`.
  conf(!/ativo === false[\s\S]{0,60}[Dd]ispensad/.test(html), 'a tela nao deduz dispensa de `ativo`');
}

console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
process.exit(falhou ? 1 : 0);
