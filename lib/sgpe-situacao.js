// CAMINHO: sigpc-api/lib/sgpe-situacao.js
//
// A REGRA DA SINCRONIZAÇÃO — onde a situação de cada processo do SGPe é guardada, em que ordem
// os processos são visitados, e o que se grava de cada resposta do portal.
//
// Quem consulta o portal é `lib/sgpe-portal.js`. Quem roda a rodada é `job_sgpe_situacao.js`.
// Aqui só mora a decisão.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE DUAS TABELAS NOVAS, E NÃO COLUNAS EM `sgpe_processo_ref`
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. ⚠️ A FILA DE TRAMITAÇÕES É 1:N — 34 no maior caso medido (SCC 2049/2025). Isso não cabe
//    em coluna. E a exigência de ser idempotente PELA CHAVE DO TRÂMITE só existe se cada
//    trâmite for uma LINHA com chave própria: num JSONB a idempotência viraria "compare o
//    array inteiro e reescreva", que não é idempotência, é substituição.
//
// 2. ⚠️ `sgpe_processo_ref` JÁ TEM DONO, e o dono escreve com guardas. `lib/sgpe-lote.js` faz
//    `INSERT ... ON CONFLICT DO UPDATE ... WHERE origem NOT IN ('CONFERIDO','SGPE','MANUAL')`.
//    Essas cláusulas foram escritas para proteger o LINK, e passariam a decidir se uma
//    atualização de SITUAÇÃO acontece — um `WHERE` pensado para uma pergunta respondendo outra.
//    Dois jobs escrevendo a mesma linha por caminhos com regras diferentes é como se perde
//    dado sem ninguém ver erro.
//
// 3. ⚠️ AS DUAS FONTES JÁ DISCORDAM, E ISSO É O ACHADO. O `sgpe_processo_ref` marca 7
//    processos como NAO_ENCONTRADO pelo DWR; o portal público ACHA um deles — o SCC 2049/2025,
//    com 34 tramitações. Guardar a situação dentro da linha da negativa faria uma contradizer
//    a outra dentro do mesmo registro. Separadas, a discordância fica visível, que é o que se
//    quer (é a mesma razão de `sigef_status` não substituir `parecer_tipo`).
//
// 4. ⚠️ SEM CHAVE ESTRANGEIRA, por ordem do Richard e pelo mesmo motivo do
//    `parcela_historico.executado_por`: o histórico tem de sobreviver a qualquer limpeza. Uma
//    FK para `sgpe_processo_ref` faria apagar uma linha de cache derrubar o histórico de
//    tramitação junto — e o cache é a parte descartável das duas.
//
// A chave das duas tabelas é a TRIPLA NORMALIZADA `(sigla, numero_oficial, ano)`, a mesma de
// `sgpe_processo_ref` e a mesma que `lib/sgpe-link.js` produz. Não é `codigo_pc` nem
// `processo_pc` em texto: 2.704 processos têm mais de uma PC, e o mesmo processo aparece
// escrito de dois jeitos na base (`SCC8137/2021` × `SCC 00008137/2021`, e dois em minúsculas).

const RESULTADOS = {
  OK: 'OK',
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
  SIGILOSO: 'SIGILOSO',
  SIGLA_NAO_CADASTRADA: 'SIGLA_NAO_CADASTRADA',
  REDE: 'REDE',
};

// ⚠️ REDE NÃO É RESPOSTA, e por isso não sobrescreve o que já se sabia. Se o portal cair no
// meio de uma rodada, marcar 300 processos como "sem situação" apagaria a última leitura boa
// de todos eles de uma vez — e a próxima rodada só voltaria a esse processo depois de um ciclo
// inteiro. Numa falha de rede só o carimbo da tentativa e o motivo são gravados; a situação
// anterior fica.
const RESULTADOS_QUE_SUBSTITUEM = [RESULTADOS.OK, RESULTADOS.NAO_ENCONTRADO, RESULTADOS.SIGILOSO,
                                   RESULTADOS.SIGLA_NAO_CADASTRADA];

