// CAMINHO: sigpc-api/lib/gestao.js
//
// A TELA "GESTÃO" DO ANALISTA — o caminho de cada PC, da análise ao arquivamento, e onde o
// processo está no SGPe. Pedida pelo Richard em 16–17/09/2026, adaptada da gestão do Convênio
// Simplificado do SIG.
//
// ⚠️ A TELA NÃO CONTA E NÃO DECIDE (armadilha 16 do sigpc-gt). A etapa de cada PC, a etapa da
// TR, o prazo e as contagens do funil saem DAQUI, prontos. A tela só desenha e filtra.
//
// ⚠️ NADA AQUI ESCREVE. É leitura do acervo do analista, com a posição do SGPe que o rodízio
// (`job_sgpe_situacao.js`) já gravou em `sgpe_situacao`.
//
// ─────────────────────────────────────────────────────────────────────────────
// AS CINCO ETAPAS DA PC — na ordem do fluxo
// ─────────────────────────────────────────────────────────────────────────────
//   analise    parecer ainda não registrado (a PC não está baixada)
//   baixada    baixada, e ainda não foi ao C.I.
//   no_ci      na fila do Controle Interno
//   devolvida  o C.I. devolveu (encerrado ou com o analista) e falta arquivar
//   arquivada  arquivada
//
// ⚠️ "NÃO FOI AO C.I." É A MESMA PERGUNTA DO ARQUIVAMENTO: `enviado_ci` diferente de true OU
// `ci_situacao` vazia (ver `sem_ci` em `lib/arquivamento.js`). Uma segunda forma de responder
// faria a Gestão dizer "no C.I." onde o arquivamento diz "nunca foi".

const { HOJE_BR, CORTE_PRAZO } = require('./datas');
const { CHAVE_PROC_SQL } = require('./busca');
const inval = require('./invalidada');
const papel = require('./papel');

const ETAPAS = ['analise', 'baixada', 'no_ci', 'devolvida', 'arquivada'];
const ORDEM = Object.fromEntries(ETAPAS.map((k, i) => [k, i]));

// O rótulo da situação de uma PC em análise, quando `situacao_atual` não diz nada.
const ROTULO_STATUS = {
  livre: 'Não iniciada',
  analise: 'Em análise',
  diligencia: 'Diligência',
  reanalise: 'Reanálise',
};

// A janela do "vence em breve" — a mesma da faixa laranja da Minha Planilha (30 dias).
const JANELA_VENCE = 30;

/** A etapa de UMA PC. Pura. */
function etapaDaPc(p) {
  if (p.arquivada === true) return 'arquivada';
  if (p.baixada !== true) return 'analise';
  const foiAoCi = p.enviado_ci === true && p.ci_situacao != null && p.ci_situacao !== '';
  if (!foiAoCi) return 'baixada';
  if (p.ci_situacao === 'na_fila') return 'no_ci';
  return 'devolvida';   // 'encerrado' ou 'com_analista': o C.I. já devolveu
}

/**
 * A etapa da TR: a da PC mais atrasada no fluxo, sem contar as arquivadas.
 * Todas arquivadas → 'encerrada'. Pura.
 */
function etapaDaTr(etapas) {
  const vivas = etapas.filter((e) => e !== 'arquivada');
  if (!etapas.length) return 'analise';
  if (!vivas.length) return 'encerrada';
  return vivas.reduce((m, e) => (ORDEM[e] < ORDEM[m] ? e : m), vivas[0]);
}

/** A diligência — a mesma pergunta de `fatosDe` no arquivamento. Pura. */
const emDiligencia = (p) => p.status === 'diligencia' || p.situacao_atual === 'Diligência';

/** O texto da situação de uma PC em análise. Pura. */
function situacaoDaPc(p) {
  if (emDiligencia(p)) return 'Diligência';
  const s = (p.situacao_atual || '').trim();
  if (s) return s;
  return ROTULO_STATUS[p.status] || 'Em análise';
}

