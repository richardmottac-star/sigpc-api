// CAMINHO: sigpc-api/lib/acompanhamento.js
//
// A LINHA DO TEMPO DO SISTEMA — só leitura, só superadmin.
//
// ⚠️ ELA NÃO INVENTA UMA FONTE NOVA. Lê `parcela_historico`, que é onde as rotas já gravam, e
// junta o que a linha precisa para ser lida por gente: a entidade, o analista dono e quantas
// PCs a parcela tem. Uma tabela de auditoria paralela teria de ser alimentada por todas as
// rotas, e no primeiro esquecimento passaria a mentir por omissão — que é o pior jeito de
// mentir, porque não dá erro.
//
// ⚠️ O QUE ESTA TELA NÃO PODE MOSTRAR, E POR QUÊ (medido em 26/08/2026):
//
//   · **erro devolvido por rota** — não existe registro. Um 403/409/500 é resposta HTTP e
//     morre no navegador de quem pediu. Não há tabela de log no SIGPC (as `AuditoriaSistema`,
//     `LoginEvento` e `SincronizacaoCritica` do mesmo Postgres são do SEGOV, outro sistema).
//   · **puxada de volta RECUSADA** — pelo mesmo motivo: `podePuxarCi` recusa antes de
//     escrever, e o que não escreve não deixa rastro. Só a puxada CONSUMADA aparece.
//
// Marcar isso é o ponto: uma tela de acompanhamento que finge cobrir o que não cobre é pior
// que uma que diz o recorte. Ver `ALERTAS` abaixo — dois dos quatro pedidos são computáveis.

const ciFila = require('./ci-fila');
const { condicaoTr, condicaoProcesso } = require('./busca');

// ── Os eventos que existem, medidos no banco em 26/08/2026 ──────────────────
//
// ⚠️ A LISTA É DO QUE HÁ, e não do que deveria haver. `ci_decidiu` não aparece nas 1.653
// linhas porque a decisão só passou a gravar histórico em 25/08 e as 5 decisões da tela são
// anteriores — ele está aqui porque a rota o grava a partir de agora.
//
// `familia` agrupa o que é da mesma natureza, para o filtro não virar uma lista de 15 itens
// soltos onde ninguém acha o que procura.
const EVENTOS = {
  parecer:             { rotulo: 'Parecer da analista (baixa)',        familia: 'analise' },
  ci:                  { rotulo: 'Encaminhada ao Controle Interno',    familia: 'ci' },
  ci_decidiu:          { rotulo: 'Decisão do Controle Interno',        familia: 'ci' },
  ci_reabriu:          { rotulo: 'Reaberta no Controle Interno',       familia: 'ci' },
  ci_abriu:            { rotulo: 'Aberta no Controle Interno (rota removida)', familia: 'ci' },
  resposta_diligencia: { rotulo: 'Resposta da analista ao C.I.',       familia: 'ci' },
  situacao:            { rotulo: 'Situação alterada',                  familia: 'analise' },
  correcao_situacao:   { rotulo: 'Correção de situação',               familia: 'correcao' },
  correcao_negada:     { rotulo: 'Correção NEGADA',                    familia: 'correcao' },
  puxar_ci:            { rotulo: 'Puxada de volta do C.I. (desfaz a baixa)', familia: 'correcao' },
  // ⚠️ A puxada e o desfazimento dela são DOIS eventos, e os dois ficam. Substituir a linha
  // da puxada faria a trilha dizer que ela nunca aconteceu — e ela aconteceu, tirou a PC da
  // produtividade por um tempo e a CGE pode perguntar por esse intervalo.
  desfazer_puxar_ci:   { rotulo: 'Puxada do C.I. DESFEITA (baixa restaurada)', familia: 'correcao' },
  estorno:             { rotulo: 'Estorno da baixa',                   familia: 'correcao' },
  solicitacao_correcao:{ rotulo: 'Pedido de correção ao coordenador',  familia: 'correcao' },
  assumir_tr:          { rotulo: 'TR assumida',                        familia: 'carteira' },
  devolucao_tr:        { rotulo: 'TR devolvida ao estoque',            familia: 'carteira' },
  pc_nova:             { rotulo: 'PC cadastrada',                      familia: 'dado' },
  processo_pc:         { rotulo: 'Processo SGPe da PC corrigido',      familia: 'dado' },
  processo_mae:        { rotulo: 'Processo SGPe da TR corrigido',      familia: 'dado' },
  migracao_ci:         { rotulo: 'Migração do C.I. (script)',          familia: 'dado' },
};

const FAMILIAS = {
  analise:  'Análise e parecer',
  ci:       'Controle Interno',
  correcao: 'Correções e estornos',
  carteira: 'Carteira de TRs',
  dado:     'Correção de dado',
};

