// CAMINHO: sigpc-api/lib/transferencia.js
//
// TRANSFERIR PRESTAÇÕES DE CONTAS — move as PCs ABERTAS de um analista para outro, e a TR
// junto. SÓ SUPERADMIN.
//
// Nasceu da primeira transferência real: as 32 PCs do Samoel para o Richard, em 28/08/2026,
// que foi um script com dry-run porque não havia rota. A tela veio em 31/08 e esta rota em
// 01/09.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A PC BAIXADA NÃO SE MOVE, E É A REGRA CENTRAL
//
// A unidade de produtividade é a PC baixada (CGE nº 727/2025), e ela pertence a quem a
// analisou. Mover a baixada junto transferiria a produtividade de uma pessoa para outra — o
// analista que saiu perderia o que fez, e o que recebeu ganharia trabalho que não fez. Os
// dois números ficariam errados, e nenhum dos dois daria erro.
//
// A consequência é que a TR fica MISTA depois da transferência: as abertas no novo dono, as
// baixadas no antigo. Isso é o desenhado, não um efeito colateral — e é o que a faixa bege da
// tela promete ao analista.
//
// ⚠️ E A TR "IR JUNTO" NÃO É UM UPDATE À PARTE. Não há tabela de TR: o dono da TR é derivado
// do `analista_id` das PCs dela. Mover as PCs abertas É mover a TR. Quem procurar um
// `UPDATE ... SET` numa tabela de TR não vai achar, e está certo.
// ─────────────────────────────────────────────────────────────────────────────

const { nomeCurto } = require('./assumir');

// ⚠️ O EVENTO É `transferencia`, E NÃO `transferencia_dispensa`. Aquele foi o nome do script
// de 28/08, e nasceu do caso da dispensa — as 32 linhas dele continuam lá e não se mexe
// nelas. Esta rota transfere de QUALQUER analista, dispensado ou em atividade: reusar o nome
// antigo faria a trilha afirmar uma dispensa que não houve. Decisão do Richard, 01/09/2026.
//
// ⚠️ E `parcela_historico.evento` NÃO TEM CHECK no banco (conferido em 31/08), então o nome
// novo entra sem ALTER nenhum. Nenhuma tabela foi criada para esta rota.
const EVENTO = 'transferencia';

/** Valida o corpo. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  const de = parseInt(b.de_id) || 0;
  const para = parseInt(b.para_id) || 0;
  if (!de) return 'Informe de quem sai o acervo.';
  if (!para) return 'Informe para quem vai o acervo.';
  // ⚠️ A IGUALDADE É CONFERIDA AQUI, antes de qualquer consulta: `de === para` faria o UPDATE
  // rodar contra ele mesmo, gravar histórico de uma transferência que não aconteceu, e
  // devolver "N PCs transferidas" com todas paradas no mesmo lugar. Um sucesso mentiroso.
  if (de === para) return 'O analista de origem e o de destino são o mesmo.';
  if (!Array.isArray(b.trs) || !b.trs.length) return 'Marque ao menos uma TR.';
  if (b.trs.some((t) => !String(t == null ? '' : t).trim())) return 'Há TR em branco na lista.';
  if (!b.usuario_id) return 'usuario_id é obrigatório.';
  return null;
}

/** A lista de TRs, limpa e sem repetição — o mesmo conjunto que o UPDATE e a foto vão usar. */
function trsLimpas(trs) {
  return [...new Set((trs || []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean))];
}

// ── A FOTO, ANTES DE QUALQUER ESCRITA ───────────────────────────────────────
//
// ⚠️ ELA É O QUE TORNA A CONFERÊNCIA POSSÍVEL. Conferir só depois da escrita prova o que se
// esperava, não o que aconteceu: sem a foto não há contra o que comparar. É a mesma exigência
// da dupla verificação escrita no CLAUDE.md — toda gravação em massa confere de novo DEPOIS
// de gravar, dentro da MESMA transação, contra o previsto.
const SQL_FOTO = `
  SELECT codigo_pc, tr, parcial_num, setorial_id, analista_id, analista_nome, baixada,
         status, dt_assumida, dt_inicio_analise
    FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = ANY($2::text[])
   ORDER BY tr, codigo_pc`;

