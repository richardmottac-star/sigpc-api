// CAMINHO: sigpc-api/lib/ci-fila.js
//
// A FILA DO CONTROLE INTERNO.  (25/08/2026)
//
// ─────────────────────────────────────────────────────────────────────────────
// A UNIDADE É A PC, E SÓ ELA.
//
// O técnico do C.I. examina uma prestação de cada vez: um valor, um processo SGPe, uma nota
// de liquidação, um parecer. É essa a linha da fila, é essa a linha que ele abre, e é sobre
// essa linha que ele decide. Nada aqui agrupa, nem por TR nem por parcela.
//
// ⚠️ O RESPONSÁVEL MORA NA PRÓPRIA LINHA: `prestacoes_contas.ci_tecnico_id` e
// `ci_tecnico_em`, ao lado de `ci_situacao`, `ci_rodada`, `ci_encerrado_em` e
// `ci_encerrado_por`. O responsável É da PC — a mesma granularidade da linha. Uma tabela ao
// lado exigiria um JOIN em toda leitura para responder algo que cabe na linha, e abriria a
// porta para PC sem linha correspondente.
//
// ⚠️ O TÉCNICO É CARIMBADO PELO PARECER, NUNCA POR ABRIR A PC. Expandir uma linha para ler
// não marca nada: `ci_tecnico_id` e `ci_tecnico_em` são gravados por `ci.decidir`, no mesmo
// UPDATE da decisão. Foi o contrário até 25/08, e em um dia o nome do superadmin apareceu
// numa PC que ele não analisa — porque a única forma de olhar era assumir.
//
// ⚠️ `ci_tecnico_id` E `ci_encerrado_por` CONTINUAM SENDO PERGUNTAS DIFERENTES, e a diferença
// aparece na devolução para correção: a PC leva o técnico que a devolveu em `ci_tecnico_id` e
// **não tem** `ci_encerrado_por`, porque não encerrou nada. Numa encerrada os dois existem, e
// apontam para a mesma pessoa.
//
// ⚠️ ESTA LIB NÃO ESCREVE NADA. Nem no ciclo, nem na baixa, nem no responsável: ela monta as
// consultas de LEITURA da fila e responde quem pode o quê. As três funções que escreviam —
// `abrir`, `devolver` e `passar` — saíram, e o porquê está no bloco no fim do arquivo.
//
// O esquema que sustenta tudo isto é criado por `migracao_ci_por_pc_20260825.js`.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ QUEM É TÉCNICO DO C.I. TEM UMA FONTE SÓ: `usuarios.perfil = 'controle_interno'`.
// É a mesma que o `POST /ci/responder` já usava, a mesma do `contaProdutividade` da tela e a
// mesma da regra dos três ids do CLAUDE.md. Uma lista paralela aqui — por id, por nome, por
// flag nova — seria uma segunda resposta para "quem é do C.I.", e um dia as duas divergiriam
// sem erro nenhum.

const papel = require('./papel');

/**
 * ⚠️ O TETO DA LISTA, E ELE É DITO NA TELA.
 *
 * São 2.928 PCs no ciclo do C.I. hoje. Mandar todas em toda abertura repetiria o problema
 * das seis telas que baixam o acervo inteiro para filtrar no cliente (Pendências do
 * CLAUDE.md). O recorte é feito no banco, e quando sobra mais que isto a tela **diz quantas
 * ficaram de fora** — um corte silencioso se lê como "é só isso que existe".
 */
const LIMITE = 300;

// ── A PAGINAÇÃO ─────────────────────────────────────────────────────────────
//
// ⚠️ O `LIMITE` DEIXOU DE SER O TAMANHO DA LISTA em 27/08/2026 — virou o TETO de uma página.
// Até aqui a rota trazia 300 e a tela dizia "mostrando as 300 mais antigas de 875": a fila
// tinha um começo e nenhum meio. Quem precisasse da parcela 400 não tinha caminho, e a
// própria faixa mandava "use a busca" — o que só ajuda quem já sabe o que procurar.
//
// ⚠️ `LIMITE` FICA DE PÉ como teto do que o servidor aceita. A tela oferece até 50, mas o
// `tamanho` chega pela URL: sem teto, `?tamanho=99999` devolve o acervo inteiro e recria o
// problema das seis telas que baixam tudo para filtrar no cliente.
const TAMANHOS = [10, 20, 30, 40, 50];
const TAMANHO_PADRAO = 20;

