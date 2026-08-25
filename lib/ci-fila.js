// CAMINHO: sigpc-api/lib/ci-fila.js
//
// A FILA DO CONTROLE INTERNO — POR PC.  (reescrita em 25/08/2026)
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ ESTA LIB ERA POR TR ATÉ 25/08/2026, E A UNIDADE MUDOU POR DECISÃO DO RICHARD.
//
// A versão de 24/08 pendurava o responsável na TR, numa tabela `ci_responsavel` à parte, e
// a tela abria TR por TR. **O Controle Interno não trabalha assim: ele trabalha por PC.**
// A TR do analista tem até 83 PCs, e o técnico do C.I. examina uma prestação de cada vez —
// um valor, um processo SGPe, uma NL, um parecer.
//
// A troca não perdeu nada: `ci_responsavel` estava VAZIA (0 linhas) e o histórico não tinha
// um único evento da fila por TR. Ninguém chegou a assumir. Ver
// `migracao_ci_por_pc_20260825.js`, que mede isso antes de mexer e aborta se não bater.
//
// ⚠️ O RESPONSÁVEL AGORA MORA NA PRÓPRIA LINHA: `prestacoes_contas.ci_tecnico_id` e
// `ci_tecnico_em`, ao lado de `ci_situacao`, `ci_rodada`, `ci_encerrado_em` e
// `ci_encerrado_por`. Uma tabela ao lado exigiria um JOIN em toda leitura para responder
// algo que cabe na linha, e abriria a porta para PC sem linha correspondente.
//
// ⚠️ `ci_tecnico_id` E `ci_encerrado_por` NÃO SÃO A MESMA PERGUNTA. O primeiro é quem está
// com ela AGORA; o segundo é quem decidiu no fim. Uma PC encerrada tem os dois, e eles podem
// diferir — a de acordo é do técnico que a abriu, mas quem destrava caso trave é o superadmin.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ QUEM É TÉCNICO DO C.I. TEM UMA FONTE SÓ: `usuarios.perfil = 'controle_interno'`.
// É a mesma que o `POST /ci/responder` já usava, a mesma do `contaProdutividade` da tela e a
// mesma da regra dos três ids do CLAUDE.md. Uma lista paralela aqui — por id, por nome, por
// flag nova — seria uma segunda resposta para "quem é do C.I.", e um dia as duas divergiriam
// sem erro nenhum.

const papel = require('./papel');

const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;

/**
 * ⚠️ O TETO DA LISTA, E ELE É DITO NA TELA.
 *
 * São 2.928 PCs no ciclo do C.I. hoje. Mandar todas em toda abertura repetiria o problema
 * das seis telas que baixam o acervo inteiro para filtrar no cliente (Pendências do
 * CLAUDE.md). O recorte é feito no banco, e quando sobra mais que isto a tela **diz quantas
 * ficaram de fora** — um corte silencioso se lê como "é só isso que existe".
 */
const LIMITE = 300;

// ── O tempo de espera ────────────────────────────────────────────────────────
//
// ⚠️ DOIS PASSOS NO `AT TIME ZONE`, E NÃO UM (armadilha 18). `dt_envio_ci` é
// `timestamp WITHOUT time zone` guardando UTC. `col AT TIME ZONE 'America/Sao_Paulo'` sozinho
// INTERPRETA o valor como se fosse de Brasília e soma 3 h; o certo é converter de UTC para
// Brasília. Sem isto, uma PC encaminhada às 22h de Brasília nasce com um dia de espera.
//
// O lado esquerdo é `NOW()`, que é `timestamptz` — aí um passo só é o certo, e é por isso
// que os dois lados desta subtração não são simétricos.
const SQL_DIAS = `((NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                   - ((p.dt_envio_ci AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)::int`;