/**
 * Quais das TRs pedidas NÃO são do `de_id`.
 *
 * ⚠️ "SER DO de_id" É TER PC ABERTA DELE. Não é o `analista_nome`, que é texto livre e já
 * contradisse o `analista_id` em 10 PCs; e não é "todas as PCs serem dele", porque a TR fica
 * mista justamente depois de uma transferência — as baixadas continuam com quem analisou.
 *
 * Devolve a lista das recusadas, para a rota dizer QUAIS. Uma recusa sem a lista obriga a
 * pessoa a descobrir sozinha qual das 30 TRs marcadas está errada.
 */
function trsAlheias(trsPedidas, linhasFoto, deId) {
  const daPessoa = new Set(
    linhasFoto.filter((l) => l.analista_id === deId && !l.baixada).map((l) => l.tr)
  );
  return trsPedidas.filter((t) => !daPessoa.has(t));
}

/** As PCs que VÃO se mover: abertas, do `de_id`, nas TRs pedidas. */
function pcsQueMovem(linhasFoto, deId) {
  return linhasFoto.filter((l) => l.analista_id === deId && !l.baixada);
}

/** As que FICAM e que a conferência tem de provar intactas: as baixadas do `de_id`. */
function pcsQueFicam(linhasFoto, deId) {
  return linhasFoto.filter((l) => l.analista_id === deId && l.baixada);
}

// ── O UPDATE ────────────────────────────────────────────────────────────────
//
// ⚠️ QUATRO COLUNAS, E SÓ ELAS. `situacao_atual`, `ci_*`, `eng_*` e `sigef_declaracao` NÃO são
// tocadas — ordem do Richard, e cada uma tem o seu motivo:
//   · `situacao_atual` é o estado do trabalho, e trocar de dono não desfaz o que foi feito;
//   · `ci_*` é o ciclo do Controle Interno, que corre em paralelo e não sabe de dono;
//   · `eng_*` é o envio à engenharia, idem;
//   · `sigef_declaracao` é um array que só cresce e não se desmarca — mexer nele apagaria a
//     declaração de quem declarou.
//
// ⚠️ `dt_assumida` REINICIA e `dt_inicio_analise` NÃO. São perguntas diferentes: a primeira é
// "quando ESTE analista pegou", a segunda é "quando a análise começou" — o relógio do prazo.
// Reiniciar o prazo numa transferência daria fôlego novo a uma PC parada há meses.
//
// ⚠️ E O FILTRO REPETE `analista_id = $3 AND NOT baixada` mesmo já tendo a foto: a foto é de
// uma consulta anterior, e entre ela e o UPDATE cabe outra transação. O `WHERE` é a garantia;
// a foto é a prova.
const SQL_MOVER = `
  UPDATE prestacoes_contas
     SET analista_id = $4,
         analista_nome = $5,
         dt_assumida = NOW(),
         atualizado_em = NOW()
   WHERE setorial_id = $1
     AND tr = ANY($2::text[])
     AND analista_id = $3
     AND NOT baixada
  RETURNING codigo_pc, tr, parcial_num`;

// ── O HISTÓRICO ─────────────────────────────────────────────────────────────
//
// ⚠️ UMA LINHA POR PC MOVIDA, e `executado_por` PREENCHIDO. Pela regra da `lib/autoria.js` o
// `executado_por` fica NULO quando o dono foi quem executou — aqui nunca é o caso: quem
// executa é o técnico do sistema e o dono é o analista que recebeu. São pessoas diferentes por
// definição, e é justamente a linha em que os dois diferem que se quer achar depois.
//
// ⚠️ `estado_anterior` GUARDA A FOTO DE CADA PC, e é por ela que se desfaz. Foi o que o script
// de 28/08 gravou, e é o que permitiu que aquela transferência fosse reversível.
const SQL_HIST = `
  INSERT INTO parcela_historico
    (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
     observacao, executado_por, estado_anterior)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                       $6::text[], $7::int[], $8::text[], $9::int[], $10::jsonb[])
  RETURNING id`;