/** Normaliza o que veio da URL. Fora da lista, cai no padrão — nunca no que foi pedido. */
function paginacao(q) {
  const t = parseInt(q?.tamanho);
  const tamanho = TAMANHOS.includes(t) ? t : TAMANHO_PADRAO;
  const p = parseInt(q?.pagina);
  const pagina = Number.isFinite(p) && p > 0 ? p : 1;
  return { pagina, tamanho: Math.min(tamanho, LIMITE), offset: (pagina - 1) * Math.min(tamanho, LIMITE) };
}

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

// A mesma conta, sobre a data MAIS ANTIGA da parcela — é a versão agregada, para a lista que
// agora devolve uma linha por parcela. `MIN`, e não `MAX`: a espera de uma parcela é a da PC
// que está esperando há mais tempo. (Medido em 26/08: a data de envio é uniforme dentro da
// parcela nas 875 da fila, então hoje as duas dariam o mesmo — a diferença é para o dia em
// que uma PC entrar na parcela depois das outras.)
const SQL_DIAS_AG = `((NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                   - ((MIN(p.dt_envio_ci) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)::int`;

// ⚠️ A CHAVE DA PARCELA, ESCRITA UMA VEZ SÓ. É a mesma de `carregarParcela` no server e a
// mesma dos cinco chamadores dele — `(setorial_id, tr, parcial_num)`. O C.I. passou a usá-la
// em 26/08/2026; até então decidia por `codigo_pc`, e a mesma parcela podia terminar com
// decisões diferentes.
const SQL_CHAVE_PARCELA = `p.setorial_id, p.tr, p.parcial_num`;
const SQL_CHAVE_TEXTO   = `(p.setorial_id || '|' || p.tr || '|' || COALESCE(p.parcial_num, '~'))`;

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
 * ⚠️ QUEM DÁ PARECER NO C.I. É O C.I. — E SÓ ELE.  (ordem do Richard, 26/08/2026)
 *
 * Nem coordenador, nem superadmin. Não é hierarquia: é que o parecer **carimba o nome de
 * quem o deu** em `ci_tecnico_id`, e o nome que fica ali tem de ser o de um técnico do
 * Controle Interno. Um superadmin decidindo poria o nome dele numa PC que ele não analisa —
 * que foi exatamente o que aconteceu em 25/08 e que este ciclo desfez.
 *
 * ⚠️ ESTA É A ÚNICA REGRA DO SISTEMA EM QUE O SUPERADMIN NÃO PASSA. Em todo o resto ele é
 * isento — modo manutenção, limite de TRs, decidir o próprio pedido de devolução. Aqui não,
 * e a diferença é que as outras isenções o deixam AGIR; esta o faria APARECER como se fosse
 * outra pessoa. Se um dia ele precisar destravar uma PC, o caminho é o "passar a outro
 * técnico", que move a demanda sem inventar autoria.
 *
 * ⚠️ A POSSE DEIXOU DE SER PRÉ-REQUISITO, e virou CONSEQUÊNCIA. Até 25/08 valia "você decide
 * a PC que é sua", porque abrir a PC já a marcava como sua — abrir e assumir eram o mesmo
 * ato. Agora abrir é só abrir, e a PC só ganha técnico no instante do parecer. Exigir posse
 * antes travaria toda a fila: nenhuma PC tem dono até alguém dar o primeiro parecer.
 *
 * ⚠️ E A FUNÇÃO RECEBE UM ARGUMENTO SÓ. Ela recebia também o `tecnicoId` da PC, de quando
 * valia "você decide a PC que é sua"; com a posse virando consequência do parecer, o
 * argumento passou a ser ignorado. Parâmetro que ninguém lê engana quem chama: parece que a
 * PC entra na conta, e não entra.
 *
 * ⚠️ E ISTO VIVE NO SERVIDOR, não só no botão cinza. Desabilitar na tela avisa; recusar na
 * rota impede.
 */
function podeDecidir(quem) {
  if (!quem) return false;
  return papel.perfilEfetivo(quem) === 'controle_interno';
}

/** O motivo da recusa, para a tela poder dizer POR QUE em vez de só apagar o botão. */
function motivoNaoDecide(tecnicoNome) {
  return 'O parecer do Controle Interno é dado por um técnico do C.I. — ' +
         'o seu nome ficaria registrado nesta PC.';
}