// ⚠️ HOUVE UMA `diasEspera` EM JAVASCRIPT AQUI, E ELA FOI REMOVIDA EM 25/08/2026.
//
// Ela calculava a mesma espera que o `SQL_DIAS` acima, para quando a conta fosse feita no
// Node. Duas implementações do mesmo número, e elas **divergiam**: medido contra o banco, em
// 200 linhas da fila, **12 davam respostas diferentes** — 6%.
//
// A causa é a armadilha 18 de novo, pelo lado do driver. O `pg` devolve `timestamp WITHOUT
// time zone` como `Date` interpretado no fuso LOCAL: uma PC encaminhada às 22h de Brasília
// está gravada como `01:00` do dia seguinte em UTC, e o Node lia o dia seguinte. O SQL, que
// converte de UTC para Brasília em dois passos, lê o dia certo. **O SQL estava certo e o
// JavaScript, errado** — nas 12 linhas encaminhadas entre 21h e meia-noite.
//
// Não foi corrigida: foi apagada. Ela não era chamada por rota nenhuma — a lista já traz
// `dias_espera` calculado pelo banco — e existia só para o próprio teste. Uma segunda conta
// para o mesmo número é a coisa que a `faixaEspera` abaixo existe para evitar, e mantê-la
// "corrigida" só adiaria o dia em que as duas voltassem a divergir.
//
// ⚠️ SE ALGUÉM PRECISAR DA ESPERA NO NAVEGADOR, o caminho é o servidor mandar — como manda
// hoje —, e não reimplementar a conta lá.

/**
 * A faixa de espera. Três, e são as mesmas cores da tela.
 *
 * ⚠️ AS BORDAS MORAM AQUI, num lugar só. Enquanto a etiqueta, o chip "Mais de 30 dias" e o
 * card do painel tivessem cada um a sua comparação, bastava mexer numa para a linha ficar
 * âmbar e sumir do chip que deveria contá-la.
 */
function faixaEspera(dias) {
  if (dias === null || dias === undefined) return null;
  if (dias > 30) return 'critica';
  if (dias > 15) return 'atencao';
  return 'ok';
}

// ── A busca por processo SGPe, em três campos ────────────────────────────────
//
// ⚠️ `SCC 00009692/2024` E `SCC9692/2024` SÃO O MESMO PROCESSO, e os dois estão no banco.
// Medido: das PCs no ciclo do C.I., umas vêm com espaço e zeros à esquerda, outras coladas e
// sem zeros — e há caso em MINÚSCULAS (`scc 8134/2024`). É o mesmo par de grafias que fez a
// regra falsa da armadilha 16 sobreviver meses: na comparação crua eles se passam por
// processos diferentes.
//
// Então os DOIS LADOS passam pela mesma normalização: sigla em maiúsculas e só letras,
// número sem pontuação e sem zeros à esquerda, ano com quatro dígitos.
//
// ⚠️ NORMALIZAR SÓ O QUE O USUÁRIO DIGITA NÃO RESOLVE — é o dado gravado que está em duas
// grafias. Comparar o digitado normalizado com a coluna crua acha uma metade e some com a
// outra, sem erro nenhum na tela.
//
// ⚠️ E OS TRÊS CAMPOS SÃO OBRIGATÓRIOS, de propósito (decisão do Richard). Buscar só por
// número devolveria o `SCC 7537` de sete anos diferentes — é a armadilha 19 dita como
// interface: um resultado a mais não é ambiguidade resolvida, é ambiguidade escondida.
const SQL_SGPE_NUM = `regexp_replace(split_part(p.processo_pc, '/', 1), '[^0-9]', '', 'g')`;
const SQL_SGPE_ANO = `regexp_replace(split_part(p.processo_pc, '/', 2), '[^0-9]', '', 'g')`;
const SQL_SGPE_CHAVE = `(
  upper(regexp_replace(split_part(p.processo_pc, '/', 1), '[^A-Za-z]', '', 'g')) || '/' ||
  COALESCE(NULLIF(ltrim(${SQL_SGPE_NUM}, '0'), ''), '0') || '/' ||
  CASE WHEN length(${SQL_SGPE_ANO}) = 2 THEN '20' || ${SQL_SGPE_ANO} ELSE ${SQL_SGPE_ANO} END)`;