/** O rótulo em português. Evento novo que ninguém mapeou aparece cru, e não some. */
const rotuloEvento = (e) => EVENTOS[e]?.rotulo || e || '—';
const familiaEvento = (e) => EVENTOS[e]?.familia || 'dado';

// ── O horário de Brasília ───────────────────────────────────────────────────
//
// ⚠️ DOIS PASSOS NO `AT TIME ZONE`, E NÃO UM — armadilha 18 do CLAUDE.md.
// `parcela_historico.criado_em` é `timestamp WITHOUT time zone` guardando UTC. Um passo só
// INTERPRETA o valor como se já fosse de Brasília e soma 3 h: em 12/08 isso mostrou 03:31 às
// 21:31. O certo é converter DE utc PARA Brasília.
const SQL_QUANDO = `((h.criado_em AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')`;

// ── Os alertas ──────────────────────────────────────────────────────────────
//
// ⚠️ DOIS DOS QUATRO PEDIDOS SÃO COMPUTÁVEIS, e os outros dois não têm dado. Ver o cabeçalho.
//
//   ✔ reaberta mais de uma vez  — conta `ci_reabriu` na mesma parcela
//   ✔ decisão do C.I. revertida — há `ci_reabriu` DEPOIS de um `ci_decidiu` na mesma parcela
//   ✘ puxada de volta recusada  — a recusa não escreve
//   ✘ erro devolvido pela rota  — não há log
//
// ⚠️ E ELES SÃO CALCULADOS NO BANCO, sobre a parcela inteira — não sobre a página. Um alerta
// que só enxerga as 20 linhas da tela mudaria de resposta conforme a paginação, que é o mesmo
// defeito dos cards da fila do C.I. que não sofrem o filtro da lista.
// ⚠️ `COUNT(DISTINCT criado_em)`, E NÃO `COUNT(*)` — o defeito que rodar contra o banco pegou.
//
// UM ato pode gravar VÁRIAS linhas na mesma parcela: o `reabrir_ci_encerradas.js` entra por
// lista de PCs e grava uma linha POR PC. A 2020TR000762 p1 tem 2 PCs, logo 2 linhas
// `ci_reabriu` — e contando linhas ela aparecia como "reaberta mais de uma vez" numa
// reabertura ÚNICA. Cinco parcelas acendiam o alerta por engano.
//
// `criado_em` separa os atos porque é `NOW()`, o instante da TRANSAÇÃO: o que foi gravado
// junto tem o mesmo carimbo ao microssegundo, e o que foi gravado em cliques diferentes não.
// É a mesma propriedade que a fila do C.I. usa para reconstruir o lote do encaminhamento.
const SQL_ALERTAS = `
  -- quantas VEZES esta parcela foi reaberta — atos, não linhas
  (SELECT COUNT(DISTINCT r.criado_em)::int FROM parcela_historico r
    WHERE r.tr = h.tr AND r.parcial_num IS NOT DISTINCT FROM h.parcial_num
      AND r.setorial_id IS NOT DISTINCT FROM h.setorial_id
      AND r.evento = 'ci_reabriu')                                   AS n_reaberturas,
  -- houve decisão do C.I. ANTES desta reabertura? (a decisão revertida)
  (SELECT COUNT(DISTINCT d.criado_em)::int FROM parcela_historico d
    WHERE d.tr = h.tr AND d.parcial_num IS NOT DISTINCT FROM h.parcial_num
      AND d.setorial_id IS NOT DISTINCT FROM h.setorial_id
      AND d.evento = 'ci_decidiu' AND d.criado_em < h.criado_em)     AS decisoes_antes`;

/**
 * Os alertas de UMA linha, em JS — a regra fica legível e testável fora do SQL.
 * Devolve uma lista de códigos; a tela decide como desenhar.
 */
function alertasDaLinha(l) {
  const a = [];
  if (l.evento === 'ci_reabriu' && (l.n_reaberturas || 0) > 1) a.push('reaberta_varias');
  if (l.evento === 'ci_reabriu' && (l.decisoes_antes || 0) > 0) a.push('decisao_revertida');
  // Desfazer a baixa é o evento que mais mexe em produtividade — ele aparece marcado sempre,
  // não porque seja erro, mas porque é o que alguém vai querer conferir primeiro.
  if (l.evento === 'puxar_ci' || l.evento === 'estorno') a.push('desfez_baixa');
  // ⚠️ O desfazimento DEVOLVE a produtividade — e por isso também é marcado. A pergunta que
  // ele levanta é a mesma ("por que esta baixa mudou de estado?"), só que na outra direção;
  // deixá-lo sem marca esconderia metade do par que a CGE lê junto.
  if (l.evento === 'desfazer_puxar_ci') a.push('refez_baixa');
  if (l.evento === 'correcao_negada') a.push('negada');
  return a;
}