/** Diferença em dias entre duas datas 'AAAA-MM-DD' (b − a). Pura. */
function diasEntre(a, b) {
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

const soData = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * O prazo de UMA PC. Só existe para PC em análise.
 *
 * ⚠️ O CORTE É O MESMO DO SINO E DA MINHA PLANILHA (`CORTE_PRAZO`, em `lib/datas.js`): antes
 * dele, `dt_limite_pc` é carimbo de lote, não prazo — decisão do Richard, 10/08/2026. Essa PC
 * sai como 'importado' e NUNCA como vencida.
 *
 * tipo: 'sem' | 'importado' | 'vencido' | 'vence' | 'ok'
 */
function prazoDaPc(p, etapa, hoje) {
  if (etapa !== 'analise') return null;
  const d = soData(p.dt_limite_pc);
  if (!d) return { tipo: 'sem', data: null, dias: null };
  if (d < CORTE_PRAZO) return { tipo: 'importado', data: d, dias: null };
  const dias = diasEntre(hoje, d);
  const tipo = dias < 0 ? 'vencido' : dias <= JANELA_VENCE ? 'vence' : 'ok';
  return { tipo, data: d, dias };
}

/** A linha de `sgpe_situacao` que veio no JOIN, com o prefixo dado. Pura. */
function sgpeDe(r, pre, processo) {
  if (!r[`${pre}checado_em`]) return null;
  return {
    processo: processo || null,
    resultado: r[`${pre}resultado`] || null,
    situacao_portal: r[`${pre}situacao_portal`] || null,
    posicao: r[`${pre}posicao`] || null,
    setor_sigla: r[`${pre}setor_sigla`] || null,
    setor_nome: r[`${pre}setor_nome`] || null,
    dias_no_setor: r[`${pre}dias_no_setor`] ?? null,
    desde: soData(r[`${pre}desde`]),
    checado_em: r[`${pre}checado_em`] instanceof Date
      ? r[`${pre}checado_em`].toISOString() : String(r[`${pre}checado_em`]),
  };
}

const anoDaTr = (tr) => (/^\d{4}/.test(String(tr || '')) ? parseInt(String(tr).slice(0, 4), 10) : null);
const numParcial = (n) => (/^\d+$/.test(String(n)) ? parseInt(n, 10) : 999999);
const ehFinal = (p) => p.tipo === 'final';

function contagemVazia() {
  const c = { trs: 0, trs_encerradas: 0, pcs: 0, valor: 0, vencidas: 0, vencem: 0, diligencias: 0,
    prontas: 0, situacoes: {} };
  for (const e of ETAPAS) { c[e] = 0; c[`valor_${e}`] = 0; }
  return c;
}

/**
 * Monta a resposta da tela a partir das linhas do SQL (uma por PC, já com `arquivamento`
 * pendurado por `lib/arquivamento.anexarEstado`). Pura — é aqui que a regra é testada.
 */
function montar(rows, hoje) {
  const porTr = new Map();
  for (const r of rows) {
    if (!porTr.has(r.tr)) porTr.set(r.tr, []);
    porTr.get(r.tr).push(r);
  }

  const trs = [];
  for (const [tr, lista] of porTr) {
    const pcs = lista.map((r) => {
      const etapa = etapaDaPc(r);
      const arq = r.arquivamento || null;
      return {
        codigo_pc: r.codigo_pc,
        parcial_num: r.parcial_num,
        final: ehFinal(r),
        processo_pc: r.processo_pc || null,
        valor: r.valor == null ? 0 : Number(r.valor) || 0,
        etapa,
        situacao: etapa === 'analise' ? situacaoDaPc(r) : (r.parecer_tipo || null),
        diligencia: etapa === 'analise' && emDiligencia(r),
        prazo: prazoDaPc(r, etapa, hoje),
        data_baixa: soData(r.data_baixa_br),
        ci_situacao: r.ci_situacao || null,
        ci_devolveu_em: arq ? soData(arq.ci_devolveu_em) : null,
        ci_devolveu_carga: arq ? !!arq.ci_devolveu_carga : false,
        arquivamento: arq ? { estado: arq.estado, motivo: arq.motivo || null } : null,
        arquivada_em: soData(r.arquivada_em_br),
        baixa_secretario_em: soData(r.baixa_secretario_em),
        setorial_id: r.setorial_id || null,
        sgpe: sgpeDe(r, 's_', r.processo_pc),
      };
    }).sort((a, b) => (a.final - b.final) || numParcial(a.parcial_num) - numParcial(b.parcial_num)
      || String(a.codigo_pc).localeCompare(String(b.codigo_pc)));

    const etapa = etapaDaTr(pcs.map((p) => p.etapa));
    const vivas = pcs.filter((p) => p.etapa !== 'arquivada');
    // A PC que define a etapa da TR — é o processo dela que interessa na coluna do SGPe.
    const chave = vivas.find((p) => p.etapa === etapa) || null;
    const comPrazo = pcs.filter((p) => p.prazo && ['vencido', 'vence', 'ok'].includes(p.prazo.tipo))
      .sort((a, b) => a.prazo.data.localeCompare(b.prazo.data));
    const f = lista[0];
    const ultima = soData(f.ultima_mov_br) || soData(f.dt_assumida);
    const situacoes = [...new Set(pcs.filter((p) => p.etapa === 'analise').map((p) => p.situacao))];
    const parciais = new Set(pcs.filter((p) => !p.final).map((p) => String(p.parcial_num)));

    trs.push({
      tr,
      ano: anoDaTr(tr),
      entidade: f.entidade || null,
      processo_mae: f.processo_mae || null,
      grupo: f.grupo ?? null,
      dt_assumida: soData(f.dt_assumida),
      ultima_mov: ultima,
      dias_parado: ultima ? diasEntre(ultima, hoje) : null,
      etapa,
      n_parciais: parciais.size,
      tem_final: pcs.some((p) => p.final),
      n_pcs: pcs.length,
      n_baixadas: pcs.filter((p) => p.etapa !== 'analise').length,
      n_arquivadas: pcs.length - vivas.length,
      // O C.I. da TR, contado aqui para a ficha não somar: na fila, e as que ele já devolveu
      // (devolvidas e arquivadas que passaram pelo ciclo).
      n_no_ci: pcs.filter((p) => p.etapa === 'no_ci').length,
      n_ci_devolvidas: pcs.filter((p) => ['devolvida', 'arquivada'].includes(p.etapa)
        && ['encerrado', 'com_analista'].includes(p.ci_situacao)).length,
      valor_total: pcs.reduce((s, p) => s + p.valor, 0),
      situacoes,
      diligencia: pcs.some((p) => p.diligencia),
      prazo_proximo: comPrazo.length ? comPrazo[0].prazo : null,
      sgpe_mae: sgpeDe(f, 'm_', f.processo_mae),
      sgpe_atual: chave && chave.sgpe ? chave.sgpe : sgpeDe(f, 'm_', f.processo_mae),
      pcs,
    });
  }

  // A ordem: primeiro o que pede ação (etapa do fluxo), depois o prazo mais apertado, e a TR.
  const ordemTr = { ...ORDEM, encerrada: ETAPAS.length };
  trs.sort((a, b) => (ordemTr[a.etapa] - ordemTr[b.etapa])
    || ((a.prazo_proximo ? a.prazo_proximo.data : '9999') < (b.prazo_proximo ? b.prazo_proximo.data : '9999') ? -1
      : (a.prazo_proximo ? a.prazo_proximo.data : '9999') > (b.prazo_proximo ? b.prazo_proximo.data : '9999') ? 1 : 0)
    || a.tr.localeCompare(b.tr));

  // ⚠️ AS CONTAGENS VÃO POR ANO JÁ PRONTAS: o seletor de ano da tela troca de recorte sem a
  // tela somar nada.
  const porAno = { todos: contagemVazia() };
  const somar = (c, t) => {
    c.trs++;
    if (t.etapa === 'encerrada') c.trs_encerradas++;
    for (const p of t.pcs) {
      c.pcs++;
      c.valor += p.valor;
      c[p.etapa]++;
      c[`valor_${p.etapa}`] += p.valor;
      if (p.prazo && p.prazo.tipo === 'vencido') c.vencidas++;
      if (p.prazo && p.prazo.tipo === 'vence') c.vencem++;
      if (p.diligencia) c.diligencias++;
      if (p.arquivamento && p.arquivamento.estado === 'pronta') c.prontas++;
      if (p.etapa === 'analise') c.situacoes[p.situacao] = (c.situacoes[p.situacao] || 0) + 1;
    }
  };
  for (const t of trs) {
    somar(porAno.todos, t);
    const k = t.ano == null ? 'sem_ano' : String(t.ano);
    if (!porAno[k]) porAno[k] = contagemVazia();
    somar(porAno[k], t);
  }
  const anos = Object.keys(porAno).filter((k) => k !== 'todos').sort((a, b) => b.localeCompare(a));

  return { hoje, corte_prazo: CORTE_PRAZO, etapas: ETAPAS, anos, contagens: porAno, trs };
}

// ── O SQL ────────────────────────────────────────────────────────────────────
// ⚠️ A CHAVE DO JOIN COM `sgpe_situacao` É A DA `lib/busca` (`CHAVE_PROC_SQL`), a mesma da
// `GET /sgpe/vinculo` — medida em 31/08: a outra deixava 295 processos regionais sem par.
// ⚠️ LEFT JOIN, nunca INNER: processo ainda não sincronizado continua na lista.
// ⚠️ AS DATAS GRAVADAS EM UTC SEM FUSO passam por DOIS `AT TIME ZONE` (armadilha 18).
const SIT_TEXTO = (al) => `(${al}.sigla || ' ' || ${al}.numero_oficial::text || '/' || ${al}.ano::text)`;
const SIT_COLS = (al, pre) => ['resultado', 'situacao_portal', 'posicao', 'setor_sigla', 'setor_nome',
  'dias_no_setor', 'desde', 'checado_em'].map((c) => `${al}.${c} AS ${pre}${c}`).join(', ');

const SQL_PCS = `
  SELECT p.codigo_pc, p.tr, p.tipo, p.parcial_num, p.setorial_id, p.entidade, p.grupo,
         p.processo_pc, p.processo_mae, p.valor, p.status, p.situacao_atual, p.parecer_tipo,
         p.baixada, p.enviado_ci, p.ci_situacao, p.arquivada,
         p.dt_limite_pc::text AS dt_limite_pc,
         p.dt_assumida::text AS dt_assumida,
         p.baixa_secretario_em::text AS baixa_secretario_em,
         ((p.data_baixa AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS data_baixa_br,
         ((p.arquivada_em AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS arquivada_em_br,
         h.ultima_mov_br,
         ${SIT_COLS('s', 's_')},
         ${SIT_COLS('m', 'm_')}
    FROM prestacoes_contas p
    LEFT JOIN (
      SELECT tr, MAX(((criado_em AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)::text AS ultima_mov_br
        FROM parcela_historico
       WHERE tr IN (SELECT tr FROM prestacoes_contas WHERE analista_id = $1)
       GROUP BY tr) h ON h.tr = p.tr
    LEFT JOIN sgpe_situacao s
           ON ${CHAVE_PROC_SQL(SIT_TEXTO('s'))} = ${CHAVE_PROC_SQL("coalesce(p.processo_pc,'')")}
    LEFT JOIN sgpe_situacao m
           ON ${CHAVE_PROC_SQL(SIT_TEXTO('m'))} = ${CHAVE_PROC_SQL("coalesce(p.processo_mae,'')")}
   WHERE p.analista_id = $1 AND ${inval.ativa('p')}
   ORDER BY p.tr, p.codigo_pc`;

const SQL_HOJE = `SELECT ${HOJE_BR}::text AS hoje`;

/**
 * Quem pode ver a Gestão de quem. O analista vê a dele; o coordenador, a de quem é do grupo
 * dele; o superadmin, a de qualquer um. PELO PERFIL EFETIVO — no papel analista, o superadmin
 * vê só a dele (a mesma regra do arquivamento).
 * Devolve { analista_id } ou { status, erro }.
 */
async function escopo(db, quem, analistaPedido) {
  if (!quem) return { status: 401, erro: 'Usuário não identificado.' };
  const perfil = papel.perfilEfetivo(quem);
  const pedido = analistaPedido != null && analistaPedido !== '' ? parseInt(analistaPedido, 10) : null;
  if (perfil === 'controle_interno') return { status: 403, erro: 'Esta tela não faz parte do Controle Interno.' };
  if (!pedido || pedido === quem.id) return { analista_id: quem.id };
  if (perfil === 'superadmin') return { analista_id: pedido };
  if (perfil === 'coordenador') {
    if (!quem.grupo) return { status: 403, erro: 'Coordenador sem grupo cadastrado.' };
    const { rows: [u] } = await db.query('SELECT grupo FROM usuarios WHERE id = $1', [pedido]);
    if (!u || String(u.grupo) !== String(quem.grupo)) return { status: 403, erro: 'Este analista não é do seu grupo.' };
    return { analista_id: pedido };
  }
  return { status: 403, erro: 'O analista vê só a própria gestão.' };
}

/**
 * GET /gestao — a leitura inteira. `anexarEstado` vem de fora (lib/arquivamento) para que o
 * estado do arquivamento seja o MESMO da Minha Planilha e da Produtividade.
 */
async function ler(db, { analista_id, anexarEstado }) {
  const { rows: [h] } = await db.query(SQL_HOJE);
  const { rows } = await db.query(SQL_PCS, [analista_id]);
  if (anexarEstado) await anexarEstado(db, rows);
  return montar(rows, h.hoje);
}

module.exports = {
  ETAPAS, ROTULO_STATUS, JANELA_VENCE,
  etapaDaPc, etapaDaTr, emDiligencia, situacaoDaPc, prazoDaPc, diasEntre, sgpeDe, montar,
  escopo, ler, SQL_PCS, SQL_HOJE,
};
