// CAMINHO: sigpc-api/lib/ci.js
//
// CONTROLE INTERNO — a fila, a conversa e as duas saídas.
//
// O FLUXO, como o Richard descreveu em 12/08/2026:
//
//   O analista faz o parecer no SIGEF e encaminha ao CI. Isso JÁ CONTA COMO BAIXA, e a
//   baixa NUNCA é estornada, qualquer que seja o desfecho.
//
//   O técnico do CI pega o encaminhamento e decide entre duas:
//     1. 'de_acordo' — encaminha para a baixa do Secretário. Encerra e vai para o
//        histórico. NÃO some.
//     2. 'ressalva'  — devolve ao analista para corrigir ou argumentar. Depois de
//        respondida, volta ao CI. Pode ir e voltar quantas vezes for preciso.
//
// ⚠️ NADA AQUI TOCA NA BAIXA. `baixada`, `data_baixa` e `enviado_ci` ficam como estão em
// todo o ciclo. É regra de negócio, não detalhe: se a baixa caísse na devolução, o analista
// perderia produtividade por um ajuste de forma. Há teste que falha se um UPDATE daqui
// mencionar qualquer uma das três.
//
// ⚠️ A CONVERSA É POR PC (decisão do Richard). Mas o encaminhamento é por PARCELA:
// `POST /parcela/ci` marca todas as PCs de uma (tr, parcial_num) de uma vez, e há parcelas
// com 7 PCs na fila de hoje. Então a tela agrupa por parcela e o técnico escreve UMA vez;
// aqui isso vira **uma mensagem por PC**, com o mesmo texto e a mesma rodada. O banco
// guarda fiel, a tela não cobra sete vezes o mesmo texto.
//
// ⚠️ A DEVOLUÇÃO VAI PARA O DONO ATUAL da PC (`analista_id`), não para quem encaminhou —
// decisão do Richard em 12/08. Se a PC trocou de mãos, quem responde é quem está com ela.

const inval = require('./invalidada');

const SITUACOES = ['na_fila', 'com_analista', 'encerrado'];
const DECISOES  = ['de_acordo', 'ressalva'];
const DIRECOES  = ['ci_para_analista', 'analista_para_ci'];

const TEXTO_MAX = 4000;
const TEXTO_MIN = 10;

/**
 * A fila do CI numa situação. Devolve as PCs cruas — quem agrupa por parcela é a tela.
 *
 * `enviado_ci` não entra no WHERE: quem manda é `ci_situacao`. As duas colunas respondem
 * perguntas diferentes, e é por confundi-las que a devolução, antes, apagava a passagem
 * pelo CI.
 */
async function fila(db, situacao) {
  const s = SITUACOES.includes(situacao) ? situacao : 'na_fila';
  const { rows } = await db.query(
    `SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.processo_pc, p.processo_mae,
            p.codigo_nl, p.valor, p.parecer_tipo, p.analista_id, p.analista_nome, p.grupo,
            p.dt_envio_ci, p.ci_situacao, p.ci_rodada, p.ci_encerrado_em,
            -- ⚠️ ACRESCENTADOS EM 18/08/2026 para o cartão de decisão do C.I.
            --
            -- data_baixa: o técnico precisa saber QUANDO a analista baixou. A coluna sempre
            -- existiu (958 de 958 preenchidas na fila de hoje) e simplesmente não vinha.
            p.data_baixa,
            -- dias de espera, calculados no servidor: data civil brasileira, nunca
            -- CURRENT_DATE — o Postgres do Railway roda em UTC e depois das 21h o dia vira.
            ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - p.dt_envio_ci::date)::int AS dias_espera,
            -- ⚠️ O TEXTO do parecer mora em parcela_historico.observacao, e NÃO em
            -- prestacoes_contas — lá só existe o parecer_tipo, que é a categoria. E ele é
            -- RARO: 26 de 958 na fila de hoje. A tela precisa saber a diferença entre "não
            -- escreveu nada" e "não veio na consulta", e por isso o campo vem sempre, nulo
            -- quando não há. Sem isso o cartão mostraria um bloco de parecer vazio em 97%
            -- dos casos, sem dizer por quê.
            h.observacao AS parecer_texto,
            u.nome AS analista_nome_completo,
            e.nome AS encerrado_por_nome,
            (SELECT COUNT(*)::int FROM ci_mensagem m WHERE m.codigo_pc = p.codigo_pc) AS msgs
       FROM prestacoes_contas p
       LEFT JOIN usuarios u ON u.id = p.analista_id
       LEFT JOIN usuarios e ON e.id = p.ci_encerrado_por
       LEFT JOIN LATERAL (
         SELECT hh.observacao FROM parcela_historico hh
          WHERE hh.tr = p.tr AND hh.parcial_num = p.parcial_num
            AND hh.setorial_id = p.setorial_id AND hh.evento = 'parecer'
            AND hh.observacao IS NOT NULL AND btrim(hh.observacao) <> ''
          ORDER BY hh.criado_em DESC LIMIT 1) h ON true
      WHERE p.ci_situacao = $1
      ORDER BY p.dt_envio_ci, p.tr, p.parcial_num, p.codigo_pc`, [s]);
  return rows;
}

