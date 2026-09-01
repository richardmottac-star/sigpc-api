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

// ══════════════════════════════════════════════════════════════════════════════
//  OS AVISOS DO REPASSE (01/09/2026)
// ══════════════════════════════════════════════════════════════════════════════
//
// ⚠️ O TEXTO MORA AQUI, E NÃO SOLTO DENTRO DA ROTA. São quatro mensagens — repasse e desfazer,
// vezes analista e coordenação — e as quatro têm de dizer a mesma coisa com os mesmos números.
// Escritas em quatro lugares da `server.js`, divergiriam no primeiro ajuste: é o defeito dos
// dois ramos do cartão da parcial (armadilha 19 do front) na sua forma de servidor.
//
// ⚠️ E NENHUMA DELAS CONTA NADA: os números chegam prontos de quem gravou. Um aviso que
// recontasse por conta própria seria uma segunda fonte para o mesmo número, e um dia diria
// "32 prestações" ao analista e "31" ao coordenador sem que ninguém soubesse qual está certa.

/** "32 prestações" · "1 prestação" — o plural num lugar só. */
const nPcs = (n) => `${n} ${n === 1 ? 'prestação' : 'prestações'}`;
const nTrs = (n) => `${n} ${n === 1 ? 'TR' : 'TRs'}`;

/**
 * dd/mm/aaaa a partir do que o `pg` devolver.
 *
 * ⚠️ NÃO SE FATIA O TEXTO DE UM `Date` — armadilha 25 do sigpc-api, e a mesma pedra em que
 * esta rota já tropeçou em 01/09: `String(d).slice(0,10)` dá "Fri Aug 21", não "2026-08-21".
 * Aqui o valor pode chegar como `Date` (o `criado_em` do lote) ou como texto ISO.
 */
function dataBr(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return String(v.getDate()).padStart(2, '0') + '/'
         + String(v.getMonth() + 1).padStart(2, '0') + '/' + v.getFullYear();
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}

/**
 * O aviso do ANALISTA DE DESTINO.
 *
 * ⚠️ "N TÊM PRAZO VENCIDO" SÓ SAI QUANDO HÁ — ordem do Richard. A frase com zero ("0 têm prazo
 * vencido") é ruído que treina a pessoa a não ler o resto do aviso; e o aviso do repasse é
 * justamente o que ela precisa ler inteiro.
 */
function avisoDestino({ pcs, trs, deNome, quando, vencidas }) {
  return {
    titulo: `Você recebeu ${nPcs(pcs)} em ${nTrs(trs)}`,
    mensagem: `Repassadas de ${deNome} em ${dataBr(quando)}. `
      + 'Já estão na sua planilha e podem ser analisadas.'
      + (vencidas > 0
          ? ` ${vencidas} ${vencidas === 1 ? 'tem' : 'têm'} prazo vencido.`
          : ''),
  };
}

/**
 * O aviso da ORIGEM — quem ENTREGA o acervo.  (01/09/2026)
 *
 * ⚠️ A PERSPECTIVA É A DE QUEM ENTREGA, e é por isso que ele não reaproveita o texto do
 * destino: "você recebeu" e "saíram da sua planilha" são o mesmo fato lido dos dois lados, e o
 * lado errado faz a pessoa procurar na planilha o que já não está lá.
 *
 * ⚠️ E ELE DIZ QUE AS BAIXADAS FICAM. É a primeira pergunta de quem vê o acervo sair, e a
 * resposta é a regra central do repasse: a produtividade da PC baixada é de quem a analisou.
 */
function avisoOrigem({ pcs, trs, paraNome, quando }) {
  return {
    titulo: `${nPcs(pcs)} passaram para ${paraNome}`,
    mensagem: `${nPcs(pcs)} em ${nTrs(trs)}, sob sua responsabilidade, passaram para `
      + `${paraNome} em ${dataBr(quando)}. As já baixadas permanecem em seu nome, `
      + 'com a produtividade.',
  };
}

/** O aviso da COORDENAÇÃO — os três grupos, não só o do repasse. */
function avisoCoord({ pcs, grupo, deNome, paraNome, quando }) {
  return {
    titulo: `Repasse no Grupo ${grupo}`,
    mensagem: `${nPcs(pcs)} de ${deNome} passaram para ${paraNome} em ${dataBr(quando)}.`,
  };
}

/**
 * O aviso do DESFAZER, para quem PERDEU as PCs.
 *
 * ⚠️ QUEM PERDEU É O ANALISTA DE DESTINO DO REPASSE, não o de origem. É contraintuitivo pelo
 * nome e é o que os dados dizem: o desfazer manda as PCs ao ESTOQUE, e quem estava com elas
 * até aquele instante era o destino. Avisar a origem seria avisar quem não tem mais nada a ver
 * com aquele acervo desde o repasse.
 */
