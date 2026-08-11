// CAMINHO: sigpc-api/teste_notificacao.js
//
// Testes do sino (lib/notificacao.js e job_notificacoes.js). Sem rede e sem banco.
//
// O que protege, em uma frase cada:
//   · o dedupe vive DENTRO do INSERT — conferir antes deixaria duas execuções do job passarem;
//   · recado NÃO deduplica: dois recados no mesmo dia são dois recados;
//   · o `ref_id` do prazo leva a faixa, senão o aviso de "vencida" nunca sai;
//   · marcar como lida confere o dono no mesmo comando que grava;
//   · notificação quebrada NUNCA derruba a ação que a originou.
//
// USO: node teste_notificacao.js

const N = require('./lib/notificacao');
const J = require('./job_notificacoes');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// Dublê que guarda o SQL e os parâmetros de cada chamada.
function db(resposta) {
  const ch = [];
  return {
    ch,
    query: async (sql, params) => {
      ch.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return resposta || { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
}

(async () => {

  console.log('\n═══ 1. O DEDUPE VIVE DENTRO DO INSERT ═══');
  {
    const d = db();
    await N.criar(d, { destinatario_id: 57, tipo: 'prazo', titulo: 'PC vencida', ref_id: 'X|vencida' });
    const s = d.ch[0].sql;
    conf(/INSERT INTO notificacao/.test(s) && /NOT EXISTS/.test(s),
         'e um comando so: INSERT ... WHERE NOT EXISTS');
    conf(!/^SELECT/.test(s), 'nao ha consulta antes — seria a fresta por onde o job duplica');
    conf(/x\.destinatario_id = \$1::int/.test(s) && /x\.tipo = \$2::text/.test(s) && /x\.ref_id = \$7::text/.test(s),
         'a chave e destinatario_id + tipo + ref_id, como combinado');

    // O erro de 10/08 em producao: sem declarar o tipo em todos os usos, o Postgres deduz
    // varchar num lugar e text noutro e recusa o comando inteiro.
    conf(/\$1::int, \$2::text/.test(s), 'os tipos vao declarados tambem na lista do SELECT');
  }

  console.log('\n═══ 2. RECADO NAO DEDUPLICA ═══');
  {
    const d = db();
    await N.criar(d, { destinatario_id: 57, tipo: 'recado', titulo: 'Reuniao' });
    conf(d.ch[0].params[6] === null, 'recado vai com ref_id null');
    conf(/WHERE \$7::text IS NULL OR NOT EXISTS/.test(d.ch[0].sql),
         'e o proprio comando libera quando ref_id e null — dois recados sao dois recados');
  }

  console.log('\n═══ 3. O ref_id DO PRAZO LEVA A FAIXA ═══');
  {
    const perto = J.montarAviso({ codigo_pc: '2020TR000451-P3', tr: '2020TR000451', dias: 3, analista_id: 9 });
    const venc  = J.montarAviso({ codigo_pc: '2020TR000451-P3', tr: '2020TR000451', dias: -2, analista_id: 9 });

    conf(perto.ref_id !== venc.ref_id,
         'a MESMA PC tem chave diferente perto do prazo e depois de vencer');
    conf(perto.ref_id.endsWith('|vence') && venc.ref_id.endsWith('|vencida'),
         'e a faixa esta na chave', `${perto.ref_id} / ${venc.ref_id}`);
    // So o codigo_pc faria o aviso de vencida ser engolido pelo de "perto do prazo", e o
    // analista nunca saberia que passou do prazo.
    conf(venc.urgente === true && perto.urgente === false,
         'vencida e urgente; a que ainda vai vencer, nao — senao o vermelho perde o sentido');
    conf(/Venceu há 2 dias/.test(venc.mensagem), 'a mensagem diz ha quantos dias venceu', venc.mensagem);
    conf(/Vence em 3 dias/.test(perto.mensagem), 'e quantos faltam', perto.mensagem);

    const um = J.montarAviso({ codigo_pc: 'X', dias: 1, analista_id: 9 });
    conf(/Vence em 1 dia\./.test(um.mensagem), 'singular no dia 1, sem "1 dias"', um.mensagem);
  }

  console.log('\n═══ 4. MARCAR COMO LIDA CONFERE O DONO NO MESMO COMANDO ═══');
  {
    const d = db({ rows: [{ id: 5 }] });
    await N.marcarLida(d, 5, 57);
    const s = d.ch[0].sql;
    conf(/WHERE id = \$1 AND destinatario_id = \$2/.test(s),
         'o dono entra no WHERE — ninguem marca a notificacao de outro sabendo so o id');
    conf(/lida_em IS NULL/.test(s),
         'e so marca o que ainda nao foi lido: reler nao muda a hora da primeira leitura');
  }

  console.log('\n═══ 5. URGENTE NAO LIDA VEM PRIMEIRO ═══');
  {
    const d = db({ rows: [] });
    await N.listar(d, 57, 15);
    conf(/ORDER BY \(lida_em IS NULL AND urgente\) DESC, criado_em DESC/.test(d.ch[0].sql),
         'o que e urgente e ainda nao foi lido nao pode cair na pagina 2');

    const teto = db({ rows: [] });
    await N.listar(teto, 57, 99999);
    conf(teto.ch[0].params[1] === 200, 'limite tem teto: 99999 vira 200', String(teto.ch[0].params[1]));
    const piso = db({ rows: [] });
    await N.listar(piso, 57, 0);
    conf(piso.ch[0].params[1] === 15, 'limite 0 cai no padrao 15, em vez de listar nada');
  }

  console.log('\n═══ 6. O SINO QUEBRADO NAO DERRUBA A ACAO ═══');
  {
    // Aprovar um pedido tem de funcionar mesmo com a tabela de notificacao fora do ar.
    const quebrado = { query: async () => { throw new Error('relation "notificacao" does not exist') } };
    conf(await N.criar(quebrado, { destinatario_id: 1, titulo: 'x' }) === null,
         'criar devolve null em vez de estourar');
    conf(await N.criarVarios(quebrado, [1, 2, 3], { titulo: 'x' }) === 0,
         'criarVarios devolve 0');
    conf((await N.coordenadoresDoGrupo(quebrado, '3')).length === 0,
         'coordenadoresDoGrupo devolve lista vazia');

    // Sem destinatario ou sem titulo nao ha o que gravar — e nao pode consultar o banco a toa.
    const d = db();
    conf(await N.criar(d, { titulo: 'sem destinatario' }) === null, 'sem destinatario_id: null');
    conf(await N.criar(d, { destinatario_id: 5 }) === null, 'sem titulo: null');
    conf(d.ch.length === 0, 'e nenhum dos dois casos toca no banco');
  }

  console.log('\n═══ 7. O GRUPO 3 NAO PODE FICAR SEM AVISO ═══');
  {
    // O Gustavo, coordenador do Grupo 3, nao tem cadastro em `usuarios`. Sem o cai-para-o-
    // superadmin, todo aviso do maior grupo sumiria sem erro nenhum.
    const semCoord = {
      chamadas: 0,
      query: async function (sql) {
        this.chamadas++;
        if (/perfil = 'coordenador'/.test(sql)) return { rows: [] };
        if (/perfil = 'superadmin'/.test(sql)) return { rows: [{ id: 4 }] };
        return { rows: [] };
      },
    };
    const r = await N.coordenadoresDoGrupo(semCoord, '3');
    conf(r.length === 1 && r[0] === 4, 'sem coordenador cadastrado, o aviso vai para o superadmin');

    const comCoord = { query: async (sql) => /coordenador/.test(sql) ? { rows: [{ id: 8 }] } : { rows: [{ id: 4 }] } };
    const r2 = await N.coordenadoresDoGrupo(comCoord, '1');
    conf(r2.length === 1 && r2[0] === 8, 'havendo coordenador, o superadmin nao e incomodado');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})();