const ROTULO_ALERTA = {
  reaberta_varias:   'Parcela reaberta mais de uma vez',
  decisao_revertida: 'Decisão do C.I. revertida por reabertura',
  desfez_baixa:      'Desfez a baixa — saiu da produtividade',
  refez_baixa:       'Restaurou a baixa — voltou à produtividade com a data original',
  negada:            'Pedido negado',
};

// ── Quem pode ver ───────────────────────────────────────────────────────────
//
// ⚠️ SÓ O TÉCNICO DO SISTEMA, pelo `perfilEfetivo`. Não é sigilo: é que a tela mostra o que
// TODO MUNDO fez, e um coordenador vendo a trilha do grupo vizinho é uma decisão de gestão
// que ninguém tomou. No papel analista o superadmin também não passa — trocar de papel
// significa alguma coisa.
const papel = require('./papel');
function podeVer(u) {
  if (!u) return false;
  return papel.perfilEfetivo(u) === 'superadmin';
}
const motivoNaoVe = () =>
  'O Acompanhamento mostra o que toda a equipe fez — o acesso é do técnico do sistema.';

// ── O filtro ────────────────────────────────────────────────────────────────
function montarFiltro(q = {}) {
  const w = ['1=1'];
  const params = [];
  const p$ = (v) => { params.push(v); return `$${params.length}`; };

  // ⚠️ AS DATAS SÃO CIVIS BRASILEIRAS, e por isso comparam contra `SQL_QUANDO`, não contra a
  // coluna crua. Comparar `criado_em::date` (UTC) com o que a pessoa digitou faria o dia
  // começar às 21h do dia anterior — a mesma família da armadilha 18.
  const dt = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const de = dt(q.de), ate = dt(q.ate);
  if (de)  w.push(`${SQL_QUANDO}::date >= ${p$(de)}::date`);
  if (ate) w.push(`${SQL_QUANDO}::date <= ${p$(ate)}::date`);

  // Pessoa: o AUTOR da linha, que é quem clicou quando há executor e o dono quando não há.
  const pes = parseInt(q.pessoa_id) || 0;
  if (pes) w.push(`COALESCE(h.executado_por, h.analista_id) = ${p$(pes)}`);

  if (q.perfil && /^[a-z_]{3,20}$/.test(String(q.perfil)))
    w.push(`u.perfil = ${p$(String(q.perfil))}`);

  if (q.evento && EVENTOS[q.evento]) w.push(`h.evento = ${p$(String(q.evento))}`);
  else if (q.familia && FAMILIAS[q.familia]) {
    const lista = Object.keys(EVENTOS).filter(e => EVENTOS[e].familia === q.familia);
    w.push(`h.evento = ANY(${p$(lista)})`);
  }

  // ⚠️ O FILTRO DE TR PASSOU A SAIR DA LIB (31/08/2026). Ele já era `h.tr ILIKE '%..%'` com o
  // curinga escapado à mão — a mesma regra, escrita de novo. Agora é a `condicaoTr`, a mesma
  // das outras três rotas: a mesma caixa da tela tem de achar a mesma coisa em toda tela.
  const cTr = condicaoTr(q.tr, params, params.length + 1, 'h.');
  if (cTr) w.push(cTr.condicao);

  // ⚠️ O PROCESSO PRECISA ATRAVESSAR PARA `prestacoes_contas`, como a busca livre logo abaixo:
  // o histórico guarda `(tr, parcial_num)` e NÃO tem coluna de processo. Sem o `EXISTS` a
  // consulta nem compila; com um `JOIN` no lugar dele, a linha do histórico se multiplicaria
  // por PC da parcela e a lista de eventos inflaria — que é o erro silencioso do par.
  //
  // ⚠️ E vai com o prefixo `x.`, o alias da subconsulta. Sem qualificar, o Postgres resolve o
  // nome contra o escopo de fora quando puder — acerto por sorte, que vira defeito no dia em
  // que o histórico ganhar uma coluna de mesmo nome.
  const cProc = condicaoProcesso(q.processo, params, params.length + 1, 'x.');
  if (cProc) {
    w.push(`EXISTS (SELECT 1 FROM prestacoes_contas x
                     WHERE x.tr = h.tr
                       AND x.parcial_num IS NOT DISTINCT FROM h.parcial_num
                       AND ${cProc.condicao})`);
  }

  // ⚠️ A BUSCA LIVRE ATRAVESSA PARA `prestacoes_contas`, porque processo, PC e entidade não
  // moram no histórico — ele guarda (tr, parcial_num). O `EXISTS` é o que permite procurar
  // por um número de processo e achar o evento da parcela dele.
  const t = String(q.q ?? '').trim();
  if (t) {
    const like = `%${t.replace(/[%_]/g, m => '\\' + m)}%`;
    w.push(`(h.tr ILIKE ${p$(like)}
             OR EXISTS (SELECT 1 FROM prestacoes_contas x
                         WHERE x.tr = h.tr
                           AND x.parcial_num IS NOT DISTINCT FROM h.parcial_num
                           AND (x.codigo_pc ILIKE $${params.length}
                                OR x.processo_pc ILIKE $${params.length}
                                OR x.processo_mae ILIKE $${params.length}
                                OR x.entidade ILIKE $${params.length})))`);
  }
  return { sql: w.join(' AND '), params };
}