/** "48 · Samoel" — o rótulo de uma ponta da transferência, no formato que o script de 28/08
 *  usou e que as 32 linhas antigas já têm. Mudar o formato agora faria a mesma coluna ter
 *  duas gramáticas. */
const rotulo = (id, nome) => `${id} · ${nomeCurto(nome)}`;

/** Os dez arrays do `SQL_HIST`, na ordem. Uma função só — a rota não monta isso à mão. */
function paramsHistorico({ movidas, foto, deId, paraId, deNome, paraNome, usuarioId, motivo }) {
  const porCodigo = new Map(foto.map((l) => [l.codigo_pc, l]));
  const n = movidas.length;
  const rep = (v) => Array(n).fill(v);
  return [
    movidas.map((m) => m.tr),
    movidas.map((m) => m.parcial_num),
    rep(foto.length ? foto[0].setorial_id : 'FCEE'),
    rep(EVENTO),
    rep(rotulo(deId, deNome)),
    rep(rotulo(paraId, paraNome)),
    rep(paraId),
    movidas.map((m) => `${m.codigo_pc} — transferida de ${deNome} (id ${deId}) para `
      + `${paraNome} (id ${paraId}).${motivo ? ' ' + motivo : ''}`),
    rep(parseInt(usuarioId) || null),
    movidas.map((m) => {
      const a = porCodigo.get(m.codigo_pc) || {};
      return JSON.stringify({
        codigo_pc: m.codigo_pc, analista_id: a.analista_id, analista_nome: a.analista_nome,
        dt_assumida: a.dt_assumida, dt_inicio_analise: a.dt_inicio_analise, status: a.status,
      });
    }),
  ];
}

/**
 * As conferências, DEPOIS de gravar e ainda DENTRO da transação.
 *
 * ⚠️ CONFERIR SÓ ANTES PROVA O QUE SE ESPERAVA, NÃO O QUE ACONTECEU. Devolve a lista de
 * problemas; a rota faz ROLLBACK se ela não vier vazia. É tudo ou nada — transferir metade
 * deixaria a TR partida entre dois donos sem ninguém saber qual metade foi.
 */
function conferir({ foto, depois, movidas, deId, paraId }) {
  const p = [];
  const prev = pcsQueMovem(foto, deId).map((l) => l.codigo_pc).sort();
  const feitas = movidas.map((m) => m.codigo_pc).sort();
  if (prev.length !== feitas.length || prev.some((c, i) => c !== feitas[i])) {
    p.push(`o UPDATE mexeu num conjunto diferente do previsto: ${prev.length} previstas, ${feitas.length} movidas`);
  }
  const set = new Set(feitas);
  const porCodigo = new Map(depois.map((l) => [l.codigo_pc, l]));

  for (const c of feitas) {
    const d = porCodigo.get(c);
    if (!d) { p.push(`${c} sumiu da base depois do UPDATE`); continue; }
    if (d.analista_id !== paraId) p.push(`${c} continua com analista_id ${d.analista_id}`);
    if (d.baixada) p.push(`${c} está baixada e mesmo assim foi movida`);
  }
  // ⚠️ E AS QUE NÃO ERAM PARA SE MOVER: a prova de que a produtividade ficou onde estava.
  for (const a of foto) {
    if (set.has(a.codigo_pc)) continue;
    const d = porCodigo.get(a.codigo_pc);
    if (!d) { p.push(`${a.codigo_pc} sumiu da base`); continue; }
    if (d.analista_id !== a.analista_id) {
      p.push(`${a.codigo_pc} mudou de dono sem estar na lista (${a.analista_id} -> ${d.analista_id})`);
    }
  }
  if (foto.length !== depois.length) {
    p.push(`a base mudou de tamanho nas TRs tocadas: ${foto.length} -> ${depois.length}`);
  }
  return p;
}

module.exports = {
  EVENTO, validar, trsLimpas, trsAlheias, pcsQueMovem, pcsQueFicam,
  SQL_FOTO, SQL_MOVER, SQL_HIST, rotulo, paramsHistorico, conferir,
};