/**
 * ⚠️ QUEM REABRE UMA PC ENCERRADA É O C.I. — E SÓ ELE.  (ordem do Richard, 26/08/2026)
 *
 * Mesmo predicado de `podeDecidir` hoje, e MESMO ASSIM não é um apelido dela. As duas
 * recusam pelo mesmo perfil por motivos DIFERENTES:
 *
 *   · `podeDecidir` recusa porque o parecer **carimba** `ci_tecnico_id`, e o nome que fica
 *     ali tem de ser o de um técnico do C.I.
 *   · `podeReabrir` recusa porque reabrir é **desfazer uma decisão do C.I.**, e quem desfaz
 *     a decisão do C.I. é o C.I. A reabertura não carimba técnico nenhum.
 *
 * Se um dia a regra do carimbo mudar, `podeDecidir` muda e esta NÃO deve mudar junto. Uma
 * função só, com dois motivos pendurados, mudaria os dois de uma vez sem ninguém decidir —
 * e a recusa passaria a mentir o motivo para quem a lê na tela.
 *
 * ⚠️ O SUPERADMIN TAMBÉM NÃO PASSA, pelo `perfilEfetivo`. É a segunda regra do sistema em que
 * ele não é isento, e ela vem em par com a primeira: se ele não pode encerrar, não pode
 * desencerrar.
 */
function podeReabrir(quem) {
  if (!quem) return false;
  return papel.perfilEfetivo(quem) === 'controle_interno';
}