/** A mesma normalização, do lado de quem digitou. Devolve null quando falta um dos três. */
function chaveSgpe(sigla, numero, ano) {
  const s = String(sigla ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const n = String(numero ?? '').replace(/[^0-9]/g, '').replace(/^0+/, '');
  let a = String(ano ?? '').replace(/[^0-9]/g, '');
  if (a.length === 2) a = '20' + a;
  if (!s || !numero || !a) return null;
  return `${s}/${n || '0'}/${a}`;
}

/** O que falta para a busca por SGPe valer — é o `title` do botão desabilitado. */
function faltaSgpe(sigla, numero, ano) {
  const falta = [];
  if (!String(sigla ?? '').replace(/[^A-Za-z]/g, '')) falta.push('a sigla');
  if (!String(numero ?? '').replace(/[^0-9]/g, '')) falta.push('o número');
  if (!String(ano ?? '').replace(/[^0-9]/g, '')) falta.push('o ano');
  return falta.length ? `Informe ${falta.join(', ')} do processo.` : null;
}

// ── Quem pode ───────────────────────────────────────────────────────────────

/**
 * Quem pode mexer na fila do C.I.?
 *
 * ⚠️ Os três técnicos podem tudo, inclusive sobre PC de outro. O superadmin entra pelo
 * `perfilEfetivo`, que é a regra única das rotas desde 14/08: no papel analista ele É
 * analista, e não passa aqui.
 *
 * ⚠️ O COORDENADOR ENTROU EM 24/08/2026, e não é detalhe de permissão — é o que faz o item
 * de menu dele funcionar. O menu abre esta tela para `coordenador` e `superadmin`; com o
 * coordenador fora desta lista, ele veria o item, clicaria e leria "Esta fila é do Controle
 * Interno" — a tela que aceita ser aberta e não responde, que é a armadilha 15 vestida de
 * autorização.
 */
function podeAgir(u) {
  if (!u) return false;
  const p = papel.perfilEfetivo(u);
  return p === 'controle_interno' || p === 'coordenador' || p === 'superadmin';
}

/**
 * ⚠️ VOCÊ DECIDE A PC QUE É SUA.
 *
 *   · PC sem técnico  → abrir já a marca como sua, e aí você decide.
 *   · PC de outro     → você abre e vê; quem decide é quem está com ela.
 *   · superadmin      → decide sem restrição, porque é ele quem destrava o que travou.
 *
 * ⚠️ E ISTO VIVE NO SERVIDOR, não só no botão cinza. Desabilitar na tela avisa; recusar na
 * rota impede — e a diferença aparece no dia em que alguém tiver duas abas abertas e a
 * segunda ainda mostrar a PC como sua.
 */
function podeDecidir(quem, tecnicoId) {
  if (!quem) return false;
  if (papel.perfilEfetivo(quem) === 'superadmin') return true;
  return !!tecnicoId && Number(tecnicoId) === Number(quem.id);
}

/** O motivo da recusa, para a tela poder dizer POR QUE em vez de só apagar o botão. */
function motivoNaoDecide(tecnicoNome) {
  return tecnicoNome
    ? `Esta PC está com ${tecnicoNome}. Peça que ela passe a demanda para você.`
    : 'Abra a PC para que ela fique com você.';
}

/** O motivo serve? Devolve a mensagem de erro, ou null. Usado pelo "passar a outro". */
function validarMotivo(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return 'O motivo é obrigatório.';
  if (t.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;
  if (t.length > MOTIVO_MAX) return `O motivo passa de ${MOTIVO_MAX} caracteres.`;
  return null;
}

// ── Os números do topo ──────────────────────────────────────────────────────
//
// ⚠️ OS QUATRO CARDS E OS CINCO CHIPS SAEM DE UMA CONSULTA SÓ, e não de uma por número.
// Cinco consultas seriam cinco fotos de instantes diferentes, e bastaria uma PC ser decidida
// no meio para o chip dizer 12 e a lista mostrar 11. É a mesma escolha do
// `GET /prestacoes_contas/painel`.
//
// ⚠️ E ELES NÃO SOFREM O FILTRO DA LISTA. O card "na fila" diz quantas há na fila, não
// quantas sobraram da busca — um número que muda quando você digita deixa de ser o retrato
// do serviço e vira o eco do campo de texto.
const SQL_RESUMO = `
  SELECT
    COUNT(*) FILTER (WHERE p.ci_situacao = 'na_fila')::int                         AS fila,
    COUNT(*) FILTER (WHERE p.ci_situacao = 'com_analista')::int                    AS com_analista,
    COUNT(*) FILTER (WHERE p.ci_situacao = 'encerrado')::int                       AS encerradas,
    COUNT(*) FILTER (WHERE p.ci_situacao = 'na_fila' AND p.ci_tecnico_id = $1::int)::int AS minhas,
    COUNT(*) FILTER (WHERE p.ci_situacao = 'na_fila' AND p.ci_tecnico_id IS NOT NULL
                       AND p.ci_tecnico_id <> $1::int)::int                        AS outros,
    COUNT(*) FILTER (WHERE p.ci_situacao = 'na_fila' AND ${SQL_DIAS} > 30)::int    AS mais30,
    -- ⚠️ A MÉDIA É SÓ DA FILA. Incluir as encerradas misturaria o que espera com o que já
    -- saiu, e a carga histórica traria 1.737 PCs com data de 30/06 puxando a conta para cima.
    ROUND(AVG(${SQL_DIAS}) FILTER (WHERE p.ci_situacao = 'na_fila'))::int          AS espera_media
    FROM prestacoes_contas p
   WHERE p.ci_situacao IS NOT NULL`;

const SQL_TECNICOS = `
  SELECT id, nome FROM usuarios
   WHERE perfil = 'controle_interno' AND ativo = true ORDER BY nome`;

/** Os analistas que TÊM PC no ciclo — é o select do filtro, e não o cadastro inteiro. */
const SQL_ANALISTAS = `
  SELECT DISTINCT p.analista_id AS id, MAX(p.analista_nome) AS nome
    FROM prestacoes_contas p
   WHERE p.ci_situacao IS NOT NULL AND p.analista_id IS NOT NULL
   GROUP BY p.analista_id ORDER BY 2`;

// ── A lista ─────────────────────────────────────────────────────────────────

const CHIPS = ['fila', 'minhas', 'outros', 'mais30', 'encerradas', 'com_analista'];
const ESPERAS = ['ok', 'atencao', 'critica'];

/**
 * Monta o WHERE da lista a partir do que a tela mandou. Devolve `{ sql, params }`.
 *
 * ⚠️ TUDO POR `$n`, NUNCA POR CONCATENAÇÃO. O que vem da tela é texto de usuário, e o único
 * lugar em que ele entra na string do SQL é o nome de um parâmetro que este arquivo escreve.
 *
 * ⚠️ OS DOIS BLOCOS DE BUSCA SÃO EXCLUDENTES, e a decisão é do Richard: usar um limpa o
 * outro. Combiná-los pareceria mais poderoso e devolveria vazio silencioso toda vez que o
 * processo digitado não fosse o da entidade digitada — o usuário leria "não existe" para uma
 * PC que existe.
 */
function montarFiltro({ chip, meuId, q, sgpe, analista_id, espera }) {
  // ⚠️ O `meuId` SÓ ENTRA NOS PARÂMETROS QUANDO O CHIP O USA — e isto não é economia, é a
  // correção de um erro medido contra o banco em 25/08/2026:
  //
  //   bind message supplies 1 parameters, but prepared statement "" requires 0
  //
  // A primeira versão punha `meuId` em `$1` sempre e escrevia `$1::int` à mão nos dois chips
  // que precisam dele. Nos outros quatro — fila, mais de 30 dias, encerradas e com o analista
  // — o SQL saía SEM nenhum `$1`, e o `pg` recusa um parâmetro que a consulta não usa. Quatro
  // dos seis recortes da tela quebravam, e **nenhum dos 145 testes com dublê pegava**: o dublê
  // guarda o SQL e os params, e não os confere um contra o outro. Foi a prova contra o
  // Postgres de verdade que achou — a mesma lição dos quatro defeitos de SQL de 10–11/08.
  const params = [];
  const w = [`p.ci_situacao IS NOT NULL`];
  const p$ = (v) => { params.push(v); return '$' + params.length; };
  const eu = () => `${p$(parseInt(meuId) || 0)}::int`;

  // ⚠️ A BUSCA POR PROCESSO É DECIDIDA ANTES DO CHIP, e não depois. Quem digita um processo
  // quer aquele processo, e não "aquele processo, se por acaso estiver no recorte que estava
  // aberto" — mas a primeira versão montava o chip primeiro e depois zerava as condições com
  // `w.length = 1`. **Isso apagava o `p.ci_tecnico_id = $1` e deixava o `meuId` órfão na lista
  // de parâmetros**, e o `pg` recusa parâmetro que a consulta não usa: buscar um processo com
  // o chip "Comigo" ou "Com outros" aberto quebrava, e só esses dois.
  //
  // É o MESMO erro de duas linhas acima, na segunda encarnação. Zerar o SQL sem zerar os
  // parâmetros é a mesma coisa que criar parâmetro sem usar — e por isso o teste passou a
  // conferir os `$n` contra o `params.length` em todas as combinações de chip e filtro.
  if (sgpe) {
    w.push(`${SQL_SGPE_CHAVE} = ${p$(sgpe)}`);
    return { sql: w.join(' AND '), params };
  }

  switch (chip) {
    case 'minhas':       w.push(`p.ci_situacao = 'na_fila'`, `p.ci_tecnico_id = ${eu()}`); break;
    case 'outros':       w.push(`p.ci_situacao = 'na_fila'`, `p.ci_tecnico_id IS NOT NULL`,
                                `p.ci_tecnico_id <> ${eu()}`); break;
    case 'mais30':       w.push(`p.ci_situacao = 'na_fila'`, `${SQL_DIAS} > 30`); break;
    case 'encerradas':   w.push(`p.ci_situacao = 'encerrado'`); break;
    case 'com_analista': w.push(`p.ci_situacao = 'com_analista'`); break;
    default:             w.push(`p.ci_situacao = 'na_fila'`);
  }

  {
    const t = String(q ?? '').trim();
    if (t) {
      const like = `%${t.replace(/[%_]/g, m => '\\' + m)}%`;
      w.push(`(p.codigo_pc ILIKE ${p$(like)} OR p.tr ILIKE $${params.length}
                OR p.entidade ILIKE $${params.length} OR p.analista_nome ILIKE $${params.length})`);
    }
    const a = parseInt(analista_id) || 0;
    if (a) w.push(`p.analista_id = ${p$(a)}`);
    if (ESPERAS.includes(espera)) {
      w.push(espera === 'critica' ? `${SQL_DIAS} > 30`
           : espera === 'atencao' ? `${SQL_DIAS} > 15 AND ${SQL_DIAS} <= 30`
           :                        `${SQL_DIAS} <= 15`);
    }
  }
  return { sql: w.join(' AND '), params };
}

/**
 * A lista, uma linha POR PC.
 *
 * ⚠️ O `parecer_texto` VEM DO `parcela_historico`, e não de `prestacoes_contas` — lá só
 * existe o `parecer_tipo`, que é a categoria. E ele é RARO: 26 de 958 medidos em 18/08. A
 * tela precisa distinguir "a analista não escreveu nada" de "não veio na consulta", e por
 * isso o campo vem sempre, nulo quando não há.
 */
function sqlLista(filtro) {
  return `
    SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.processo_pc, p.processo_mae,
           p.codigo_nl, p.valor, p.parecer_tipo, p.analista_id, p.analista_nome, p.grupo,
           p.setorial_id, p.dt_envio_ci, p.data_baixa, p.ci_situacao, p.ci_rodada,
           p.ci_tecnico_id, p.ci_tecnico_em, p.ci_encerrado_em, p.ci_encerrado_por,
           ${SQL_DIAS} AS dias_espera,
           t.nome AS ci_tecnico_nome,
           e.nome AS encerrado_por_nome,
           u.nome AS analista_nome_completo,
           h.observacao AS parecer_texto,
           (SELECT COUNT(*)::int FROM ci_mensagem m WHERE m.codigo_pc = p.codigo_pc) AS msgs
      FROM prestacoes_contas p
      LEFT JOIN usuarios t ON t.id = p.ci_tecnico_id
      LEFT JOIN usuarios e ON e.id = p.ci_encerrado_por
      LEFT JOIN usuarios u ON u.id = p.analista_id
      LEFT JOIN LATERAL (
        SELECT hh.observacao FROM parcela_historico hh
         WHERE hh.tr = p.tr AND hh.parcial_num = p.parcial_num
           AND hh.setorial_id = p.setorial_id AND hh.evento = 'parecer'
           AND hh.observacao IS NOT NULL AND btrim(hh.observacao) <> ''
         ORDER BY hh.criado_em DESC LIMIT 1) h ON true
     WHERE ${filtro}
     -- Mais antiga primeiro: a fila do C.I. é uma fila, e quem está esperando há 40 dias vem
     -- antes de quem chegou ontem.
     ORDER BY p.dt_envio_ci NULLS LAST, p.tr, p.parcial_num, p.codigo_pc
     LIMIT ${LIMITE + 1}`;
}

const sqlContar = (filtro) => `SELECT COUNT(*)::int AS n FROM prestacoes_contas p WHERE ${filtro}`;

// ── As escritas ─────────────────────────────────────────────────────────────
//
// ⚠️ `parcela_historico` NÃO TEM COLUNA `codigo_pc` — é por (tr, parcial_num). Então o código
// da PC vai no TEXTO da observação, e a linha entra na parcela a que ela pertence. Criar a
// coluna resolveria mais bonito e mexeria numa tabela de 1.662 linhas que oito rotas já
// escrevem; o texto responde a pergunta de quem abre a trilha, que é o que ela serve.
//
// A autoria segue a convenção de 14/08: `analista_id` é o DONO do trabalho e `executado_por`
// é QUEM CLICOU, nulo quando são a mesma pessoa.
const SQL_HIST = `
  INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo,
                                 analista_id, executado_por, observacao, criado_em)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`;

/**
 * ABRIR A PC — e é a abertura que a marca como sua.  (decisão do Richard, 25/08/2026)
 *
 * O técnico expande a linha para examinar: valor, processo SGPe, nota de liquidação, o
 * parecer da analista. Nesse instante a PC passa a levar o nome dele, e os outros dois param
 * de abrir a mesma coisa. Era esse o problema: três pessoas na mesma fila e nada no banco
 * dizendo quem estava com o quê.
 *
 * ⚠️ ABRIR NÃO TOMA A PC DE QUEM JÁ ESTÁ COM ELA. A marca existe para coordenar, e uma marca
 * que troca de dono a cada clique não coordena nada — bastaria alguém espiar a PC da colega
 * para ela sumir do "Comigo" dela no meio do trabalho. Quando já tem dono, abrir é leitura
 * pura e a rota devolve quem é, para a tela dizer.
 *
 * ⚠️ E SÓ MARCA O QUE ESTÁ `na_fila`. Abrir uma encerrada para consultar não a traz de volta
 * para o colo de ninguém.
 *
 * ⚠️ A TRAVA É O `WHERE ci_tecnico_id IS NULL` DENTRO DO UPDATE, e não uma leitura antes.
 * Dois cliques simultâneos passariam os dois por uma conferência feita fora do comando; aqui
 * o segundo não encontra linha para atualizar e recebe o dono de volta. É a mesma escolha do
 * dedupe do sino.
 *
 * ⚠️ NADA AQUI TOCA EM `baixada`, `data_baixa`, `enviado_ci` NEM `ci_situacao`. Quem está com
 * a PC é outra pergunta, e respondê-la não pode movê-la no ciclo. Há teste que falha se um
 * UPDATE desta lib mencionar qualquer uma das quatro.
 */
async function abrir(db, { codigo_pc, quem }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(
      `UPDATE prestacoes_contas
          SET ci_tecnico_id = $2::int, ci_tecnico_em = NOW()
        WHERE codigo_pc = $1 AND ci_situacao = 'na_fila' AND ci_tecnico_id IS NULL
        RETURNING tr, parcial_num, setorial_id`, [codigo_pc, quem.id]);

    if (!r.rows.length) {
      await cli.query('ROLLBACK');
      const at = await db.query(
        `SELECT p.ci_situacao, p.ci_tecnico_id, u.nome AS ci_tecnico_nome
           FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.ci_tecnico_id
          WHERE p.codigo_pc = $1`, [codigo_pc]);
      const l = at.rows[0] || null;
      if (!l) return { ok: false, inexistente: true };
      return { ok: false, ja: l, seu: Number(l.ci_tecnico_id) === Number(quem.id) };
    }

    // ⚠️ A LINHA DE HISTÓRICO SÓ SAI QUANDO A PC MUDA DE MÃOS — nunca a cada expandir.
    // O mesmo técnico abre a mesma PC cinco vezes num dia; cinco linhas idênticas na trilha
    // enterrariam a única que interessa achar, que é aquela em que o responsável mudou.
    const { tr, parcial_num, setorial_id } = r.rows[0];
    await cli.query(SQL_HIST, [tr, parcial_num, setorial_id, 'ci_abriu', null, quem.nome,
                               quem.id, null,
                               `${quem.nome} abriu a PC ${codigo_pc} no Controle Interno e ficou com ela.`]);
    await cli.query('COMMIT');
    return { ok: true, tecnico_id: quem.id, tecnico_nome: quem.nome };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * Devolver a PC à fila — ela volta a ficar sem dono.
 *
 * Motivo obrigatório: soltar o que se pegou é o movimento que outra pessoa vai ter de
 * entender daqui a um mês, sem ninguém por perto para explicar.
 */
async function devolver(db, { codigo_pc, quem, motivo }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ O DONO É LIDO ANTES DE APAGAR. `UPDATE ... RETURNING` devolve o valor NOVO, que aqui
    // é justamente o NULL que acabamos de gravar — a trilha ficaria com "devolveu: (vazio)" e
    // ninguém saberia de quem a PC era. Daí o `FOR UPDATE` antes: ele lê e tranca a linha.
    const antes = await cli.query(
      `SELECT p.tr, p.parcial_num, p.setorial_id, p.ci_tecnico_id, u.nome AS ci_tecnico_nome
         FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.ci_tecnico_id
        WHERE p.codigo_pc = $1 FOR UPDATE OF p`, [codigo_pc]);
    const a = antes.rows[0];
    if (!a) { await cli.query('ROLLBACK'); return { ok: false, inexistente: true }; }
    if (!a.ci_tecnico_id) { await cli.query('ROLLBACK'); return { ok: false, semDono: true }; }

    await cli.query(
      `UPDATE prestacoes_contas SET ci_tecnico_id = NULL, ci_tecnico_em = NULL
        WHERE codigo_pc = $1`, [codigo_pc]);
    // O DONO da linha é quem estava com a PC; o EXECUTOR é quem clicou, e some quando são o
    // mesmo. É a linha em que os dois diferem que interessa achar depois.
    const executor = Number(a.ci_tecnico_id) === Number(quem.id) ? null : quem.id;
    await cli.query(SQL_HIST, [a.tr, a.parcial_num, a.setorial_id, 'ci_devolveu',
                               a.ci_tecnico_nome, null, a.ci_tecnico_id, executor,
                               `A PC ${codigo_pc} voltou à fila do Controle Interno` +
                               (executor ? ` por ${quem.nome}` : '') +
                               `. Motivo: ${String(motivo).trim()}`]);
    await cli.query('COMMIT');
    return { ok: true, era_de: a.ci_tecnico_nome, tr: a.tr, parcial_num: a.parcial_num };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * Passar a PC a outro técnico. Motivo obrigatório.
 *
 * ⚠️ É UM `UPDATE` DIRETO, e não solta-e-pega: a PC nunca fica sem dono no meio da operação.
 * Entre um "devolver" e um "assumir", mesmo na mesma transação, uma falha deixaria a demanda
 * órfã — e órfã é exatamente o estado que esta tela existe para acabar.
 */
async function passar(db, { codigo_pc, quem, destino, motivo }) {
  const cli = await db.connect();
  try {
    await cli.query('BEGIN');
    const antes = await cli.query(
      `SELECT p.tr, p.parcial_num, p.setorial_id, p.ci_situacao, p.ci_tecnico_id,
              u.nome AS ci_tecnico_nome
         FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.ci_tecnico_id
        WHERE p.codigo_pc = $1 FOR UPDATE OF p`, [codigo_pc]);
    const a = antes.rows[0];
    if (!a) { await cli.query('ROLLBACK'); return { ok: false, inexistente: true }; }
    if (a.ci_situacao !== 'na_fila') { await cli.query('ROLLBACK'); return { ok: false, foraDaFila: true }; }

    await cli.query(
      `UPDATE prestacoes_contas SET ci_tecnico_id = $2::int, ci_tecnico_em = NOW()
        WHERE codigo_pc = $1`, [codigo_pc, destino.id]);
    // O novo dono é o `analista_id` da linha; quem clicou fica no `executado_por` quando não
    // é ele — é a linha em que os dois diferem que interessa achar depois.
    const executor = destino.id === quem.id ? null : quem.id;
    await cli.query(SQL_HIST, [a.tr, a.parcial_num, a.setorial_id, 'ci_passou',
                               a.ci_tecnico_nome, destino.nome, destino.id, executor,
                               `${quem.nome} passou a PC ${codigo_pc} para ${destino.nome}. ` +
                               `Motivo: ${String(motivo).trim()}`]);
    await cli.query('COMMIT');
    return { ok: true, era_de: a.ci_tecnico_nome, tr: a.tr, parcial_num: a.parcial_num };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * O rótulo de cada evento no histórico. Vem do Richard, e é frase, não código: quem abre a
 * trilha meses depois precisa entender sem manual.
 */
const ROTULO_EVENTO = {
  ci_abriu:    'abriu no Controle Interno',
  ci_devolveu: 'devolveu à fila do C.I.',
  ci_passou:   'passou a demanda do C.I.',
  ci_decidiu:  'decidiu no Controle Interno',
};

/** As duas decisões, com o texto que vai para a trilha. É o mesmo texto dos dois rádios. */
const ROTULO_DECISAO = {
  de_acordo: 'Parecer do analista em acordo, baixado',
  ressalva:  'Parecer para correção, verificar o processo no SGPe',
};

module.exports = {
  MOTIVO_MIN, MOTIVO_MAX, LIMITE, CHIPS, ESPERAS,
  SQL_DIAS, SQL_SGPE_CHAVE, SQL_RESUMO, SQL_TECNICOS, SQL_ANALISTAS, SQL_HIST,
  ROTULO_EVENTO, ROTULO_DECISAO,
  faixaEspera, chaveSgpe, faltaSgpe,
  podeAgir, podeDecidir, motivoNaoDecide, validarMotivo,
  montarFiltro, sqlLista, sqlContar,
  abrir, devolver, passar,
};