/** Quantas há em cada situação — alimenta os números das três abas. */
async function contagens(db) {
  const { rows } = await db.query(
    `SELECT ci_situacao, COUNT(*)::int AS n FROM prestacoes_contas
      WHERE ci_situacao IS NOT NULL AND ${inval.ativa('')} GROUP BY ci_situacao`);
  const out = { na_fila: 0, com_analista: 0, encerrado: 0 };
  rows.forEach(r => { if (r.ci_situacao in out) out[r.ci_situacao] = r.n; });
  return out;
}

/** A conversa de uma ou mais PCs, mais antiga primeiro. */
/**
 * A conversa de um conjunto de PCs — TODAS as rodadas, em ordem cronológica.
 *
 * ⚠️ NÃO FILTRA POR RODADA, E NÃO PODE FILTRAR. Ver a regra da rodada em `gravarMensagem`: a
 * mensagem de devolução fica uma rodada atrás da PC, então `WHERE rodada = p.ci_rodada` acha
 * ZERO — e zero mensagem parece "o C.I. não disse nada", que é o oposto do que aconteceu.
 *
 * ⚠️ A ORDEM É `criado_em`, não `rodada`. A rodada diz em que volta a mensagem nasceu; quem
 * responde "o que veio antes" é o relógio. Ordenar por rodada embaralharia ida e volta da
 * mesma volta.
 */
async function mensagens(db, codigosPc) {
  const lista = (Array.isArray(codigosPc) ? codigosPc : [codigosPc]).filter(Boolean);
  if (!lista.length) return [];
  const { rows } = await db.query(
    `SELECT * FROM ci_mensagem WHERE codigo_pc = ANY($1) ORDER BY criado_em, id`, [lista]);
  return rows;
}

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (!Array.isArray(b.codigos_pc) || !b.codigos_pc.length)
    return 'Selecione ao menos uma PC.';
  if (b.decisao !== undefined && !DECISOES.includes(b.decisao))
    return `decisao deve ser uma de: ${DECISOES.join(', ')}`;

  const texto = (b.texto ?? '').toString().trim();
  // ⚠️ NENHUMA DAS DUAS DECISÕES EXIGE TEXTO — mudou em 25/08/2026, por decisão do Richard.
  //
  // Até aqui a 'ressalva' exigia, "porque devolver sem dizer por quê deixa o analista sem o
  // que fazer". A tela nova põe **Observação (opcional)** nas duas opções, e o motivo é que
  // a própria decisão já diz o que fazer: o rótulo do segundo rádio é *"Parecer para
  // correção, verificar o processo no SGPe"*, e ele viaja inteiro na notificação. A
  // observação virou o complemento, não o recado.
  //
  // ⚠️ QUEM AINDA EXIGE É A RESPOSTA DO ANALISTA (`exigeTexto`, em `POST /ci/responder`):
  // ali o texto É a manifestação, e uma resposta em branco não responde nada.
  //
  // ⚠️ E A NOTIFICAÇÃO PRECISOU MUDAR JUNTO. O corpo trazia um bloco fixo
  // "O que o C.I. pediu:" logo abaixo da decisão; sem texto, o analista receberia um rótulo
  // seguido de vazio. O bloco agora só aparece quando há o que mostrar — ver `/ci/decidir`.
  if (b.exigeTexto) {
    if (!texto) return 'Escreva o que precisa ser verificado.';
    if (texto.length < TEXTO_MIN) return `Escreva ao menos ${TEXTO_MIN} caracteres.`;
  }
  if (texto.length > TEXTO_MAX) return `O texto passa de ${TEXTO_MAX} caracteres.`;
  return null;
}

