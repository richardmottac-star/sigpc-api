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
  // ⚠️ OS DOIS ANDAM JUNTOS. Um número de portaria sem data de publicação não define
  // vigência nenhuma — e a vigência é o que o termo afirma. Aceitar um sem o outro deixaria
  // o termo com meia frase, e o termo é o documento que a coordenação assina.
  const temNum = !!String(b.portaria == null ? '' : b.portaria).trim();
  const temData = !!String(b.portaria_em == null ? '' : b.portaria_em).trim();
  if (temNum !== temData) return 'Informe o número E a data de publicação da portaria.';
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
// ⚠️ A PORTARIA DO DESTINO VIAJA COM O REPASSE, no `estado_anterior` de cada linha.
//
// Ela define a VIGÊNCIA do termo — "a partir de tal data o analista assume" —, e sem ela o
// termo não pode ser emitido. Onde ela mora quando existe é a tabela `substituicao`, que já
// responde "quem substituiu quem, por qual portaria, publicada quando": a linha 8 dela é
// exatamente o repasse Willian → Fabiana, com a 203/2026 de 21/08/2026.
//
// ⚠️ MAS QUANDO NÃO EXISTE, O LUGAR NÃO É A `substituicao` — decidido em 01/09/2026. As
// colunas dela se chamam `dispensado_id` e `dispensado_nome`: gravar ali um repasse entre
// dois analistas EM ATIVIDADE afirmaria uma dispensa que não houve. Dado errado no banco é
// pior que um campo a mais, e a ordem foi "grave junto com o repasse" — que é o histórico.
//
// ⚠️ E VAI NO `estado_anterior` PORQUE ELE É `jsonb` — nenhuma coluna nova, nenhum ALTER. O
// preço é a repetição em cada linha do lote; o ganho é o termo poder ser reemitido idêntico
// anos depois, mesmo que a `substituicao` mude.
function paramsHistorico({ movidas, foto, deId, paraId, deNome, paraNome, usuarioId, motivo,
                           portaria, portariaEm }) {
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
        portaria_destino: portaria || null, portaria_destino_em: portariaEm || null,
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


// ══════════════════════════════════════════════════════════════════════════════
//  A LISTA DOS REPASSES, O DETALHE, E O DESFAZER (01/09/2026)
// ══════════════════════════════════════════════════════════════════════════════
//
// ⚠️ UM REPASSE SE IDENTIFICA SEM COLUNA NOVA, e a prova está nos dados. O `criado_em` de
// `parcela_historico` tem default `now()`, e no Postgres o `now()` é o instante em que a
// TRANSAÇÃO começou — não o de cada linha. Então todas as linhas de um lote saem com o
// carimbo IDÊNTICO. Medido em 01/09 nas 32 linhas do repasse do Samoel: 32 linhas, UM carimbo
// (2026-08-28 16:55:05.084). O contraste prova que é do lote e não coincidência — o `parecer`
// tem 324 linhas e 324 carimbos, uma ação por transação.
//
// ⚠️ E É POR ISSO QUE O `now()` NÃO PODE VIRAR `clock_timestamp()` AQUI. São o oposto do caso
// do logout, onde o `NOW()` igualava dois carimbos que precisavam diferir (CLAUDE.md): aqui
// igualar É a função. Trocar por `clock_timestamp()` daria um carimbo por linha e o
// agrupamento se desfaria em 32 repasses de uma PC cada.
//
// ⚠️ O `:id` DAS ROTAS É O `MIN(id)` DO LOTE. Não é coluna nova, é uma linha de verdade que já
// existe: única, imutável, e que se pode abrir no banco para conferir. Um contador próprio
// seria uma segunda fonte para uma pergunta que a tabela já responde.
//
// ⚠️ A COLISÃO POSSÍVEL, dita por honestidade: dois repasses do MESMO par de→para começando no
// mesmo microssegundo cairiam no mesmo grupo. Não é impossível por construção — é improvável
// por operação, porque cada um é uma requisição HTTP. Não afirmo unicidade que não garanto.

const EVENTO_DESFEITA = 'transferencia_desfeita';

// ⚠️ OS DOIS EVENTOS ENTRAM NA LISTA. O `transferencia_dispensa` é o do script de 28/08, e
// aqueles 32 registros são um repasse tão real quanto os novos — escondê-los faria a tela
// dizer que a primeira transferência do sistema nunca aconteceu.
const EVENTOS_REPASSE = ['transferencia', 'transferencia_dispensa'];

const SQL_LISTA = `
  SELECT MIN(id)::int          AS id,
         criado_em,
         evento,
         valor_anterior,
         valor_novo,
         MAX(executado_por)::int AS executado_por,
         COUNT(*)::int           AS pcs,
         COUNT(DISTINCT tr)::int AS trs
    FROM parcela_historico
   WHERE evento = ANY($1::text[])
   GROUP BY criado_em, evento, valor_anterior, valor_novo
   ORDER BY criado_em DESC`;

/** O lote a que uma linha pertence — achado pelo `id`, e devolvido pela CHAVE dele. */
const SQL_LOTE_POR_ID = `
  SELECT criado_em, evento, valor_anterior, valor_novo
    FROM parcela_historico WHERE id = $1 AND evento = ANY($2::text[])`;

// ⚠️ O LOTE É ACHADO PELO `id` DENTRO DO SQL, e o `criado_em` NUNCA volta ao JavaScript.
// Foi um defeito real, pego em 01/09 contra o banco: a primeira versão lia a chave do lote
// numa consulta, trazia o `criado_em` para o Node e o mandava de volta como parâmetro — e o
// detalhe voltava VAZIO. A coluna é `timestamp WITHOUT time zone`, e um `Date` do JS chega
// com fuso: a comparação nunca casava. É a armadilha 18 noutra roupa, e não dava erro —
// devolvia zero linhas, que se lê como "este repasse não moveu nada".
//
// Com o `WITH lote` o carimbo fica dentro do Postgres do começo ao fim, e não há conversão
// para errar. As duas consultas abaixo entram pelo mesmo `id`, e pela mesma razão.
const SQL_DETALHE = `
  WITH lote AS (
    SELECT criado_em, evento, valor_anterior, valor_novo
      FROM parcela_historico WHERE id = $1 AND evento = ANY($2::text[]))
  SELECT h.id::int, h.tr, h.parcial_num,
         h.estado_anterior->>'codigo_pc'     AS codigo_pc,
         h.estado_anterior->>'analista_nome' AS analista_nome_anterior,
         -- ⚠️ A PORTARIA VEM DA FOTO DO REPASSE, e nao da substituicao de hoje: o termo tem
         -- de sair IGUAL na reemissao, anos depois, mesmo que a tabela de substituicoes mude.
         h.estado_anterior->>'portaria_destino'    AS portaria_destino,
         h.estado_anterior->>'portaria_destino_em' AS portaria_destino_em,
         p.entidade, p.baixada, p.analista_id AS analista_atual
    FROM parcela_historico h
    JOIN lote l ON h.criado_em = l.criado_em AND h.evento = l.evento
               AND h.valor_anterior = l.valor_anterior AND h.valor_novo = l.valor_novo
    LEFT JOIN prestacoes_contas p ON p.codigo_pc = h.estado_anterior->>'codigo_pc'
   ORDER BY h.tr, h.parcial_num, codigo_pc`;

// ── A TRAVA DO DESFAZER ─────────────────────────────────────────────────────
//
// ⚠️ DESFAZER UM REPASSE EM QUE ALGUÉM JÁ TRABALHOU APAGARIA O TRABALHO. A PC voltaria ao
// estoque sem dono, e o parecer, a baixa ou a ida ao C.I. que aconteceram DEPOIS ficariam
// órfãos — a PC apareceria livre com histórico de análise. Por isso a recusa é da operação
// INTEIRA, com a lista de quais impediram: desfazer só as intocadas partiria o repasse em
// dois pedaços e ninguém saberia qual metade voltou.
const EVENTOS_TRAVA = [
  'parecer', 'situacao', 'correcao_situacao', 'estorno', 'resposta_diligencia',
  'ci', 'ci_abriu', 'ci_decidiu', 'ci_reabriu', 'ci_assumiu', 'ci_devolveu', 'ci_passou',
  'puxar_ci', 'migracao_ci', 'engenharia_envio', 'engenharia_desfeito',
];

// ⚠️ PELA PARCELA, e não pelo `codigo_pc`: o histórico do parecer é gravado em
// `(setorial_id, tr, parcial_num)`, porque a análise é por PARCIAL. Procurar por `codigo_pc`
// não acharia o parecer que baixou aquela mesma PC — e a trava passaria batido justamente no
// evento mais comum.
//
// ⚠️ E ENTRA PELO `id` DO LOTE, como a `SQL_DETALHE` e pela mesma razão: o `criado_em` não
// pode ir e voltar pelo JavaScript. Ver o aviso lá em cima.
const SQL_MOV_POSTERIOR = `
  WITH lote AS (
    SELECT criado_em, evento, valor_anterior, valor_novo
      FROM parcela_historico WHERE id = $1 AND evento = ANY($2::text[]))
  SELECT DISTINCT h.tr, h.parcial_num, h.evento, h.criado_em
    FROM parcela_historico h, lote l
   WHERE h.criado_em > l.criado_em
     AND h.evento = ANY($3::text[])
     AND (h.tr, COALESCE(h.parcial_num,'')) IN (
           SELECT x.tr, COALESCE(x.parcial_num,'') FROM parcela_historico x, lote l2
            WHERE x.criado_em = l2.criado_em AND x.evento = l2.evento
              AND x.valor_anterior = l2.valor_anterior AND x.valor_novo = l2.valor_novo)
   ORDER BY h.criado_em`;

// ── O DESFAZER ──────────────────────────────────────────────────────────────
//
// ⚠️ AS PCs VÃO PARA O ESTOQUE, E NÃO DE VOLTA PARA QUEM SAIU — decisão do Richard. O repasse
// existe porque a pessoa de origem não vai mais analisar aquilo (dispensa, redistribuição);
// devolvê-las a ela recriaria o problema que o repasse resolveu. Voltam livres, para quem
// puder pegar.
//
// ⚠️ E QUEM DEVOLVE É A `devol.SQL_DEVOLVER`, a mesma da devolução do superadmin. "Livre" tem
// UMA definição no sistema (CLAUDE.md): em 16/08 havia duas, e 87 PCs caíam no vão entre
// elas. Escrever aqui um segundo `SET status='livre', analista_id=NULL` seria recriar o vão.

/** Valida o pedido de desfazer. */
function validarDesfazer(b) {
  if (!b) return 'Nada informado.';
  if (!b.usuario_id) return 'usuario_id é obrigatório.';
  return null;
}

/** Os dez arrays do histórico do DESFAZER — mesma tabela, mesmo formato, evento próprio. */
function paramsDesfeita({ linhas, lote, usuarioId, motivo }) {
  const n = linhas.length;
  const rep = (v) => Array(n).fill(v);
  return [
    linhas.map((l) => l.tr),
    linhas.map((l) => l.parcial_num),
    rep('FCEE'),
    rep(EVENTO_DESFEITA),
    // ⚠️ AS PONTAS INVERTEM: o `valor_anterior` do desfazer é o `valor_novo` do repasse, e o
    // destino é o ESTOQUE. Repetir as pontas do repasse faria a trilha ler ao contrário.
    rep(lote.valor_novo),
    rep('— · estoque'),
    rep(null),
    linhas.map((l) => `${l.codigo_pc} — repasse de ${lote.criado_em.toISOString().slice(0, 10)} `
      + `desfeito; a PC voltou ao estoque.${motivo ? ' ' + motivo : ''}`),
    rep(parseInt(usuarioId) || null),
    // ⚠️ A FOTO AQUI É A DE ANTES DO DESFAZER — de quem a PC era no momento em que voltou ao
    // estoque, e de qual repasse ela veio. É o que a pílula do Estoque lê depois.
    linhas.map((l) => JSON.stringify({
      codigo_pc: l.codigo_pc,
      analista_id: l.analista_atual,
      repasse_id: l.repasse_id,
      repasse_em: lote.criado_em,
      veio_de: lote.valor_anterior,
    })),
  ];
}

/** "48 · Samoel" -> { id: 48, nome: 'Samoel' }. Devolve null quando não dá para ler. */
function partirRotulo(v) {
  const m = String(v == null ? '' : v).match(/^(\d+)\s*·\s*(.*)$/);
  return m ? { id: parseInt(m[1], 10), nome: m[2].trim() } : null;
}

module.exports = {
  EVENTO, validar, trsLimpas, trsAlheias, pcsQueMovem, pcsQueFicam,
  EVENTO_DESFEITA, EVENTOS_REPASSE, EVENTOS_TRAVA,
  SQL_LISTA, SQL_LOTE_POR_ID, SQL_DETALHE, SQL_MOV_POSTERIOR,
  validarDesfazer, paramsDesfeita, partirRotulo,
  SQL_FOTO, SQL_MOVER, SQL_HIST, rotulo, paramsHistorico, conferir,
};