const DDL_SITUACAO = `
  CREATE TABLE IF NOT EXISTS sgpe_situacao (
    sigla            text    NOT NULL,
    numero_oficial   integer NOT NULL,
    ano              integer NOT NULL,
    resultado        text    NOT NULL,
    situacao_portal  text,
    estado_portal    text,
    posicao          text,
    setor_sigla      text,
    setor_nome       text,
    dias_no_setor    integer,
    desde            date,
    tramitacoes      integer,
    erro_motivo      text,
    checado_em       timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sigla, numero_oficial, ano)
  )`;

const DDL_TRAMITACAO = `
  CREATE TABLE IF NOT EXISTS sgpe_tramitacao (
    sigla            text    NOT NULL,
    numero_oficial   integer NOT NULL,
    ano              integer NOT NULL,
    ordem            integer NOT NULL,
    setor_sigla      text,
    setor_nome       text,
    cd_orgao         integer,
    dt_recebto       date,
    dt_encaminha     date,
    permanencia_dias integer,
    quem_encaminhou  text,
    parecer          text,
    atualizado_em    timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sigla, numero_oficial, ano, ordem)
  )`;

// ⚠️ O ÍNDICE É A RODADA INTEIRA. Sem ele, escolher os 300 próximos varre 7.764 linhas a cada
// hora; com ele é uma leitura do começo do índice. E o `NULLS FIRST` tem de estar no ÍNDICE,
// não só na consulta: um índice ASC comum guarda os nulos no fim, e o planejador ignoraria o
// índice justamente na parte que importa — a dos que nunca foram checados.
const DDL_INDICE = `
  CREATE INDEX IF NOT EXISTS ix_sgpe_situacao_rodizio
      ON sgpe_situacao (checado_em ASC NULLS FIRST)`;

// ── O UNIVERSO ───────────────────────────────────────────────────────────────
// Os dois campos de processo, como no `job_sgpe_links.js`. Medido em 30/08: 6.343 distintos em
// `processo_pc`, 1.773 em `processo_mae`, 7.764 na união — e 1.421 aparecem SÓ na mãe. Ficar
// só com o `processo_pc` deixaria de fora o processo mãe de 1.421 TRs, que é o que a busca
// global e o cabeçalho do cartão mostram.
const SQL_UNIVERSO = `
  SELECT processo_pc AS v FROM prestacoes_contas WHERE processo_pc IS NOT NULL
  UNION
  SELECT processo_mae   FROM prestacoes_contas WHERE processo_mae IS NOT NULL`;

// ── O RODÍZIO ────────────────────────────────────────────────────────────────
// ⚠️ SEM FILA E SEM ESTADO: a ordem sai da PRÓPRIA data de checagem. Uma tabela de fila
// precisaria ser preenchida, consumida e limpa, e qualquer rodada interrompida a deixaria com
// linhas presas — que é o defeito que uma fila existe para evitar e acaba criando. Aqui, uma
// rodada que morre no meio não deixa rastro: os que ela não chegou a checar continuam com a
// data antiga e vêm primeiro na próxima, sozinhos.
const SQL_JA_CHECADOS = `
  SELECT sigla, numero_oficial, ano, checado_em
    FROM sgpe_situacao`;

/**
 * A ordem da rodada. PURA — sem banco e sem rede, para ser testada.
 *
 * ⚠️ QUEM NUNCA FOI CHECADO VEM PRIMEIRO (NULLS FIRST), depois o mais antigo. Não é detalhe de
 * ordenação: na primeira rodada TODOS são nulos, e é isso que faz o sistema cobrir o acervo
 * inteiro antes de começar a repetir. Ordenar por data com os nulos no fim faria os processos
 * nunca vistos serem os últimos da vida.
 *
 * @param alvos     Map chave -> {sigla, numero, ano}    (o universo normalizado)
 * @param checados  Map chave -> Date                    (o que já tem situação)
 * @returns lista ordenada [{ chave, p, checadoEm }]
 */