/**
 * Grava a mesma mensagem para várias PCs, na rodada de cada uma.
 *
 * A rodada é lida da PC e não recebida da tela: a tela pode estar velha, e duas mensagens
 * na rodada errada embaralhariam a conversa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ A REGRA DA RODADA — decisão do Richard, 28/08/2026. NÃO É DEFEITO.
 *
 * **A mensagem de devolução fica UMA RODADA ATRÁS da PC, e está certa assim.**
 *
 * `ci_mensagem.rodada` é a rodada em que a mensagem FOI ESCRITA. `prestacoes_contas.ci_rodada`
 * é a rodada em que a PC ESTÁ AGORA. Quando o C.I. devolve, ele escreve na rodada corrente e
 * o `devolver` sobe a rodada logo depois — então a mensagem fica em `n` e a PC em `n+1`.
 *
 * Medido em 28/08: **129 de 129 mensagens do sistema estão em `rodada = 1` com a PC em
 * `ci_rodada = 2`**, em 46 TRs. Nenhuma bate, e nenhuma deveria bater.
 *
 * ⚠️ **NUNCA CASE `ci_mensagem.rodada = prestacoes_contas.ci_rodada`.** A consulta acha zero,
 * e o zero parece "não há conversa" em vez de "casei errado". Quem quiser a mensagem que
 * abriu a rodada corrente procura `rodada = ci_rodada - 1`; quem quiser a conversa inteira —
 * que é o caso normal — não filtra por rodada nenhuma. Ver `mensagens()`.
 *
 * ⚠️ E NÃO "CORRIJA" AS 129 subindo a rodada delas. Isso apagaria a informação de quando cada
 * uma foi escrita, que é a única coisa que a coluna guarda. A ordem da conversa sai de
 * `criado_em`, não da rodada.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function gravarMensagem(db, codigosPc, { direcao, texto, autor }) {
  const t = (texto ?? '').toString().trim();
  if (!t) return 0;
  const { rows } = await db.query(
    `INSERT INTO ci_mensagem (codigo_pc, rodada, direcao, texto, autor_id, autor_nome, autor_perfil)
     SELECT p.codigo_pc, GREATEST(p.ci_rodada, 1), $2::text, $3::text, $4::int, $5::text, $6::text
       FROM prestacoes_contas p
      WHERE p.codigo_pc = ANY($1)
     RETURNING id`,
    [codigosPc, direcao, t, autor?.id ?? null, autor?.nome ?? null, autor?.perfil ?? null]);
  return rows.length;
}

/**
 * A decisão do técnico do CI. Devolve as PCs afetadas, para a rota notificar.
 *
 * Tudo numa transação: a mensagem sem a mudança de situação deixaria o analista com um
 * recado e a PC parada na fila do CI; a mudança sem a mensagem, o contrário.
 */