/** O motivo da recusa da reabertura. Diz o que é a ação, não o que é o carimbo. */
function motivoNaoReabre() {
  return 'Reabrir uma PC encerrada desfaz uma decisão do Controle Interno — ' +
         'só um técnico do C.I. faz isso.';
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
// ⚠️ OS NÚMEROS CONTAM PARCELA, NÃO PC — desde 26/08/2026, junto com a lista.
//
// Não é enfeite: o chip é o rótulo da lista, e a lista agora tem uma linha por parcela. Um
// chip dizendo 1.395 sobre uma lista de 875 linhas é a mesma mentira que este ciclo veio
// corrigir na notificação. Quem quiser o número de PCs tem o `pcs` de cada linha.
//
// `COUNT(DISTINCT chave)` e não `COUNT(*)`: a média de espera continua sendo por PC de
// propósito — ela responde "há quanto tempo o serviço está parado", e nisso uma parcela de 9
// PCs pesa mais que uma de 1, que é o que se quer.
const SQL_RESUMO = `
  SELECT
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'na_fila')::int      AS fila,
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'com_analista')::int AS com_analista,
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'encerrado')::int    AS encerradas,
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'na_fila' AND p.ci_tecnico_id = $1::int)::int AS minhas,
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'na_fila' AND p.ci_tecnico_id IS NOT NULL
                       AND p.ci_tecnico_id <> $1::int)::int                        AS outros,
    COUNT(DISTINCT ${SQL_CHAVE_TEXTO}) FILTER (WHERE p.ci_situacao = 'na_fila' AND ${SQL_DIAS} > 30)::int AS mais30,
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
 * A lista, uma linha POR PARCELA.  (26/08/2026 — era uma por PC)
 *
 * ⚠️ POR QUE MUDOU. A análise é por parcial, e o parecer do analista sempre foi: `POST
 * /parcela/parecer` escreve em `(setorial_id, tr, parcial_num)`. O C.I. lia por PC e decidia
 * por PC, então a tela oferecia 1.395 decisões para 875 parcelas — o técnico decidiria nove
 * vezes o que a analista decidiu uma, e a mesma parcela podia terminar com desfechos
 * diferentes. A notificação já dizia "Parcela 3 — 1 PC" numa parcela de 2.
 *
 * ⚠️ O `WHERE` FILTRA ANTES DE AGRUPAR, e é isso que faz "o C.I. decide só o que foi
 * encaminhado" cair de graça: `ci_situacao = 'na_fila'` corta as PCs da parcela que a
 * analista não mandou, e o grupo nasce só com o que sobrou. As não encaminhadas não entram no
 * `pcs`, não entram no `n_pcs` e não bloqueiam nada. São 6 parcelas assim hoje.
 *
 * ⚠️ OS AGREGADOS NÃO SÃO CHUTE. Medido em 26/08 nas 875 parcelas da fila: `analista_id`,
 * `ci_rodada`, `ci_tecnico_id`, `parecer_tipo` e a data de envio são **uniformes dentro da
 * parcela**, sem uma exceção. Onde o dado PODE variar de verdade, a linha diz quanto varia em
 * vez de escolher: `n_processos` e `n_nls` acompanham o `processo_pc` e a `codigo_nl` —
 * a relação processo × parcela é N:N (armadilha 16) e uma NL é quitada por até 19 PCs.
 *
 * ⚠️ O `parecer_texto` VEM DO `parcela_historico`, e não de `prestacoes_contas` — lá só
 * existe o `parecer_tipo`, que é a categoria. Ele já era por `(tr, parcial_num)`: sempre foi
 * um dado de PARCELA sendo repetido em cada linha de PC.
 */
function sqlLista(filtro, pag) {
  // ⚠️ `LIMIT`/`OFFSET` INTERPOLADOS, e não por `$n` — porque os dois valores vêm de
  // `paginacao()`, que já os transformou em INTEIRO por `parseInt` e os prendeu a uma lista
  // fechada. O que a URL manda nunca chega aqui como texto. Passá-los por parâmetro exigiria
  // reordenar os `$n` do filtro, que é montado antes e não sabe quantos são.
  const p = pag && Number.isFinite(pag.tamanho) ? pag : { tamanho: LIMITE, offset: 0 };
  return `
    SELECT ${SQL_CHAVE_PARCELA},
           COUNT(*)::int                                  AS n_pcs,
           array_agg(p.codigo_pc ORDER BY p.codigo_pc)     AS codigos_pc,
           -- ⚠️ A "PRIMEIRA" PC DA PARCELA, e ela tem um uso só: virar chave de tela e
           -- \`ref_id\` do sino. NÃO é a PC decidida — quem decide é a parcela inteira.
           MIN(p.codigo_pc)                               AS codigo_pc,
           MAX(p.entidade)                                AS entidade,
           MIN(p.processo_pc)                             AS processo_pc,
           COUNT(DISTINCT p.processo_pc)::int             AS n_processos,
           MIN(p.processo_mae)                            AS processo_mae,
           MIN(p.codigo_nl)                               AS codigo_nl,
           COUNT(DISTINCT p.codigo_nl)::int               AS n_nls,
           SUM(p.valor)                                   AS valor,
           MAX(p.parecer_tipo)                            AS parecer_tipo,
           MAX(p.analista_id)                             AS analista_id,
           MAX(p.analista_nome)                           AS analista_nome,
           MAX(p.grupo)                                   AS grupo,
           MIN(p.dt_envio_ci)                             AS dt_envio_ci,
           MIN(p.data_baixa)                              AS data_baixa,
           MAX(p.ci_situacao)                             AS ci_situacao,
           MAX(p.ci_rodada)                               AS ci_rodada,
           MAX(p.ci_tecnico_id)                           AS ci_tecnico_id,
           MAX(p.ci_tecnico_em)                           AS ci_tecnico_em,
           MAX(p.ci_encerrado_em)                         AS ci_encerrado_em,
           MAX(p.ci_encerrado_por)                        AS ci_encerrado_por,
           ${SQL_DIAS_AG}                                 AS dias_espera,
           MAX(t.nome)                                    AS ci_tecnico_nome,
           MAX(e.nome)                                    AS encerrado_por_nome,
           MAX(u.nome)                                    AS analista_nome_completo,
           MAX(h.observacao)                              AS parecer_texto,
           -- SUM, e não COUNT: a conversa continua sendo por PC (decisão do Richard), então
           -- as mensagens da parcela são a soma das das PCs dela.
           SUM((SELECT COUNT(*) FROM ci_mensagem m WHERE m.codigo_pc = p.codigo_pc))::int AS msgs
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
     GROUP BY ${SQL_CHAVE_PARCELA}
     -- Mais antiga primeiro: a fila do C.I. é uma fila, e quem está esperando há 40 dias vem
     -- antes de quem chegou ontem.
     -- ⚠️ A ORDEM TEM DE SER TOTAL, senao a paginacao repete e some com linhas. Duas parcelas
     -- com o mesmo dt_envio_ci (e o caso de todo lote: NOW() e o instante da TRANSACAO)
     -- ficariam em ordem indefinida entre uma pagina e outra, e a mesma parcela apareceria na
     -- 2 e na 3 enquanto outra nao apareceria em nenhuma. tr + parcial_num fecham o
     -- desempate, e juntos sao unicos dentro do setorial.
     -- (Sem crase: comentario dentro de template literal nao leva crase — armadilha 10.)
     ORDER BY MIN(p.dt_envio_ci) NULLS LAST, p.tr, p.parcial_num, p.setorial_id
     LIMIT ${p.tamanho} OFFSET ${p.offset}`;
}