function avisoDesfeitoAnalista({ pcs, trs, quando, quandoRepasse }) {
  return {
    titulo: `${nPcs(pcs)} voltaram ao estoque`,
    mensagem: `O repasse de ${dataBr(quandoRepasse)} foi desfeito em ${dataBr(quando)}. `
      + `${nTrs(trs)} ${trs === 1 ? 'saiu' : 'saíram'} da sua planilha e `
      + `${trs === 1 ? 'está livre' : 'estão livres'} no estoque.`,
  };
}

/**
 * O aviso do desfazer para a ORIGEM.
 *
 * ⚠️ AS PCs NÃO VOLTAM PARA ELA, e o texto tem de dizer isso na primeira linha. O desfazer
 * manda tudo ao ESTOQUE — devolvê-las a quem já não ia analisá-las recriaria o problema que o
 * repasse resolveu. Sem essa frase, quem lê "o repasse foi desfeito" procura o acervo de volta
 * na própria planilha.
 */
function avisoDesfeitoOrigem({ pcs, trs, paraNome, quando, quandoRepasse }) {
  return {
    titulo: `O repasse para ${paraNome} foi desfeito`,
    mensagem: `O repasse de ${dataBr(quandoRepasse)} foi desfeito em ${dataBr(quando)}. `
      + `${nPcs(pcs)} em ${nTrs(trs)} voltaram ao ESTOQUE — não à sua planilha — e `
      + 'estão livres para quem puder assumir.',
  };
}