async function decidir(db, { setorial_id, tr, parcial_num, decisao, texto, autor }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');

    // ⚠️ A CHAVE É A PARCELA — `(setorial_id, tr, parcial_num)`, a mesma de `carregarParcela`
    // e a mesma que o parecer da analista usa.  (26/08/2026)
    //
    // ⚠️ E O `AND ci_situacao = 'na_fila'` É A REGRA, não um detalhe de desempenho: **o C.I.
    // decide apenas o que a analista encaminhou**. Numa parcela parcialmente na fila, as PCs
    // não encaminhadas ficam fora do alvo, não são tocadas e NÃO bloqueiam a decisão. São 6
    // parcelas assim hoje, e nelas o que está de fora é PC não baixada — o `AND baixada =
    // true` de `POST /parcela/ci` a deixou para trás de propósito.
    //
    // Ele também continua segurando o clique duplo: decidida a parcela, ela sai de
    // `na_fila` e a segunda chamada não acha linha nenhuma.
    const alvo = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, setorial_id, analista_id, entidade, ci_rodada
         FROM prestacoes_contas
        WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3 AND ci_situacao = 'na_fila'
        ORDER BY codigo_pc
        FOR UPDATE`, [setorial_id, tr, String(parcial_num)]);
    if (!alvo.rows.length) {
      await cli.query('ROLLBACK');
      return { pcs: [], jaDecidido: true };
    }
    // ⚠️ A ESCRITA VAI POR LISTA EXPLÍCITA, e não repetindo o WHERE da parcela (armadilha 12).
    // A lista saiu do SELECT que travou as linhas: o que se escreve é exatamente o que se
    // travou e o que se devolve para a rota notificar. Repetir a condição abriria a janela
    // entre o SELECT e o UPDATE para uma PC nova entrar na parcela e ser decidida sem ter
    // sido lida.
    const codigos = alvo.rows.map(r => r.codigo_pc);

    await gravarMensagem(cli, codigos, { direcao: 'ci_para_analista', texto, autor });

    // ⚠️ É AQUI QUE A PC GANHA TÉCNICO — e em lugar nenhum antes.  (26/08/2026)
    //
    // Até 25/08 quem carimbava `ci_tecnico_id` era o ato de EXPANDIR a linha na tela: abrir
    // para ler era assumir. Em um dia isso pôs o nome do superadmin numa PC que ele não
    // analisa. A posse virou **consequência do parecer**: sem parecer, a PC continua na fila
    // e sem nome; e fechar o cartão sem decidir não deixa rastro nenhum.
    //
    // ⚠️ NOS DOIS CAMINHOS, e não só no de acordo. A devolvida para correção também precisa
    // dizer quem a devolveu — ela volta para a fila depois da resposta da analista, e sem
    // isto voltaria anônima, como se ninguém a tivesse olhado.
    //
    // ⚠️ E É `autor.id`, o mesmo id que a rota conferiu ser de um técnico do C.I. Aceitar um
    // `tecnico_id` vindo do corpo seria a quinta rota a confiar no que o cliente manda.
    const carimbo = `ci_tecnico_id = $2::int, ci_tecnico_em = NOW()`;

    if (decisao === 'de_acordo') {
      // ⚠️ NÃO mexe em baixada, data_baixa nem enviado_ci. A PC encerra no CI e a baixa
      // segue exatamente como estava.
      await cli.query(
        `UPDATE prestacoes_contas
            SET ci_situacao = 'encerrado', ci_encerrado_em = NOW(), ci_encerrado_por = $2::int,
                ${carimbo}, atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [codigos, autor?.id ?? null]);
    } else {
      // Devolve. A rodada sobe AQUI, e é ela que faz o sino avisar de novo na próxima volta.
      await cli.query(
        `UPDATE prestacoes_contas
            SET ci_situacao = 'com_analista', ci_rodada = GREATEST(ci_rodada, 1) + 1,
                ${carimbo}, atualizado_em = NOW()
          WHERE codigo_pc = ANY($1)`, [codigos, autor?.id ?? null]);
    }

    // ⚠️ A DECISÃO VAI PARA O `parcela_historico` (25/08/2026) — antes ela só existia na
    // `ci_mensagem` e no par `ci_encerrado_em`/`ci_encerrado_por`.
    //
    // A conversa do C.I. e a trilha da parcela respondem perguntas diferentes: a primeira é o
    // que foi dito ao analista, e some da vista quando o ciclo encerra; a segunda é o que
    // aconteceu com a parcela, e é ela que alguém abre meses depois para entender por que a
    // PC está como está. Sem esta linha, a **devolução** não deixava rastro nenhum na trilha —
    // `ci_encerrado_*` só é gravado no de acordo.
    //
    // ⚠️ UMA LINHA POR PARCELA — era uma por PC até 26/08/2026.
    //
    // Enquanto a decisão era por `codigo_pc`, uma linha por PC estava certa: eram atos
    // separados, em cliques separados, e podiam divergir. Agora é UM ato sobre a parcela, e
    // `parcela_historico` é indexado por `(tr, parcial_num)` — nove linhas idênticas na mesma
    // chave não acrescentam nada e enterram a trilha da parcela em repetição.
    //
    // O texto nomeia as PCs alcançadas porque a tabela não tem coluna `codigo_pc`, e porque
    // numa parcela parcialmente na fila é preciso saber QUAIS foram: as não encaminhadas
    // ficaram de fora e continuam como estavam.
    await cli.query(
      `INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
                                      valor_novo, analista_id, executado_por, observacao, criado_em)
       VALUES ($1::text, $2::text, $3::text, 'ci_decidiu', 'na_fila', $4::text,
               $5::int, NULL, $6::text, NOW())`,
      [tr, String(parcial_num), setorial_id,
       decisao === 'de_acordo' ? 'encerrado' : 'com_analista',
       autor?.id ?? null,
       `${autor?.nome || 'C.I.'} decidiu no Controle Interno sobre a parcela ${parcial_num} ` +
       `(${codigos.length} PC${codigos.length > 1 ? 's' : ''}: ${codigos.join(', ')}): ` +
       (decisao === 'de_acordo'
         ? 'Parecer do analista em acordo, baixado.'
         : 'Parecer para correção, verificar o processo no SGPe.') +
       (String(texto || '').trim() ? `\nObservação: ${String(texto).trim()}` : '')]);

    await cli.query('COMMIT');
    return { pcs: alvo.rows, jaDecidido: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/**
 * A resposta do analista. Volta a PC para a fila do CI.
 *
 * A rodada NÃO sobe aqui: uma ida e volta é uma rodada. Subir dos dois lados dobraria a
 * contagem e o "rodada 2" da tela deixaria de bater com o que aconteceu.
 *
 * ⚠️ ELA JÁ ATENDE A PC REABERTA, sem mudança nenhuma: `reabrir` deixa a PC exatamente em
 * `com_analista`, que é o que esta função exige. A porta de volta do analista já existia.
 */
async function responder(db, { codigos_pc, texto, autor }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const alvo = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, entidade, ci_rodada
         FROM prestacoes_contas
        WHERE codigo_pc = ANY($1) AND ci_situacao = 'com_analista'
        FOR UPDATE`, [codigos_pc]);
    if (!alvo.rows.length) {
      await cli.query('ROLLBACK');
      return { pcs: [], jaRespondido: true };
    }
    const codigos = alvo.rows.map(r => r.codigo_pc);

    await gravarMensagem(cli, codigos, { direcao: 'analista_para_ci', texto, autor });
    await cli.query(
      `UPDATE prestacoes_contas SET ci_situacao = 'na_fila', atualizado_em = NOW()
        WHERE codigo_pc = ANY($1)`, [codigos]);

    await cli.query('COMMIT');
    return { pcs: alvo.rows, jaRespondido: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REABRIR UMA PC ENCERRADA — a porta de volta que o ciclo não tinha (26/08/2026)
//
// O caso real: o processo volta pelo SGPe DEPOIS de o C.I. já ter encerrado a PC, e não há
// como devolvê-la ao analista dentro do sistema. `decidir` só olha `na_fila`, `responder` só
// olha `com_analista`, e nada lia `encerrado`. A PC ficava no chip Encerradas para sempre.
//
// ⚠️ O DESTINO É `com_analista`, NÃO `na_fila`. `na_fila` devolveria a PC à fila do C.I. —
// que é justamente quem está pedindo para devolvê-la. `com_analista` é o único estado que o
// analista vê como pendência dele, e é o mesmo estado em que o ramo `ressalva` a põe.
//
// ⚠️ A REABERTURA NÃO CARIMBA TÉCNICO — ordem do Richard, 26/08/2026. `ci_tecnico_id` e
// `ci_tecnico_em` continuam com UM caminho de escrita em todo o servidor: `decidir`, no
// mesmo UPDATE do parecer. Reabrir não é dar parecer; carimbar aqui poria o nome de quem
// reabriu no lugar reservado a quem decidiu, e a coluna deixaria de responder à sua pergunta.
//
// ⚠️ E NÃO TOCA `baixada`, `data_baixa`, `enviado_ci`, `dt_envio_ci`, `parecer_tipo` nem
// `estornada`. É a mesma regra do resto do arquivo, e pelo mesmo motivo: a PC reaberta é
// trabalho FEITO que precisa de mais uma volta, não trabalho anulado. Quem anula é o
// `puxar_ci`, e ele é outra coisa — desfaz um encaminhamento ERRADO.
//
// ⚠️ O SQL MORA EM CONSTANTES porque `reabrir` gerencia a própria transação, e a armadilha
// 11 do CLAUDE.md proíbe rodar contra o banco real uma função assim: o COMMIT dela
// confirmaria a transação de quem a chamou. O script de correção em lote abre a transação
// DELE e roda estas mesmas constantes — uma regra só, dois donos de transação.

// As colunas que o alvo lê, nas duas portas. Escritas uma vez: duas listas divergiriam, e a
// conferência do script compara justamente as que NÃO podem mudar.
const COLS_REABRIR = `codigo_pc, tr, parcial_num, setorial_id, analista_id, analista_nome, entidade,
         ci_situacao, ci_rodada, ci_encerrado_em, ci_encerrado_por, ci_tecnico_id, ci_tecnico_em,
         baixada, data_baixa, enviado_ci, dt_envio_ci, parecer_tipo, estornada, status`;

// ⚠️ DOIS ALVOS, UM UPDATE SÓ. A rota reabre uma PARCELA (a mesma unidade da decisão, desde
// 26/08); o script de correção em lote reabre uma LISTA DE PCs, porque o alvo dele nasce de
// uma lista de processos do SGPe e não de uma parcela. Os dois desembocam no MESMO
// `SQL_REABRIR`, que escreve pela lista de códigos travada no SELECT — então a regra do que
// muda é uma só, e o que difere é só como se escolhe o alvo.
const SQL_REABRIR_ALVO = `
  SELECT ${COLS_REABRIR}
    FROM prestacoes_contas
   WHERE codigo_pc = ANY($1) AND ci_situacao = 'encerrado'
   ORDER BY tr, parcial_num, codigo_pc
   FOR UPDATE`;

const SQL_REABRIR_ALVO_PARCELA = `
  SELECT ${COLS_REABRIR}
    FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3 AND ci_situacao = 'encerrado'
   ORDER BY codigo_pc
   FOR UPDATE`;

// ⚠️ O `AND ci_situacao = 'encerrado'` no UPDATE é o que torna a reabertura IDEMPOTENTE: a
// segunda passada não acha linha nenhuma e não soma outra rodada. Sem ele, dois cliques
// levariam a PC à rodada 4 sem nada ter acontecido entre um e outro.
const SQL_REABRIR = `
  UPDATE prestacoes_contas
     SET ci_situacao      = 'com_analista',
         ci_rodada        = GREATEST(ci_rodada, 1) + 1,
         ci_encerrado_em  = NULL,
         ci_encerrado_por = NULL,
         atualizado_em    = NOW()
   WHERE codigo_pc = ANY($1) AND ci_situacao = 'encerrado'
   RETURNING codigo_pc, tr, parcial_num, setorial_id, ci_rodada`;

// Uma linha POR PC, com o código no texto — `parcela_historico` é indexado por
// (tr, parcial_num) e não tem coluna `codigo_pc`. Mesmo formato do `ci_decidiu`.
const SQL_REABRIR_HISTORICO = `
  INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
                                 valor_novo, analista_id, executado_por, observacao, criado_em)
  SELECT p.tr, p.parcial_num, p.setorial_id, 'ci_reabriu', 'encerrado', 'com_analista',
         $2::int, NULL, $3::text, NOW()
    FROM prestacoes_contas p WHERE p.codigo_pc = $1`;

// Uma linha por PARCELA — a porta normal, desde 26/08/2026.
const SQL_REABRIR_HISTORICO_PARCELA = `
  INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior,
                                 valor_novo, analista_id, executado_por, observacao, criado_em)
  VALUES ($1::text, $2::text, $3::text, 'ci_reabriu', 'encerrado', 'com_analista',
          $4::int, NULL, $5::text, NOW())`;

/**
 * O texto da linha de histórico. Fora do SQL para o script escrever o mesmo que a rota.
 *
 * ⚠️ `alvo` É TEXTO LIVRE, e não um `codigo_pc`. Pela parcela ele vem como "parcela 3 (2 PCs:
 * A, B)"; pela lista de PCs, como o código sozinho. Uma frase fixa com "a PC" na frente
 * mentiria no primeiro caso — que é o caso normal desde 26/08.
 */
function textoReabertura(autorNome, alvo, motivo) {
  return `${autorNome || 'C.I.'} reabriu no Controle Interno: ${alvo}. `
       + 'O processo voltou pelo SGPe depois do encerramento e volta ao analista. '
       + 'A baixa e o encaminhamento ao C.I. seguem valendo.'
       + (String(motivo || '').trim() ? `\nMotivo: ${String(motivo).trim()}` : '');
}

/**
 * Reabre PCs encerradas e as devolve ao analista. Devolve as PCs afetadas, para a rota
 * notificar — a mesma forma de `decidir`.
 *
 * ⚠️ A MENSAGEM VAI ANTES DO UPDATE, e é de propósito: `gravarMensagem` lê a rodada da PC, e
 * antes do UPDATE ela ainda é a rodada em que o C.I. estava quando escreveu. É exatamente o
 * que `decidir` faz no ramo `ressalva` — a resposta do analista é que cai na rodada nova.
 *
 * ⚠️ **E É POR ISSO QUE A MENSAGEM FICA UMA RODADA ATRÁS DA PC.** Não é defeito: é a regra,
 * e ela está escrita por extenso em `gravarMensagem`. Inverter a ordem — subir a rodada antes
 * de escrever — poria a mensagem numa volta que ainda não tinha acontecido.
 */
async function reabrir(db, { setorial_id, tr, parcial_num, codigos_pc, texto, autor }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');

    // ⚠️ A PORTA NORMAL É A PARCELA — a mesma unidade de `decidir`, desde 26/08/2026. A
    // entrada por `codigos_pc` continua existindo para o script de correção em lote, cujo
    // alvo nasce de uma lista de processos do SGPe. Quem chama decide qual usar mandando
    // `tr`; nunca as duas.
    //
    // Só reabre o que está REALMENTE encerrado. Sem isto um clique duplo somaria duas
    // rodadas, e uma PC `na_fila` seria empurrada para `com_analista` sem ninguém decidir.
    const porParcela = tr != null && parcial_num != null;
    const alvo = porParcela
      ? await cli.query(SQL_REABRIR_ALVO_PARCELA, [setorial_id, tr, String(parcial_num)])
      : await cli.query(SQL_REABRIR_ALVO, [codigos_pc]);
    if (!alvo.rows.length) {
      await cli.query('ROLLBACK');
      return { pcs: [], jaReaberto: true };
    }
    const codigos = alvo.rows.map(r => r.codigo_pc);

    await gravarMensagem(cli, codigos, { direcao: 'ci_para_analista', texto, autor });
    await cli.query(SQL_REABRIR, [codigos]);

    // ⚠️ UMA LINHA POR PARCELA quando a porta é a parcela; uma por PC quando é a lista.
    // O motivo é o mesmo de `decidir`: pela parcela é UM ato, e nove linhas idênticas na
    // chave `(tr, parcial_num)` enterram a trilha. Pela lista de PCs os atos são separados —
    // as 23 de 26/08 vieram de 16 processos distintos — e cada uma merece a sua linha.
    if (porParcela) {
      await cli.query(SQL_REABRIR_HISTORICO_PARCELA,
        [tr, String(parcial_num), setorial_id, autor?.id ?? null,
         textoReabertura(autor?.nome, `parcela ${parcial_num} (${codigos.length} PC${codigos.length > 1 ? 's' : ''}: ${codigos.join(', ')})`, texto)]);
    } else {
      for (const r of alvo.rows) {
        await cli.query(SQL_REABRIR_HISTORICO,
          [r.codigo_pc, autor?.id ?? null, textoReabertura(autor?.nome, r.codigo_pc, texto)]);
      }
    }

    await cli.query('COMMIT');
    return { pcs: alvo.rows, jaReaberto: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/**
 * Uma notificação POR ENCAMINHAMENTO, não por PC.
 *
 * A parcela 1 da 2020TR000657 tem 7 PCs. Sem este agrupamento, devolvê-la encheria o sino
 * da Claudia com 7 avisos idênticos — e um sino que enche de repetição para de ser lido.
 */
function agruparPorParcela(pcs) {
  const mapa = new Map();
  pcs.forEach(p => {
    const k = `${p.tr}|${p.parcial_num}`;
    if (!mapa.has(k)) mapa.set(k, { tr: p.tr, parcial_num: p.parcial_num, entidade: p.entidade,
                                    analista_id: p.analista_id, rodada: p.ci_rodada, pcs: [] });
    mapa.get(k).pcs.push(p.codigo_pc);
  });
  return [...mapa.values()];
}

module.exports = {
  SITUACOES, DECISOES, DIRECOES, TEXTO_MIN, TEXTO_MAX,
  fila, contagens, mensagens, validar, gravarMensagem, decidir, responder, agruparPorParcela,
  reabrir, textoReabertura,
  SQL_REABRIR_ALVO, SQL_REABRIR_ALVO_PARCELA, SQL_REABRIR,
  SQL_REABRIR_HISTORICO, SQL_REABRIR_HISTORICO_PARCELA,
};
