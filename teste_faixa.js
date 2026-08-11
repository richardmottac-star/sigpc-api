// CAMINHO: sigpc-api/teste_faixa.js
//
// Testes da FAIXA DE AVISOS (lib/faixa.js). Sem rede e sem banco.
//
// O que protege:
//   · a janela usa a data de BRASÍLIA, não CURRENT_DATE — senão a faixa marcada para amanhã
//     aparece hoje às 21h, e a que termina hoje some às 21h;
//   · tabela ausente devolve lista vazia, nunca derruba a tela;
//   · urgente vem primeiro, para não ficar atrás de aviso comum;
//   · período invertido é recusado com frase, não com erro de constraint.
//
// USO: node teste_faixa.js

const F = require('./lib/faixa');
const D = require('./lib/datas');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

function db(resposta) {
  const ch = [];
  return { ch, query: async (sql, params) => { ch.push({ sql: sql.replace(/\s+/g,' ').trim(), params }); return resposta || { rows: [] }; } };
}

(async () => {

  console.log('\n═══ 1. A JANELA USA A DATA DE BRASILIA ═══');
  {
    const d = db();
    await F.ativas(d, '3');
    const s = d.ch[0].sql;
    conf(!/CURRENT_DATE/.test(s), 'nenhum CURRENT_DATE cru');
    conf(s.includes('America/Sao_Paulo'), 'compara com a data de Brasilia');
    // Se fosse CURRENT_DATE: o Postgres do Railway roda em UTC, entao um aviso marcado para
    // comecar amanha apareceria hoje as 21h, e um que termina hoje sumiria as 21h.
    conf(/inicio IS NULL OR inicio <=/.test(s), 'sem inicio, vale desde sempre');
    conf(/fim IS NULL OR fim >=/.test(s), 'sem fim, vale ate ser desativado');
  }

  console.log('\n═══ 2. ORDEM: URGENTE PRIMEIRO ═══');
  {
    const d = db();
    await F.ativas(d, null);
    conf(/ORDER BY \(escopo = 'urgente'\) DESC/.test(d.ch[0].sql),
         'urgente vem antes — senao ficaria atras de aviso comum na rotacao');
    conf(d.ch[0].params[0] === null, 'sem grupo, o parametro vai null e a consulta pega os globais');
  }

  console.log('\n═══ 3. GRUPO: O GLOBAL SEMPRE ENTRA ═══');
  {
    const d = db();
    await F.ativas(d, '2');
    conf(/grupo IS NULL OR grupo = \$1::text/.test(d.ch[0].sql),
         'aviso sem grupo alcanca todo mundo, e o do grupo 2 tambem entra');
    conf(d.ch[0].params[0] === '2', 'o grupo vai como texto', String(d.ch[0].params[0]));
  }

  console.log('\n═══ 4. TABELA AUSENTE NAO DERRUBA NADA ═══');
  {
    // A faixa e adorno de rodape. Se a tabela nao existe — e no dia da estreia ela nao
    // existia — o sistema inteiro tem de seguir funcionando.
    const quebrado = { query: async () => { throw new Error('relation "faixa_aviso" does not exist') } };
    conf((await F.ativas(quebrado, '3')).length === 0, 'ativas devolve lista vazia');
    conf((await F.listar(quebrado)).length === 0, 'listar devolve lista vazia');
  }

  console.log('\n═══ 5. VALIDACAO, COM FRASE EM VEZ DE ERRO DE CONSTRAINT ═══');
  {
    conf(F.validar({ texto: 'ok' }) === null, 'texto simples passa');
    conf(/obrigat/i.test(F.validar({ texto: '' }) || ''), 'texto vazio e recusado');
    conf(/obrigat/i.test(F.validar({ texto: '   ' }) || ''), 'so espaco e recusado');
    conf(/300/.test(F.validar({ texto: 'a'.repeat(301) }) || ''), 'acima de 300 caracteres e recusado');
    conf(F.validar({ texto: 'a'.repeat(300) }) === null, '300 exatos passa');

    conf(/escopo/.test(F.validar({ texto:'x', escopo:'qualquer' }) || ''), 'escopo invalido e recusado');
    F.ESCOPOS.forEach(e => conf(F.validar({ texto:'x', escopo:e }) === null, `escopo '${e}' e valido`));

    // O mesmo esta no CHECK da tabela. Aqui e para o usuario ler uma frase, e nao um erro do
    // Postgres — uma faixa com fim antes do inicio nunca apareceria e ninguem entenderia.
    conf(/anterior/.test(F.validar({ texto:'x', inicio:'2026-08-20', fim:'2026-08-10' }) || ''),
         'fim antes do inicio e recusado');
    conf(F.validar({ texto:'x', inicio:'2026-08-10', fim:'2026-08-20' }) === null, 'periodo certo passa');
    conf(F.validar({ texto:'x', inicio:'2026-08-10', fim:'2026-08-10' }) === null, 'um dia so passa');
    conf(F.validar({ texto:'x', inicio:'2026-08-10' }) === null, 'so inicio passa');
    conf(F.validar({ texto:'x', fim:'2026-08-10' }) === null, 'so fim passa');
  }

  console.log('\n═══ 6. A CONSULTA SO LE ═══');
  {
    const d = db();
    await F.ativas(d, '1');
    conf(!/UPDATE|INSERT|DELETE/.test(d.ch[0].sql), 'exibir a faixa nunca escreve no banco');
    conf(D.HOJE_BR.includes('America/Sao_Paulo'), 'e o HOJE_BR continua sendo o de Brasilia');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})();
