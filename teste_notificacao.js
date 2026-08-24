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
const D = require('./lib/datas');
// A notificação das decisões do C.I. mora na ROTA, não numa lib — então o teste dela lê o
// `server.js` como texto, que é o padrão das travas de rota deste repositório.
const fs = require('fs');

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

  console.log('\n═══ 3b. TODO PARAMETRO EM CONTA LEVA O TIPO ESCRITO ═══');
  {
    // Dois defeitos iguais em produção no mesmo dia (10/08): o INSERT do pedido de vaga com
    // "inconsistent types deduced for parameter $2", e este job com "operator is not unique:
    // date + unknown". Os dois pela mesma causa — parâmetro sem tipo declarado. O dublê não
    // é Postgres e aceita qualquer SQL, então o teste passou a olhar o TEXTO do comando.
    const d = db({ rows: [] });
    await J.buscarAlvos(d);
    const s = d.ch[0].sql;
    conf(/America\/Sao_Paulo'\)::date \+ \$1::int/.test(s),
         'hoje_BR + $1::int — sem o ::int, o Postgres nao escolhe entre date+integer e date+interval');
    conf(/LIMIT \$2::int/.test(s), 'LIMIT $2::int');
    conf(!/\$\d+(?!::)/.test(s.replace(/\$\d+::[a-z]+/g, '')),
         'nao sobrou nenhum parametro sem tipo na consulta');
  }

  console.log('\n═══ 3d. TODA CONTA DE PRAZO USA A DATA DE BRASILIA ═══');
  {
    // O Postgres do Railway roda em UTC, entao CURRENT_DATE vira o dia seguinte as 21h de
    // Brasilia. Todo prazo daqui e data CIVIL brasileira. Medido em 11/08: "Diligencia vence
    // hoje" chegava as 21h da VESPERA, e o "N dias de atraso" subia um dia a noite e voltava
    // de manha. O erro so aparece a noite, que e quando ninguem esta olhando — por isso ha
    // teste, e nao so um comentario.
    conf(D.HOJE_BR === `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
         'HOJE_BR e a data de hoje no fuso de Brasilia', D.HOJE_BR);
    conf(!/CURRENT_DATE/.test(D.HOJE_BR),
         'e nao depende do fuso do servidor — continua certo se o Railway mudar de regiao');

    for (const [nome, fn] of [['buscarAlvos', J.buscarAlvos], ['buscarDiligencias', J.buscarDiligencias]]) {
      const d = db({ rows: [] });
      await fn(d);
      const sql = d.ch[0].sql;
      conf(!/CURRENT_DATE/.test(sql), `${nome}: nenhum CURRENT_DATE cru sobrou`);
      conf(sql.includes('America/Sao_Paulo'), `${nome}: compara com a data de Brasilia`);
    }
  }

  console.log('\n═══ 3c. A DATA DE CORTE DO SINO ═══');
  {
    // Sem corte, o primeiro dry-run achou PCs de 2019 vencidas ha 2.325 dias. O job
    // despejaria milhares de avisos historicos e o sino nasceria inutil — ninguem abre um
    // sino com 3.000 itens, e o que importa ficaria soterrado pelo que ninguem resolve mais.
    const d = db({ rows: [] });
    await J.buscarAlvos(d);
    const { sql, params } = d.ch[0];

    conf(J.CORTE_PRAZO === '2026-08-01', 'o corte e 01/08/2026, quando o SIGPC-GT virou fonte unica');
    conf(/dt_limite_pc::date >= \$3::date/.test(sql), 'a consulta filtra pela data de corte');
    conf(params[2] === J.CORTE_PRAZO,
         'e usa a constante, nao uma data escrita a mao no meio do SQL — muda num lugar so');

    // As duas pontas juntas: nada anterior ao corte, nada alem da faixa de 7 dias.
    conf(/dt_limite_pc::date <= \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date \+ \$1::int/.test(sql),
         'a faixa dos 7 dias continua valendo');

    // O corte e SO do sino. Se um dia alguem mexer aqui achando que ajusta prazo, isto cai.
    conf(!/UPDATE|INSERT|DELETE/.test(sql), 'a consulta so LE: o job nunca escreve em prestacoes_contas');
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

  console.log('\n═══ 4b. O SINO SO MOSTRA NAO LIDA; "VER TODAS" MOSTRA TUDO ═══');
  {
    const sino = db({ rows: [] });
    await N.listar(sino, 57, 15, true);
    conf(sino.ch[0].params[2] === true, 'o sino pede apenas nao lidas');
    conf(/\$3::boolean IS NOT TRUE OR lida_em IS NULL/.test(sino.ch[0].sql),
         'o filtro esta na consulta — a lida sai da vista na hora, nao so muda de cor');

    const tudo = db({ rows: [] });
    await N.listar(tudo, 57, 200);
    conf(tudo.ch[0].params[2] === false, '"ver todas" pede tudo — some da vista, nao do registro');
  }

  console.log('\n═══ 4c. LIMPEZA DA LIDA APOS 15 DIAS ═══');
  {
    let sql = null;
    const d = { query: async (s, p) => { sql = s.replace(/\s+/g,' '); return { rowCount: 3 } } };
    const n = await N.limparLidas(d, 15);
    conf(n === 3, 'devolve quantas apagou');

    // ⚠️ A trava que mais importa: quem passou um mes fora tem de achar tudo o que perdeu.
    conf(/lida_em IS NOT NULL/.test(sql), 'NAO LIDA nunca e apagada, por mais antiga que seja');
    // Conta da LEITURA, nao da criacao: quem volta de ferias e le hoje tem 15 dias a partir
    // de hoje, e nao um aviso que some amanha.
    conf(/lida_em < NOW\(\) - \(INTERVAL '1 day' \* \$1::int\)/.test(sql),
         'o relogio conta a partir da leitura, e o parametro leva o tipo escrito');
    conf(!/criado_em/.test(sql), 'a data de criacao nao entra na conta');

    conf(J.DIAS_GUARDA_LIDA === 15, 'o prazo e 15 dias, no mesmo bloco do CORTE_PRAZO');

    const quebrado = { query: async () => { throw new Error('nope') } };
    conf(await N.limparLidas(quebrado, 15) === 0, 'falha no banco devolve 0 sem derrubar o job');
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

  console.log('\n═══ 8. AS DUAS DECISOES DO C.I. AVISAM (24/08/2026) ═══');
  {
    // ⚠️ O DEFEITO QUE ISTO FECHA: ate 24/08 so a devolucao notificava. Medido no banco no
    // mesmo dia — 1.736 PCs `encerrado` no ciclo do C.I. e ZERO notificacao de "de acordo".
    // O analista encaminhava, a parcela sumia da vista dele, e o desfecho bom nao chegava.
    const src = fs.readFileSync('./server.js', 'utf8');
    const i = src.indexOf("app.post('/ci/decidir'");
    const rota = src.slice(i, src.indexOf('\n});', i));
    conf(i > 0, 'a rota POST /ci/decidir foi localizada');

    // O gate que existia. Se ele voltar, o "de acordo" volta a ser silencioso.
    conf(!/if \(b\.decisao === 'ressalva'\) \{[\s\S]{0,80}?for \(const g of ci\.agruparPorParcela/.test(rota),
         'o laco de notificacao NAO esta mais dentro de um if de ressalva');
    conf(/for \(const g of ci\.agruparPorParcela\(pcs\)\)/.test(rota),
         'e roda para toda decisao, agrupado por encaminhamento');

    conf(/'C\.I\. aprovou' : 'C\.I\. devolveu'/.test(rota), 'os dois titulos existem');
    conf(/titulo: `\$\{aprovou \? 'C\.I\. aprovou' : 'C\.I\. devolveu'\} · \$\{g\.tr\}`/.test(rota),
         'e a TR entra no titulo, dos dois lados');
    conf(/Decidido por \$\{autor\.nome\}/.test(rota), 'a mensagem diz quem do C.I. decidiu');
    conf(/O que o C\.I\. pediu:/.test(rota), 'e a devolucao rotula a manifestacao');

    // ⚠️ O LINK LEVA A PARCELA. `#planilha` puro abria a tela inteira e deixava a pessoa
    // procurar entre 54 TRs qual delas voltou.
    conf(/link: `#planilha:\$\{g\.tr\}:\$\{g\.parcial_num\}`/.test(rota),
         'o link carrega TR e parcela');

    // ⚠️ AS DUAS FAMILIAS DE ref_id SAO DIFERENTES, e o +1 so existe de um lado: `ci.decidir`
    // ja subiu `ci_rodada` no banco para a devolucao, mas `g.rodada` foi lido ANTES do UPDATE.
    // Sem essa diferenca, aprovar depois de uma devolucao na mesma rodada seria engolido pelo
    // dedupe — e o analista nunca saberia que a parcela fechou.
    conf(/ci_de_acordo\|\$\{g\.rodada \|\| 1\}/.test(rota), 'o de acordo usa a rodada lida');
    conf(/ci_ressalva\|\$\{\(g\.rodada \|\| 1\) \+ 1\}/.test(rota), 'e a devolucao usa a rodada +1');
    conf(/tipo: aprovou \? 'aprovacao' : 'diligencia'/.test(rota),
         'o que exige acao e diligencia; o que so informa e aprovacao');

    // A baixa nao e tocada em caminho nenhum do ciclo — vale para o bloco novo tambem.
    conf(!/baixada|data_baixa|enviado_ci/.test(rota.slice(rota.indexOf('agruparPorParcela'))),
         'o bloco de notificacao nao menciona baixada, data_baixa nem enviado_ci');
  }

  console.log('\n═══ 9. O PRAZO DA DILIGENCIA AVISA NAS TRES FAIXAS ═══');
  {
    // As tres faixas ja existiam antes de 24/08 — o teste esta aqui para que continuem.
    conf(J.DILIG_AVISO_PREVIO === 3, 'avisa 3 dias antes de vencer', String(J.DILIG_AVISO_PREVIO));
    const g = (o) => Object.assign({ tr:'2020TR000739', parcial_num:'13', analista_id:9,
      entidade:'APAE', pcs:['2022PC000456'], prazo_diligencia:new Date(2026,7,27), dias:3, faixa:'previo' }, o);

    const previo = J.montarAvisoDiligencia(g());
    conf(/vence em 3 dias/i.test(previo.titulo), 'o aviso previo diz quantos dias faltam', previo.titulo);
    conf(previo.urgente === false, 'e nao e urgente — ainda da tempo');

    const hoje = J.montarAvisoDiligencia(g({ prazo_diligencia:new Date(2026,7,24), dias:0, faixa:'hoje' }));
    conf(/vence hoje/i.test(hoje.titulo), 'no dia do vencimento avisa de novo', hoje.titulo);
    conf(hoje.urgente === true, 'e esse e urgente');

    // ⚠️ AS TRES FAIXAS TEM ref_id DIFERENTE. Com a chave so na parcela, o aviso do dia
    // seria engolido pelo de 3 dias antes e nunca sairia.
    conf(previo.ref_id !== hoje.ref_id, 'as duas faixas nao se engolem no dedupe');
    conf(/\|dilig-previo\|/.test(previo.ref_id) && /\|dilig-hoje\|/.test(hoje.ref_id),
         'e a faixa aparece na chave');
    conf(/2026-08-27/.test(previo.ref_id),
         'o prazo entra na chave: cada RODADA de diligencia avisa por conta propria', previo.ref_id);
    // ⚠️ A CHAVE E A PARCELA, NAO A PRIMEIRA PC DELA. Com `pcs[0]`, o dia em que aquela PC
    // saisse do conjunto — baixada, por exemplo — a chave mudaria e a parcela avisaria de novo.
    conf(J.montarAvisoDiligencia(g({ pcs:['OUTRA','2022PC000456'] })).ref_id === previo.ref_id,
         'trocar as PCs do grupo NAO muda a chave do dedupe');
    conf(previo.link === '#planilha:2020TR000739:13',
         'e o link leva a parcela, no mesmo formato da notificacao do C.I.', previo.link);
  }

  console.log('\n═══ 9b. UM AVISO POR PARCELA, NAO POR PC (24/08/2026) ═══');
  {
    // ⚠️ O PRAZO E DA PARCELA e a consulta devolve PCs. Medido no dia em que isto foi escrito,
    // com o cron ainda desligado: 38 PCs na faixa viravam 38 avisos; agrupadas, 22. A Cris
    // (id 9) receberia CINCO avisos identicos da parcela 7 da 2020TR000619.
    const pc = (o) => Object.assign({ analista_id:9, tr:'2020TR000619', parcial_num:'7',
      entidade:'APAE', setorial_id:'FCEE', prazo_diligencia:new Date(2026,7,17), dias:-7,
      faixa:'cobranca', codigo_pc:'X' }, o);

    const cinco = ['2022PC002306','2023PC000226','2022PC003405','2022PC002305','2022PC001651']
      .map(c => pc({ codigo_pc:c }));
    const r = J.agruparDiligencias(cinco);
    conf(r.length === 1, 'cinco PCs da mesma parcela viram UM aviso', String(r.length));
    conf(r[0].pcs.length === 5, 'e o aviso sabe que sao cinco', String(r[0].pcs.length));
    conf(/5 PCs/.test(J.montarAvisoDiligencia(r[0]).mensagem), 'a mensagem diz quantas sao');

    // ⚠️ A FAIXA SEPARA. O aviso de 3 dias antes e o do dia sao dois avisos, nao um repetido.
    const duasFaixas = J.agruparDiligencias([pc({ faixa:'previo' }), pc({ faixa:'hoje' })]);
    conf(duasFaixas.length === 2, 'faixas diferentes nao se fundem', String(duasFaixas.length));

    // Parcelas diferentes da MESMA TR continuam separadas — sao dois prazos distintos.
    const duasParcelas = J.agruparDiligencias([pc({ parcial_num:'7' }), pc({ parcial_num:'8' })]);
    conf(duasParcelas.length === 2, 'parcelas diferentes da mesma TR nao se fundem');

    // E analistas diferentes nunca se misturam, por mais que a parcela coincida.
    const dois = J.agruparDiligencias([pc({ analista_id:9 }), pc({ analista_id:13 })]);
    conf(dois.length === 2, 'analistas diferentes nao se fundem');

    conf(J.agruparDiligencias([]).length === 0, 'lista vazia nao estoura');
    conf(J.agruparDiligencias(null).length === 0, 'nulo nao estoura');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})();
