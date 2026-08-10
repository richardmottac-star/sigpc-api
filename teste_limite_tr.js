// CAMINHO: sigpc-api/teste_limite_tr.js
//
// Testes da trava de TRs (lib/limite-tr.js). Sem rede e sem banco: o `db` e um dublê que
// devolve o que cada teste combinar.
//
// O que protege, em uma frase cada:
//   · superadmin nunca trava, mesmo sem exceção cadastrada;
//   · `null` é sem limite e `0` é bloqueio — confundir os dois libera ou trava a equipe toda;
//   · quem já está acima não devolve nada, mas não pega nova;
//   · a segunda PC da MESMA TR não é barrada como se fosse TR nova;
//   · aprovação autoriza a TR, e não soma +1.
//
// USO: node teste_limite_tr.js

const L = require('./lib/limite-tr');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// Dublê de banco: responde por trecho de SQL.
function db({ config, excecao, ocupadas = 0, extras = 0, jaMinha = false, autorizacao = null, reserva = null }) {
  const chamadas = [];
  return {
    chamadas,
    query: async (sql, params) => {
      // 220, e não 60: os testes de expiração conferem o `criado_em > NOW() - N dias`, que
      // fica no fim do WHERE. Cortar antes escondia o filtro e o teste passava vazio.
      chamadas.push(sql.replace(/\s+/g, ' ').trim().slice(0, 220));
      if (/FROM config_limite_tr/.test(sql)) return { rows: config ? [config] : [] };
      if (/FROM limite_tr_excecao/.test(sql)) return { rows: excecao ? [excecao] : [] };
      if (/COUNT\(\*\)::int n FROM solicitacao_vaga/.test(sql)) return { rows: [{ n: extras }] };
      if (/FROM solicitacao_vaga s[\s\S]*status = 'pendente'/.test(sql)) return { rows: reserva ? [reserva] : [] };
      if (/id, tr FROM solicitacao_vaga/.test(sql)) return { rows: autorizacao ? [autorizacao] : [] };
      if (/FROM prestacoes_contas WHERE tr = \$1 AND analista_id/.test(sql)) return { rows: jaMinha ? [{ n: 1 }] : [] };
      if (/COUNT\(DISTINCT tr\)|COUNT\(\*\)::int n FROM \(/.test(sql)) return { rows: [{ n: ocupadas }] };
      return { rows: [] };
    },
  };
}

const CFG = (o) => Object.assign({ limite_padrao: 5, liberacao: 'tr', pedido_ativo: true, pedido_aprovador: 'coordenador' }, o);
const ANALISTA = { id: 42, nome: 'Grazielly', perfil: 'analista', grupo: '3' };
const SUPER = { id: 4, nome: 'Richard', perfil: 'superadmin', grupo: '3' };

(async () => {

  console.log('\n═══ 1. SUPERADMIN NUNCA TRAVA ═══');
  {
    const s = await L.situacao(db({ config: CFG({ limite_padrao: 1 }), ocupadas: 44 }), SUPER);
    conf(s.semLimite === true && s.podeAssumir === true, 'com 44 TRs e limite 1, continua livre');
    conf(s.origem === 'superadmin', 'a origem diz que foi o perfil, nao exceção');
    // se dependesse de exceção cadastrada, apagar a exceção travaria quem administra
    const d = db({ config: CFG({ limite_padrao: 1 }), ocupadas: 44 });
    await L.situacao(d, SUPER);
    conf(!d.chamadas.some(c => /limite_tr_excecao/.test(c)), 'nem consulta a tabela de exceções');
  }

  console.log('\n═══ 2. null É SEM LIMITE · 0 É BLOQUEIO ═══');
  {
    const semLim = await L.situacao(db({ config: CFG({ limite_padrao: null }), ocupadas: 999 }), ANALISTA);
    conf(semLim.semLimite === true && semLim.podeAssumir === true, 'limite null: passa com 999 TRs');

    const zero = await L.situacao(db({ config: CFG({ limite_padrao: 0 }), ocupadas: 0 }), ANALISTA);
    conf(zero.semLimite === false && zero.podeAssumir === false, 'limite 0: bloqueia mesmo com 0 TRs');

    const excSem = await L.situacao(db({ config: CFG({ limite_padrao: 5 }), excecao: { limite: null }, ocupadas: 99 }), ANALISTA);
    conf(excSem.semLimite === true, 'exceção com null: sem limite para a pessoa');
    conf(excSem.origem === 'excecao', 'e a origem aponta a exceção');

    const excZero = await L.situacao(db({ config: CFG({ limite_padrao: 5 }), excecao: { limite: 0 }, ocupadas: 0 }), ANALISTA);
    conf(excZero.podeAssumir === false, 'exceção com 0: bloqueada');
  }

  console.log('\n═══ 3. A CONTA DO LIMITE ═══');
  {
    const s = await L.situacao(db({ config: CFG(), ocupadas: 4 }), ANALISTA);
    conf(s.podeAssumir === true, '4 de 5: pode');
    const t = await L.situacao(db({ config: CFG(), ocupadas: 5 }), ANALISTA);
    conf(t.podeAssumir === false, '5 de 5: nao pode');
    const u = await L.situacao(db({ config: CFG(), ocupadas: 54 }), ANALISTA);
    conf(u.podeAssumir === false, '54 de 5: nao pode (mas nao devolve nada)');
    conf(u.ocupadas === 54 && u.limite === 5, 'a situação mostra os dois números para a tela explicar');
  }

  console.log('\n═══ 4. A SEGUNDA PC DA MESMA TR NAO PODE SER BARRADA ═══');
  {
    // O front manda um PATCH por PC. Se a TR ja e dele, nao e TR nova.
    const c = await L.podeAssumirTr(db({ config: CFG(), ocupadas: 5, jaMinha: true }), ANALISTA, '2020TR000001');
    conf(c.pode === true && c.jaMinha === true, 'TR que ja e dele passa, mesmo no limite');
    const d = await L.podeAssumirTr(db({ config: CFG(), ocupadas: 5, jaMinha: false }), ANALISTA, '2020TR000002');
    conf(d.pode === false, 'TR nova, no limite, e barrada');
    conf(/Limite de 5 TRs/.test(d.motivo||''), 'com motivo legivel', d.motivo);
  }

  console.log('\n═══ 5. APROVACAO AUTORIZA A TR — NAO SOMA +1 ═══');
  {
    // Quem tem 54 TRs num limite de 5: um "+1" o deixaria em 6 e ele continuaria travado,
    // tornando o pedido inutil justamente para quem precisa.
    const semAut = await L.podeAssumirTr(db({ config: CFG(), ocupadas: 54, extras: 1 }), ANALISTA, '2020TR000003');
    conf(semAut.pode === false, 'com 54 TRs, +1 de extra nao basta');

    const comAut = await L.podeAssumirTr(
      db({ config: CFG(), ocupadas: 54, extras: 1, autorizacao: { id: 7, tr: '2020TR000003' } }),
      ANALISTA, '2020TR000003');
    conf(comAut.pode === true, 'mas a autorização aprovada libera a TR');
    conf(comAut.autorizacao && comAut.autorizacao.id === 7, 'e devolve qual autorização foi usada', JSON.stringify(comAut.autorizacao));
  }

  console.log('\n═══ 5b. A APROVACAO NAO SOMA +1 NO LIMITE (defeito de 10/08) ═══');
  {
    // Era o defeito: com 5 de 5 e uma aprovação guardada, `limite` virava 6, o analista
    // passava pelo caminho do limite e NUNCA pelo da autorização. Resultado: sem aviso no
    // modal, sem consumo, e a aprovação virava +1 permanente.
    const s = await L.situacao(db({ config: CFG(), ocupadas: 5, extras: 1 }), ANALISTA);
    conf(s.limite === 5, 'com 1 aprovação guardada, o limite continua 5', `limite=${s.limite}`);
    conf(s.podeAssumir === false, 'e 5 de 5 continua barrado pelo limite');
    conf(s.extras === 1, 'mas `extras` continua visível para a tela mostrar');

    // Agora a aprovação só libera pelo caminho certo — o que devolve a autorização.
    const c = await L.podeAssumirTr(
      db({ config: CFG(), ocupadas: 5, extras: 1, autorizacao: { id: 9, tr: '2020TR000009' } }),
      ANALISTA, '2020TR000009');
    conf(c.pode === true && c.autorizacao && c.autorizacao.id === 9,
         'a autorização libera E se identifica, para o modal avisar e o PATCH consumir');
  }

  console.log('\n═══ 5c. RESERVA: PEDIDO PENDENTE SEGURA A TR ═══');
  {
    const OUTRO = { id: 77, nome: 'Grazielly Souza', analista_id: 77 };

    // Longe do limite e mesmo assim barrado: a reserva NAO e a conta do limite.
    const c = await L.podeAssumirTr(
      db({ config: CFG(), ocupadas: 1, reserva: { id: 3, analista_id: 77, nome: 'Grazielly Souza' } }),
      ANALISTA, '2020TR000010');
    conf(c.pode === false, 'com 1 TR de 5, ainda assim nao fura a fila da reserva');
    conf(/Grazielly/.test(c.motivo||''), 'o motivo diz de quem e o pedido', c.motivo);
    conf(!!c.reserva, 'e devolve a reserva, para a tela falar diferente do limite');

    // O proprio solicitante nao e barrado pelo proprio pedido.
    const dono = await L.podeAssumirTr(
      db({ config: CFG(), ocupadas: 1, reserva: { id: 3, analista_id: ANALISTA.id, nome: 'Grazielly' } }),
      ANALISTA, '2020TR000010');
    conf(dono.pode === true, 'quem pediu passa pela propria reserva');

    // Superadmin passa por cima.
    const sup = await L.podeAssumirTr(
      db({ config: CFG(), ocupadas: 1, reserva: { id: 3, analista_id: 77, nome: 'Grazielly' } }),
      SUPER, '2020TR000010');
    conf(sup.pode === true, 'superadmin nao e barrado pela reserva');

    // Sem TR nao ha o que reservar — e nao pode estourar.
    const semTr = await L.reservaPendente(db({ config: CFG() }), null);
    conf(semTr === null, 'reservaPendente(null) devolve null sem consultar');

    // Tabela ausente: nunca travar o Estoque por causa de migração faltando.
    const quebrado = { query: async () => { throw new Error('relation does not exist') } };
    conf(await L.reservaPendente(quebrado, '2020TR000010') === null, 'tabela ausente: sem reserva');
    conf((await L.reservasPendentes(quebrado)).length === 0, 'reservasPendentes devolve lista vazia');
  }

  console.log('\n═══ 5d. EXPIRACAO EM 3 DIAS, SEM JOB ═══');
  {
    // O que de fato solta a TR e o filtro de tempo NA CONSULTA, nao o UPDATE. Se dependesse
    // do UPDATE, uma TR ficaria reservada o fim de semana inteiro so porque ninguem abriu o
    // sistema para disparar a varredura.
    const d = db({ config: CFG() });
    await L.reservaPendente(d, '2020TR000020');
    conf(d.chamadas.some(c => /criado_em > NOW\(\)/.test(c)),
         'reservaPendente ignora o pedido velho por tempo, na propria consulta');

    const e = db({ config: CFG() });
    await L.reservasPendentes(e);
    conf(e.chamadas.some(c => /criado_em > NOW\(\)/.test(c)),
         'reservasPendentes tambem — senao a tag ficaria na tela depois de expirar');

    // O UPDATE existe para o estado GRAVADO alcancar a realidade: e ele que da ao analista
    // o registro com que cobrar depois.
    let sqlExp = null;
    const f = { query: async (sql) => { sqlExp = sql.replace(/\s+/g,' '); return { rowCount: 2 } } };
    const n = await L.expirarPendentes(f);
    conf(n === 2, 'expirarPendentes devolve quantos expiraram');
    conf(/SET status = 'expirada'/.test(sqlExp), "marca 'expirada'");
    conf(/WHERE status = 'pendente'/.test(sqlExp), 'so mexe em pendente — nao ressuscita decidido');
    conf(!/DELETE/.test(sqlExp), 'NAO apaga: a linha fica, e com ela o analista cobra depois');

    // Banco fora do ar nao pode derrubar quem so queria listar.
    const quebrado = { query: async () => { throw new Error('relation does not exist') } };
    conf(await L.expirarPendentes(quebrado) === 0, 'tabela ausente: devolve 0 em vez de estourar');

    conf(L.RESERVA_DIAS === 3, 'o prazo e 3 dias, fixo no codigo (decisao de 10/08)');
  }

  console.log('\n═══ 5e. CANCELAR SOLTA A TR NA HORA ═══');
  {
    // Nao ha funcao propria: cancelar e um UPDATE na rota. O que se garante aqui e que a
    // reserva some no instante em que o status deixa de ser 'pendente' — porque TUDO que le
    // reserva filtra por 'pendente'. Se um dia alguem trocar esse filtro por "nao decidida"
    // ou coisa parecida, estes dois testes caem.
    const d = db({ config: CFG() });
    await L.reservaPendente(d, '2020TR000030');
    conf(d.chamadas.some(c => /s\.status = 'pendente'/.test(c)),
         "reservaPendente so olha 'pendente' — cancelada deixa de segurar na hora");

    const e = db({ config: CFG() });
    await L.reservasPendentes(e);
    conf(e.chamadas.some(c => /s\.status = 'pendente'/.test(c)),
         'reservasPendentes idem — a tag some junto');

    // Cancelado nao pode continuar barrando quem quer assumir.
    const c = await L.podeAssumirTr(db({ config: CFG(), ocupadas: 1, reserva: null }), ANALISTA, '2020TR000030');
    conf(c.pode === true, 'sem pendente, a TR volta a ser assumivel');
  }

  console.log('\n═══ 6. LIBERACAO: POR TR OU POR PARCIAL ═══');
  {
    const porTr = db({ config: CFG({ liberacao: 'tr' }), ocupadas: 3 });
    await L.situacao(porTr, ANALISTA);
    conf(porTr.chamadas.some(c => /COUNT\(DISTINCT tr\)/.test(c)), "'tr' conta TRs com PC nao baixada");

    const porParcial = db({ config: CFG({ liberacao: 'parcial' }), ocupadas: 3 });
    await L.situacao(porParcial, ANALISTA);
    conf(porParcial.chamadas.some(c => /HAVING COUNT|FROM \(/.test(c)), "'parcial' usa a contagem por parcial fechada");
  }

  console.log('\n═══ 7. TABELA AUSENTE NAO DERRUBA A TELA ═══');
  {
    // Se as tabelas nao existirem, o sistema tem de se comportar como "sem limite" — nunca
    // travar a equipe por causa de migração faltando.
    const quebrado = { query: async () => { throw new Error('relation does not exist') } };
    const cfg = await L.lerConfig(quebrado);
    conf(cfg.limite_padrao === null && cfg.liberacao === 'tr', 'lerConfig devolve o padrão sem limite');
    const extras = await L.contarVagasExtras(quebrado, 42);
    conf(extras === 0, 'contarVagasExtras devolve 0 em vez de estourar');
  }

  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})();