function montarRodizio(alvos, checados) {
  const fila = [];
  for (const [chave, p] of alvos) {
    fila.push({ chave, p, checadoEm: checados.get(chave) || null });
  }
  fila.sort((a, b) => {
    if (a.checadoEm === null && b.checadoEm === null) return a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0;
    if (a.checadoEm === null) return -1;
    if (b.checadoEm === null) return 1;
    const d = new Date(a.checadoEm) - new Date(b.checadoEm);
    // ⚠️ DESEMPATE PELA CHAVE, sempre. Numa carga inicial centenas de linhas ficam com o mesmo
    // carimbo, e sem desempate a ordem entre elas muda a cada leitura — a mesma rodada poderia
    // revisitar uns e nunca chegar a outros.
    return d !== 0 ? d : (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0);
  });
  return fila;
}

// ── O QUE SE GRAVA ───────────────────────────────────────────────────────────

/** Traduz a resposta da lib do portal na linha de `sgpe_situacao`. Pura. */
function linhaDaSituacao(p, r) {
  const base = { sigla: p.sigla, numero_oficial: p.numero, ano: p.ano };
  if (r && r.ok) {
    const pr = r.processo || {};
    const a = r.atual || {};
    return {
      ...base,
      resultado: RESULTADOS.OK,
      situacao_portal: pr.situacao_portal || null,
      // ⚠️ O ASSUNTO SAI DE ONDE O MODAL DO F4 JÁ O LIA: `pr.assunto`, que a lib do portal
      // monta do `nmAssunto`. Ele NUNCA foi gravado até 31/08/2026 — o modal o mostrava ao
      // vivo e ninguém o persistia. Cortado em 120 para caber na coluna: o campo do portal
      // não tem teto declarado, e um assunto longo derrubaria o upsert da linha inteira.
      assunto: pr.assunto ? String(pr.assunto).slice(0, 120) : null,
      estado_portal: pr.estado_portal || null,
      posicao: a.situacao || null,
      setor_sigla: a.setor_sigla || null,
      setor_nome: a.setor_nome || null,
      // ⚠️ `dias` NULO NÃO VIRA ZERO — é o trâmite em trânsito sem trâmite anterior, de onde
      // não há de quando contar. Zero afirmaria que o processo saiu hoje.
      dias_no_setor: a.dias === undefined ? null : a.dias,
      desde: a.desde || null,
      tramitacoes: (r.tramitacoes || []).length,
      erro_motivo: null,
    };
  }
  const erro = (r && r.erro) || RESULTADOS.REDE;
  return {
    ...base,
    resultado: erro,
    situacao_portal: null, estado_portal: null, posicao: null, assunto: null,
    setor_sigla: null, setor_nome: null, dias_no_setor: null, desde: null, tramitacoes: null,
    erro_motivo: (r && (r.motivo || r.sigla)) ? String(r.motivo || r.sigla).slice(0, 300) : null,
  };
}

// ⚠️ O `WHERE` DO UPSERT É O QUE PROTEGE A ÚLTIMA LEITURA BOA. Num resultado de REDE só o
// `checado_em` e o `erro_motivo` mudam — a situação anterior permanece, e o processo volta ao
// fim do rodízio como qualquer outro. Sem isso, o portal fora do ar por uma hora apagaria a
// situação de 300 processos e ninguém saberia que eles um dia tiveram uma.
const SQL_GRAVAR_SITUACAO = `
  INSERT INTO sgpe_situacao
    (sigla, numero_oficial, ano, resultado, situacao_portal, estado_portal, posicao,
     setor_sigla, setor_nome, dias_no_setor, desde, tramitacoes, erro_motivo, assunto, checado_em)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$15, NOW())
  ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE SET
    resultado       = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.resultado       ELSE sgpe_situacao.resultado       END,
    situacao_portal = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.situacao_portal ELSE sgpe_situacao.situacao_portal END,
    estado_portal   = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.estado_portal   ELSE sgpe_situacao.estado_portal   END,
    posicao         = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.posicao         ELSE sgpe_situacao.posicao         END,
    setor_sigla     = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.setor_sigla     ELSE sgpe_situacao.setor_sigla     END,
    setor_nome      = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.setor_nome      ELSE sgpe_situacao.setor_nome      END,
    dias_no_setor   = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.dias_no_setor   ELSE sgpe_situacao.dias_no_setor   END,
    desde           = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.desde           ELSE sgpe_situacao.desde           END,
    tramitacoes     = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.tramitacoes     ELSE sgpe_situacao.tramitacoes     END,
    -- ⚠️ O ASSUNTO SEGUE A MESMA PROTEÇÃO DOS DEMAIS: num resultado de REDE ele NÃO é
    -- apagado. O portal fora do ar por uma hora não pode zerar o assunto de 300 processos.
    assunto         = CASE WHEN EXCLUDED.resultado = ANY($14::text[]) THEN EXCLUDED.assunto         ELSE sgpe_situacao.assunto         END,
    erro_motivo     = EXCLUDED.erro_motivo,
    checado_em      = NOW()`;