// ⚠️ CONTA PARCELAS, e por isso agrupa antes de contar. Um `COUNT(*)` seco devolveria PCs, e
// a paginação compararia o total de PCs com um LIMITE de parcelas — a tela diria "mostrando
// 200 de 1.395" sobre 875, e o "há mais" apareceria onde não há.
const sqlContar = (filtro) => `
  SELECT COUNT(*)::int AS n FROM (
    SELECT 1 FROM prestacoes_contas p WHERE ${filtro} GROUP BY ${SQL_CHAVE_PARCELA}) x`;

// ⚠️ HAVIA UM `SQL_HIST`, UMA `devolver` E UMA `passar` AQUI. AS TRÊS SAÍRAM EM 26/08/2026.
//
// Elas eram o resto do modelo em que a PC tinha dono ANTES do parecer: `devolver` soltava a
// PC e `passar` a entregava a outro técnico. As duas escreviam `ci_tecnico_id` — uma zerando,
// a outra atribuindo — e é exatamente isso que não pode mais existir.
//
// ⚠️ A ATRIBUIÇÃO ACONTECE NUM LUGAR SÓ: dentro de `ci.decidir`, no MESMO UPDATE que grava o
// parecer. Uma segunda porta para a mesma coluna é o que faz a resposta de "quem é o técnico
// desta PC" depender de por onde se passou, e não do que aconteceu.
//
// O QUE CADA UMA SIGNIFICAVA, e por que nenhuma sobrevive ao modelo novo:
//
//   · `devolver` soltava a PC para a fila. Com a atribuição vindo do parecer, o
//     `ci_tecnico_id` deixou de ser "quem pegou" e passou a ser **quem já deu parecer**.
//     Apagá-lo não devolveria nada para lugar nenhum: apagaria o registro de quem decidiu.
//     Isso é apagar trilha, e trilha não se organiza — se lê.
//
//   · `passar` entregava a demanda a outro técnico. Ela existia porque pegar vinha antes de
//     decidir, e quem pegava podia não poder terminar. Agora ninguém pega: os três olham a
//     mesma fila e qualquer um dá o parecer de qualquer PC (ver `podeDecidir`). Não há
//     demanda presa para transferir.
//
// ⚠️ E COM ELAS SAÍRAM `MOTIVO_MIN`, `MOTIVO_MAX` e `validarMotivo`, que só serviam ao motivo
// obrigatório dessas duas ações, e os rótulos `ci_abriu`/`ci_devolveu`/`ci_passou` do
// histórico — eventos que nada mais gera. Um rótulo para um evento que não acontece é uma
// promessa de que ele pode acontecer.
//
// As rotas `POST /ci/pc/devolver` e `POST /ci/pc/passar` saíram junto, e com elas a guarda
// `guardaCi` do server.js, que não guardava mais nada.

/**
 * O rótulo do evento no histórico. Vem do Richard, e é frase, não código: quem abre a trilha
 * meses depois precisa entender sem manual.
 *
 * ⚠️ UM SÓ, e é o único evento que esta parte do sistema gera. Ver o bloco acima.
 */
const ROTULO_EVENTO = {
  ci_decidiu: 'decidiu no Controle Interno',
};

/** As duas decisões, com o texto que vai para a trilha. É o mesmo texto dos dois rádios. */
const ROTULO_DECISAO = {
  de_acordo: 'Parecer do analista em acordo, baixado',
  ressalva:  'Parecer para correção, verificar o processo no SGPe',
};

module.exports = {
  LIMITE, TAMANHOS, TAMANHO_PADRAO, paginacao, CHIPS, ESPERAS,
  SQL_DIAS, SQL_DIAS_AG, SQL_CHAVE_PARCELA, SQL_CHAVE_TEXTO,
  SQL_SGPE_CHAVE, SQL_RESUMO, SQL_TECNICOS, SQL_ANALISTAS,
  ROTULO_EVENTO, ROTULO_DECISAO,
  faixaEspera, chaveSgpe, faltaSgpe,
  podeAgir, podeDecidir, motivoNaoDecide, podeReabrir, motivoNaoReabre,
  montarFiltro, sqlLista, sqlContar,
};