/** O aviso do desfazer para a COORDENAÇÃO. */
function avisoDesfeitoCoord({ pcs, grupo, paraNome, quando }) {
  return {
    titulo: `Repasse desfeito no Grupo ${grupo}`,
    mensagem: `${nPcs(pcs)} que estavam com ${paraNome} voltaram ao estoque em ${dataBr(quando)}.`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  A CIÊNCIA DO REPASSE (01/09/2026)
// ══════════════════════════════════════════════════════════════════════════════
//
// ⚠️ NENHUMA TABELA NOVA, NENHUM ALTER — e não é força de expressão: a ciência é uma LINHA do
// `parcela_historico`, com `evento = 'transferencia_ciencia'`, exatamente como o desfazer é
// uma linha com `transferencia_desfeita`. A coluna `evento` não tem CHECK (conferido em
// 31/08), e `estado_anterior` é `jsonb` e já existe. Foi por aí que o repasse inteiro coube
// sem tocar no esquema, e a ciência cabe pelo mesmo caminho.
//
// ⚠️ `tr` E `parcial_num` FICAM NULOS, de propósito. Toda outra linha desta tabela fala de UMA
// parcela; a ciência fala do REPASSE inteiro. Ancorá-la numa TR qualquer do lote — a primeira,
// digamos — faria a linha afirmar que aquela pessoa deu ciência daquela TR, o que é falso, e
// ainda a faria aparecer no histórico da parcela. Nulo aqui quer dizer "não é sobre parcela",
// e é a leitura honesta.
//
// ⚠️ O QUE ANCORA É O `valor_anterior`: `repasse:{id}`, o mesmo `MIN(id)` do lote que as rotas
// já usam. Sem coluna nova e sem contador próprio.
//
// ⚠️ E O EVENTO FICA DE FORA DAS TRÊS LISTAS QUE JÁ EXISTEM — `EVENTOS_REPASSE` (a ciência não
// é um repasse e não pode virar uma linha da lista) e `EVENTOS_TRAVA` (dar ciência não é
// trabalhar na PC: travar o desfazer por causa dela impediria de corrigir um repasse errado
// justamente depois de a pessoa ter lido que ele existe).
const EVENTO_CIENCIA = 'transferencia_ciencia';

/**
 * EM EXERCÍCIO — `data_saida IS NULL`, e nada mais.
 *
 * ⚠️ NÃO É `ativo`. Os sete dispensados continuam com `ativo = true` por decisão do Richard —
 * quem saiu precisa terminar o que ficou em curso —, então deduzir a dispensa do `ativo`
 * deixaria passar justamente as sete pessoas de quem não se cobra nada. É a mesma coluna que a
 * `ehDispensado` do front lê e que a `coordenadoresEmExercicio` consulta.
 *
 * ⚠️ E É UMA DEFINIÇÃO SÓ para a origem e para a coordenação. Duas condições escritas separadas
 * divergiriam no primeiro ajuste, e a que divergisse seria a que cobra ciência de quem saiu.
 */
const emExercicio = (u) => !!u && !u.data_saida;

/** A âncora da ciência no histórico — `repasse:412`. */
const ancoraCiencia = (repasseId) => `repasse:${parseInt(repasseId) || 0}`;

/**
 * EM QUE CONDIÇÃO esta pessoa dá ciência deste repasse — ou null, se não é dela.
 *
 * ⚠️ É A MESMA LISTA QUE RECEBEU O AVISO, e tem de continuar sendo: o analista de destino e a
 * coordenação em exercício dos três grupos. Quem recebeu um aviso e não pode registrar ciência
 * dele ficaria com um modal que não fecha; quem pode registrar sem ter sido avisado daria
 * ciência de algo que nunca leu.
 *
 * ⚠️ E A CONDIÇÃO DO COORDENADOR É O GRUPO **DELE**, não o do repasse — ordem do Richard. Um
 * repasse do Grupo 2 assinado pela coordenação do Grupo 1 é exatamente isso: a coordenação do
 * 1 tomando ciência. Escrever "coordenação do Grupo 2" ali seria pôr no documento um cargo que
 * a pessoa não ocupa.
 *
 * ⚠️ A ORIGEM DÁ CIÊNCIA DESDE 01/09/2026 — ordem do Richard, e é a correção de uma decisão
 * minha que estava errada: eu tinha escrito que ela não declara nada porque o repasse "tira PCs
 * dela". Tirar o acervo de alguém é justamente o que essa pessoa precisa saber, e o texto dela
 * é o de quem entrega, não o de quem assume.
 *
 * ⚠️ MAS SÓ QUANDO ESTÁ EM EXERCÍCIO. Dispensado não entra mais no sistema: cobrar ciência dele
 * abriria uma pendência que ninguém pode fechar, e ela ficaria no termo para sempre. E é o caso
 * PRINCIPAL desta tela — o repasse existe, na maioria das vezes, porque a pessoa saiu.
 */
function condicaoCiencia(quem, lote) {
  if (!quem || !lote) return null;
  const para = partirRotulo(lote.valor_novo);
  if (para && para.id === quem.id) return 'analista de destino';
  // ⚠️ O DESTINO É CONFERIDO PRIMEIRO, e a ordem não é indiferente: a rota já recusa
  // `de === para`, mas se um dia deixasse passar, quem RECEBE tem de ler o texto de quem
  // recebe. Ele é o único que declara assumir a análise.
  const de = partirRotulo(lote.valor_anterior);
  if (de && de.id === quem.id) return emExercicio(quem) ? 'analista de origem' : null;
  if (quem.perfil === 'coordenador' && emExercicio(quem)) {
    return `coordenação do Grupo ${quem.grupo == null || quem.grupo === '' ? '—' : quem.grupo}`;
  }
  return null;
}

// ⚠️ O "NÃO SE REPETE" VIVE DENTRO DO INSERT, e não num SELECT antes dele. É a mesma escolha do
// dedupe de `lib/notificacao.js`, pela mesma razão: conferir antes e inserir depois deixa a
// fresta de dois cliques simultâneos passarem os dois. Não há índice único porque isso exigiria
// ALTER, e a tabela é do Richard.
//
// ⚠️ E NÃO EXISTE ROTA QUE APAGUE. "Não se apaga" não é uma trava a escrever: é a ausência
// deliberada de um DELETE. Uma ciência retirável não seria ciência de coisa nenhuma.
const SQL_CIENCIA_GRAVAR = `
  INSERT INTO parcela_historico
    (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo,
     analista_id, observacao, executado_por, estado_anterior)
  SELECT NULL::text, NULL::text, $1::text, $2::text, $3::text, $4::text,
         $5::int, $6::text, NULL::int, $7::jsonb
   WHERE NOT EXISTS (
     SELECT 1 FROM parcela_historico x
      WHERE x.evento = $2::text
        AND x.valor_anterior = $3::text
        AND x.analista_id = $5::int)
  RETURNING id, criado_em`;

// ── O REPASSE DESFEITO SAI DA FILA DE CIÊNCIA (01/09/2026) ──────────────────
//
// ⚠️ ORDEM DO RICHARD, e ela conserta um defeito medido em produção: o repasse 2381
// (Willian → Fabiana, 1 PC) foi desfeito, a PC voltou ao estoque `livre` e sem dono — e a
// `ciencia_pendente` continuava respondendo SIM para ele, porque filtrava por `evento` e por
// ciência já dada, e não olhava o desfazer. O modal pediria que quatro pessoas declarassem
// "assumo a análise das prestações relacionadas" sobre uma PC que está no estoque. E a ciência,
// uma vez declarada, não se apaga.
//
// ⚠️ COMO SE SABE QUE FOI DESFEITO: pelas linhas de `transferencia_desfeita`, que a
// `paramsDesfeita` grava com o `repasse_id` dentro do `estado_anterior`. Não há coluna
// "desfeito" no lote do repasse, e não pode haver: ela seria uma segunda verdade sobre um
// fato que o histórico já registra — o mesmo motivo pelo qual a pílula do Estoque é derivada.
//
// ⚠️ E O TERMO CONTINUA EXISTINDO. Um repasse desfeito aconteceu: o documento dele é a prova de
// que aconteceu, e apagá-lo seria reescrever o passado. O que sai é a COBRANÇA — pendente de um
// repasse revogado é uma dívida que ninguém deve.
const SQL_DESFEITOS = `
  SELECT DISTINCT (estado_anterior->>'repasse_id')::int AS repasse_id
    FROM parcela_historico
   WHERE evento = $1::text
     AND (estado_anterior->>'repasse_id')::int = ANY($2::int[])`;

/** As notificações do repasse que ainda não foram lidas — apagadas quando ele é desfeito. */
//
// ⚠️ SÓ AS NÃO LIDAS. Quem já leu viu um fato que era verdade quando leu, e vai receber o aviso
// do desfazer logo em seguida: apagar o que a pessoa leu esconderia metade da história. O que
// não pode ficar é o aviso que ela ainda vai abrir, anunciando um repasse que não existe mais.
//
// ⚠️ E É `DELETE`, não "marcar como lida": marcar afirmaria que alguém leu, e ninguém leu. A
// tabela não tem coluna para "revogada" e criá-la exigiria ALTER, que é do Richard.
const SQL_NOTIF_DO_REPASSE = `
  DELETE FROM notificacao
   WHERE tipo = 'repasse' AND ref_id = $1::text AND lida_em IS NULL`;

/** As ciências de um repasse, da mais antiga para a mais nova — a ordem em que foram dadas. */
const SQL_CIENCIAS = `
  SELECT h.id::int, h.criado_em, h.valor_novo AS condicao, h.analista_id::int,
         COALESCE(u.nome, h.estado_anterior->>'nome') AS nome
    FROM parcela_historico h
    LEFT JOIN usuarios u ON u.id = h.analista_id
   WHERE h.evento = $1::text AND h.valor_anterior = $2::text
   ORDER BY h.criado_em, h.id`;

/** Quantas ciências cada repasse já tem — uma consulta para a lista inteira, nunca N+1. */
const SQL_CIENCIAS_CONTA = `
  SELECT valor_anterior AS ancora, COUNT(*)::int n
    FROM parcela_historico
   WHERE evento = $1::text AND valor_anterior = ANY($2::text[])
   GROUP BY valor_anterior`;

/** Os sete parâmetros do `SQL_CIENCIA_GRAVAR`, na ordem. */
function paramsCiencia({ repasseId, condicao, quem, quando }) {
  return [
    'FCEE',
    EVENTO_CIENCIA,
    ancoraCiencia(repasseId),
    condicao,
    parseInt(quem.id),
    `${quem.nome} declarou ciência do repasse ${repasseId}, na condição de ${condicao}.`,
    // ⚠️ O NOME VIAJA JUNTO, além do `analista_id`. O termo é reemitido anos depois, e a
    // pessoa pode ter saído do cadastro — a leitura prefere `usuarios.nome` quando existe e
    // cai para este aqui quando não. É o mesmo motivo pelo qual a portaria viaja no
    // `estado_anterior` do repasse.
    JSON.stringify({ repasse_id: parseInt(repasseId) || 0, usuario_id: parseInt(quem.id),
                     nome: quem.nome, condicao, grupo: quem.grupo == null ? null : String(quem.grupo),
                     quando: quando || null }),
  ];
}

module.exports = {
  EVENTO, validar, trsLimpas, trsAlheias, pcsQueMovem, pcsQueFicam,
  dataBr, avisoDestino, avisoCoord, avisoDesfeitoAnalista, avisoDesfeitoCoord,
  avisoOrigem, avisoDesfeitoOrigem, emExercicio,
  EVENTO_CIENCIA, ancoraCiencia, condicaoCiencia, paramsCiencia,
  SQL_CIENCIA_GRAVAR, SQL_CIENCIAS, SQL_CIENCIAS_CONTA, SQL_DESFEITOS, SQL_NOTIF_DO_REPASSE,
  EVENTO_DESFEITA, EVENTOS_REPASSE, EVENTOS_TRAVA,
  SQL_LISTA, SQL_LOTE_POR_ID, SQL_DETALHE, SQL_MOV_POSTERIOR,
  validarDesfazer, paramsDesfeita, partirRotulo,
  SQL_FOTO, SQL_MOVER, SQL_HIST, rotulo, paramsHistorico, conferir,
};