// ⚠️ A CHAVE DO TRÂMITE É `(sigla, numero, ano, ORDEM)`, e é ela que faz rodar duas vezes não
// duplicar linha. `ordem` vem do `nuTramite` do portal, que é estável — o trâmite 9 de hoje é o
// trâmite 9 de amanhã. Chavear por data de recebimento não serviria: há trâmite com data nula
// (o aberto) e há dois trâmites no MESMO dia — medido, três deles com permanência zero.
const SQL_GRAVAR_TRAMITE = `
  INSERT INTO sgpe_tramitacao
    (sigla, numero_oficial, ano, ordem, setor_sigla, setor_nome, cd_orgao,
     dt_recebto, dt_encaminha, permanencia_dias, quem_encaminhou, parecer, atualizado_em)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12, NOW())
  ON CONFLICT (sigla, numero_oficial, ano, ordem) DO UPDATE SET
    setor_sigla      = EXCLUDED.setor_sigla,
    setor_nome       = EXCLUDED.setor_nome,
    cd_orgao         = EXCLUDED.cd_orgao,
    dt_recebto       = EXCLUDED.dt_recebto,
    dt_encaminha     = EXCLUDED.dt_encaminha,
    permanencia_dias = EXCLUDED.permanencia_dias,
    quem_encaminhou  = EXCLUDED.quem_encaminhou,
    parecer          = EXCLUDED.parecer,
    atualizado_em    = NOW()`;

/** Os parâmetros do upsert da situação, na ordem do SQL. */
function paramsSituacao(l) {
  return [l.sigla, l.numero_oficial, l.ano, l.resultado, l.situacao_portal, l.estado_portal,
          l.posicao, l.setor_sigla, l.setor_nome, l.dias_no_setor, l.desde, l.tramitacoes,
          l.erro_motivo, RESULTADOS_QUE_SUBSTITUEM,
          // ⚠️ O ASSUNTO É O `$15`, NO FIM, e não na posição 14. Pô-lo no meio renumeraria o
          // `RESULTADOS_QUE_SUBSTITUEM`, que aparece DEZ vezes no SQL do upsert — dez lugares
          // para errar um, e o erro seria um `CASE` comparando a coluna errada, em silêncio.
          l.assunto];
}

/** Os parâmetros do upsert de um trâmite, na ordem do SQL. */
function paramsTramite(p, t) {
  return [p.sigla, p.numero, p.ano, t.ordem, t.setor_sigla, t.setor_nome, t.cd_orgao,
          t.dt_recebto, t.dt_encaminha, t.permanencia_dias, t.quem_encaminhou,
          t.parecer ? String(t.parecer).slice(0, 2000) : null];
}

module.exports = {
  RESULTADOS, RESULTADOS_QUE_SUBSTITUEM,
  DDL_SITUACAO, DDL_TRAMITACAO, DDL_INDICE,
  SQL_UNIVERSO, SQL_JA_CHECADOS, SQL_GRAVAR_SITUACAO, SQL_GRAVAR_TRAMITE,
  montarRodizio, linhaDaSituacao, paramsSituacao, paramsTramite,
};