// ── A lista ─────────────────────────────────────────────────────────────────
//
// ⚠️ O `LEFT JOIN LATERAL` DA PARCELA TRAZ O ESTADO DE HOJE, não o de quando o evento
// aconteceu. `parcela_historico` guarda `(tr, parcial_num)` e mais nada da parcela: entidade,
// analista e contagem de PCs são lidos agora. Uma linha de 13/08 mostra a entidade atual —
// que é o que se quer para ACHAR a parcela, e não o que se quer para reconstruir o passado.
// A tela diz isso; inventar um retrato histórico exigiria colunas novas.
const SQL_SELECT = `
  SELECT h.id, h.evento, h.tr, h.parcial_num, h.setorial_id,
         h.valor_anterior, h.valor_novo, h.observacao,
         h.analista_id, h.executado_por,
         ${SQL_QUANDO}                                    AS quando,
         COALESCE(h.executado_por, h.analista_id)         AS autor_id,
         u.nome                                           AS autor_nome,
         u.perfil                                         AS autor_perfil,
         d.nome                                           AS dono_nome,
         pa.entidade, pa.analista_nome, pa.analista_id AS parcela_analista_id,
         pa.n_pcs, pa.processo_pc,
         ${SQL_ALERTAS}
    FROM parcela_historico h
    LEFT JOIN usuarios u ON u.id = COALESCE(h.executado_por, h.analista_id)
    LEFT JOIN usuarios d ON d.id = h.analista_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n_pcs, MAX(x.entidade) AS entidade,
             MAX(x.analista_nome) AS analista_nome, MAX(x.analista_id) AS analista_id,
             MIN(x.processo_pc) AS processo_pc
        FROM prestacoes_contas x
       WHERE x.tr = h.tr AND x.parcial_num IS NOT DISTINCT FROM h.parcial_num
         AND x.setorial_id IS NOT DISTINCT FROM h.setorial_id) pa ON true`;

function sqlLista(filtro, pag) {
  const p = pag && Number.isFinite(pag.tamanho) ? pag : { tamanho: 20, offset: 0 };
  // ⚠️ ORDEM TOTAL (o `, h.id`), pela mesma razao da fila do C.I.: varias linhas nascem no
  // MESMO instante — `NOW()` e o da transacao, e o ci_lote grava ate 200 de uma vez. Empate
  // em ORDER BY com LIMIT/OFFSET repete linha numa pagina e some com ela na outra.
  // (Sem crase: comentario dentro de template literal nao leva crase — armadilha 10.)
  return `${SQL_SELECT}
     WHERE ${filtro}
     ORDER BY h.criado_em DESC, h.id DESC
     LIMIT ${p.tamanho} OFFSET ${p.offset}`;
}

const sqlContar = (filtro) => `
  SELECT COUNT(*)::int AS n FROM parcela_historico h
    LEFT JOIN usuarios u ON u.id = COALESCE(h.executado_por, h.analista_id)
   WHERE ${filtro}`;

/** As pessoas que APARECEM no histórico — é o select do filtro, não o cadastro inteiro. */
const SQL_PESSOAS = `
  SELECT u.id, u.nome, u.perfil, COUNT(*)::int AS n
    FROM parcela_historico h
    JOIN usuarios u ON u.id = COALESCE(h.executado_por, h.analista_id)
   GROUP BY u.id, u.nome, u.perfil ORDER BY u.nome`;

/** Os eventos que EXISTEM, com a contagem — o filtro não oferece o que não há. */
const SQL_EVENTOS = `
  SELECT evento, COUNT(*)::int AS n FROM parcela_historico GROUP BY 1 ORDER BY 2 DESC`;

module.exports = {
  EVENTOS, FAMILIAS, ROTULO_ALERTA,
  rotuloEvento, familiaEvento, alertasDaLinha,
  podeVer, motivoNaoVe, montarFiltro, sqlLista, sqlContar,
  SQL_PESSOAS, SQL_EVENTOS, SQL_QUANDO,
  // A paginação é a MESMA da fila do C.I. — uma regra só para os dois lugares que paginam.
  paginacao: ciFila.paginacao, TAMANHOS: ciFila.TAMANHOS, TAMANHO_PADRAO: ciFila.TAMANHO_PADRAO,
};
