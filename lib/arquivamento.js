// CAMINHO: sigpc-api/lib/arquivamento.js
//
// ARQUIVAMENTO — as regras (fase 2) e a leitura para a tela (fase 2b). Richard, 13/09/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE É ARQUIVAR
//
// Depois que o Controle Interno devolve a parcial sem pedir diligência, o analista ARQUIVA.
// Isso encerra a parcial e todas as PCs dela.
//
// ⚠️ ARQUIVAR NÃO CONTA PRODUTIVIDADE, e nada daqui pode mexer nela. A PC já contou quando foi
// encaminhada ao C.I. Arquivar é limpeza e fecho: nenhum UPDATE desta lib toca `baixada`,
// `status`, `parecer_tipo`, `data_baixa` nem `enviado_ci`.
//
// ⚠️ A FINAL arquiva por último — depois de todas as demais parciais da TR arquivadas — e exige
// a data da baixa do Secretário no SIGEF, digitada pelo analista. Ela grava a data e passa a
// `origem_baixa` da final a 'secretario' (o valor que o Quadro 2 do CGE reconhece). Com a final
// arquivada, a TR está arquivada: "TR arquivada" é "todas as PCs ativas dela arquivadas", e não
// uma coluna à parte.
//
// ⚠️ A DATA DO SECRETÁRIO É OBRIGATÓRIA E NÃO É VALIDADA — decisão do Richard, 13/09/2026.
// Ela vem do SIGEF, que o analista está lendo na hora, e é instável; qualquer limite aqui
// recusaria data verdadeira. Medido no mesmo dia: das 107 finais com data do Secretário no
// SIGEF, em 101 essa data é ANTERIOR à `data_baixa` gravada aqui (a da carga, ou a da baixa de
// hoje) — um "não pode ser anterior à baixa da final" recusaria a data real em quase todas. A
// responsabilidade pela data é do analista. O único filtro é ser uma data (AAAA-MM-DD que
// existe): a coluna é `date`, e um texto que não é data derrubaria a gravação com um 500.
//
// ─────────────────────────────────────────────────────────────────────────────
// QUANDO A DEVOLUTIVA DO C.I. LIBERA — decisões do Richard, 13 e 14/09/2026
//
// TODO estado de devolutiva libera: 'encerrado' (com ou sem decisão do C.I. registrada — as
// declaradas da carga de 16/08 entram), a RESSALVA e a REABERTA, as duas em 'com_analista'.
//
// ⚠️ A REABERTA BLOQUEAVA ATÉ 14/09/2026, e deixou de bloquear por decisão do Richard: quem
// decide é o analista. O C.I. reabre por várias razões, e muitas vezes o parecer já está regular
// no SIGEF; o analista confere lá e assume a responsabilidade.
//
// BLOQUEIAM: a parcial que nunca foi ao C.I., a que está NA FILA, a que tem PC não baixada ou
// diligência aberta, e a final com parcial pendente.
//
// ⚠️ A REGRA DO BLOQUEIO EXISTE UMA VEZ SÓ: `bloqueioDeFatos`. Os FATOS da parcial chegam por dois
// caminhos — `fatosDe(pcs)`, das PCs travadas na hora de arquivar, e `cteEstado`, agregado em SQL
// para as rotas de leitura —, mas os dois entregam a mesma forma e caem na mesma função. Uma
// segunda cópia da regra na leitura seria a que ficaria velha (armadilha 16 e o MAPA_PLAN_EST).
//
// ⚠️ AS FUNÇÕES RECEBEM UM CLIENTE (ou o pool) E NÃO FAZEM BEGIN NEM COMMIT. Quem faz é a rota.
// É o que permite testá-las contra o banco real dentro de BEGIN/ROLLBACK (armadilha 10).
//
// ⚠️ TRÊS ESCOLHAS CONFERIDAS PELO RICHARD EM 13/09/2026: `executado_por` é gravado SEMPRE
// (como na engenharia, e não nulo quando o dono executa); o coordenador arquiva e desarquiva de
// qualquer grupo (como na invalidação); e a final gravada com o nº de uma parcial (há 5 com
// parcial_num '1') é recusada até o dado ser corrigido.
// ─────────────────────────────────────────────────────────────────────────────

const inval = require('./invalidada');
const papel = require('./papel');
const ciLib = require('./ci');

const EVENTO_ARQUIVAR = 'arquivamento';
const EVENTO_DESARQUIVAR = 'arquivamento_desfeito';
// Arquivam PCs de qualquer analista. O analista arquiva as que são dele.
const PERFIS_SUPERVISAO = ['superadmin', 'coordenador'];
const ORIGEM_SECRETARIO = 'secretario';
const MOTIVO_MIN = 15;
const MOTIVO_MAX = 500;
const OBS_MAX = 2000;

const ehFinal = (p) => p && p.tipo === 'final';
const br = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const lista = (pcs) => pcs.map((p) => p.codigo_pc).join(', ');
const falha = (status, erro) => ({ status, erro });
const numParcial = (n) => (/^[0-9]+$/.test(String(n || '')) ? parseInt(n, 10) : 999999);

// ── SQL ─────────────────────────────────────────────────────────────────────

// A parcela, com lock, e SÓ as PCs ativas — a invalidada não é arquivada nem conta para nada.
const SQL_PARCELA = `
  SELECT codigo_pc, tr, parcial_num, setorial_id, tipo, analista_id, analista_nome,
         baixada, status, situacao_atual, enviado_ci, ci_situacao, origem_baixa, parecer_tipo,
         arquivada, arquivada_em::text AS arquivada_em, arquivada_por, obs_arquivamento,
         baixa_secretario_em::text AS baixa_secretario_em, baixa_secretario_por,
         baixa_secretario_registrada_em::text AS baixa_secretario_registrada_em
    FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3 AND ${inval.ativa('')}
   ORDER BY codigo_pc
     FOR UPDATE`;

// As DEMAIS PCs ativas da TR, com lock — a final só arquiva com todas elas arquivadas.
const SQL_DEMAIS_DA_TR = `
  SELECT codigo_pc, parcial_num, tipo, arquivada FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND parcial_num IS DISTINCT FROM $3 AND ${inval.ativa('')}
   ORDER BY parcial_num, codigo_pc
     FOR UPDATE`;

// A PC final ativa da TR, com lock — desarquivar uma parcial leva a final junto.
const SQL_FINAIS_DA_TR = `
  SELECT codigo_pc, parcial_num, analista_id, arquivada FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND tipo = 'final' AND ${inval.ativa('')}
   ORDER BY codigo_pc
     FOR UPDATE`;

// A foto do que o arquivamento e o desarquivamento escrevem — vai para `estado_anterior`.
const SQL_FOTO = `
  SELECT COALESCE(jsonb_object_agg(codigo_pc, jsonb_build_object(
           'origem_baixa', origem_baixa, 'arquivada', arquivada, 'arquivada_em', arquivada_em,
           'arquivada_por', arquivada_por, 'obs_arquivamento', obs_arquivamento,
           'baixa_secretario_em', baixa_secretario_em, 'baixa_secretario_por', baixa_secretario_por,
           'baixa_secretario_registrada_em', baixa_secretario_registrada_em)), '{}'::jsonb) AS foto
    FROM prestacoes_contas WHERE codigo_pc = ANY($1)`;

// ⚠️ POR LISTA EXPLÍCITA DE CHAVES (armadilha 12), as lidas com FOR UPDATE logo acima. E o
// `AND arquivada = false` é a idempotência no nível da linha: o que já está arquivado não é
// regravado. NENHUM destes UPDATEs menciona baixada, status, parecer_tipo nem data_baixa.
const SQL_ARQUIVAR = `
  UPDATE prestacoes_contas
     SET arquivada = true, arquivada_em = NOW(), arquivada_por = $2, obs_arquivamento = $3,
         atualizado_em = NOW()
   WHERE codigo_pc = ANY($1) AND arquivada = false
  RETURNING codigo_pc`;

const SQL_ARQUIVAR_FINAL = `
  UPDATE prestacoes_contas
     SET arquivada = true, arquivada_em = NOW(), arquivada_por = $2, obs_arquivamento = $3,
         baixa_secretario_em = $4::date, baixa_secretario_por = $2,
         baixa_secretario_registrada_em = NOW(), origem_baixa = '${ORIGEM_SECRETARIO}',
         atualizado_em = NOW()
   WHERE codigo_pc = ANY($1) AND arquivada = false AND tipo = 'final'
  RETURNING codigo_pc`;

const SQL_DESARQUIVAR = `
  UPDATE prestacoes_contas
     SET arquivada = false, arquivada_em = NULL, arquivada_por = NULL, obs_arquivamento = NULL,
         atualizado_em = NOW()
   WHERE codigo_pc = ANY($1) AND arquivada = true
  RETURNING codigo_pc`;

// A final volta com a `origem_baixa` que tinha antes do arquivamento, lida da foto que o próprio
// arquivamento gravou em `estado_anterior`. $1 = { codigo_pc: origem_baixa_anterior }.
const SQL_DESARQUIVAR_FINAL = `
  UPDATE prestacoes_contas p
     SET arquivada = false, arquivada_em = NULL, arquivada_por = NULL, obs_arquivamento = NULL,
         baixa_secretario_em = NULL, baixa_secretario_por = NULL,
         baixa_secretario_registrada_em = NULL, origem_baixa = v.origem, atualizado_em = NOW()
    FROM (SELECT key AS codigo_pc, value #>> '{}' AS origem FROM jsonb_each($1::jsonb)) v
   WHERE p.codigo_pc = v.codigo_pc AND p.arquivada = true AND p.tipo = 'final'
  RETURNING p.codigo_pc`;

// O último arquivamento da parcela da final que guardou foto — de onde sai a origem anterior.
const SQL_ULTIMO_ARQUIVAMENTO = `
  SELECT estado_anterior FROM parcela_historico
   WHERE setorial_id IS NOT DISTINCT FROM $1 AND tr = $2 AND parcial_num IS NOT DISTINCT FROM $3
     AND evento = '${EVENTO_ARQUIVAR}' AND estado_anterior IS NOT NULL
   ORDER BY criado_em DESC, id DESC
   LIMIT 1`;

const SQL_HISTORICO = `
  INSERT INTO parcela_historico
    (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
     observacao, executado_por, estado_anterior)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING id`;

// ── REGRAS PURAS ────────────────────────────────────────────────────────────

/**
 * Quem pode arquivar: o analista dono de TODAS as PCs da parcial, o coordenador e o superadmin.
 * ⚠️ PERFIL EFETIVO — no papel `analista` o superadmin é analista, e arquiva só o que é dele.
 */
function podeArquivar(quem, perfil, pcs) {
  if (!quem) return { pode: false, status: 401, motivo: 'Usuário não identificado.' };
  if (PERFIS_SUPERVISAO.includes(perfil)) return { pode: true };
  const alheias = pcs.filter((p) => String(p.analista_id) !== String(quem.id));
  if (!alheias.length) return { pode: true };
  return { pode: false, status: 403, motivo: 'Só o analista dono da parcial, o coordenador ou o superadmin arquiva. '
    + (alheias.length === pcs.length ? 'Esta parcial não é sua.' : `As PCs ${lista(alheias)} são de outro analista.`) };
}

/** Quem pode desarquivar: só coordenador e superadmin, pelo perfil efetivo. */
function podeDesarquivar(quem, perfil) {
  if (!quem) return { pode: false, status: 401, motivo: 'Usuário não identificado.' };
  if (PERFIS_SUPERVISAO.includes(perfil)) return { pode: true };
  return { pode: false, status: 403, motivo: 'Só o coordenador e o superadmin desarquivam.' };
}

/**
 * Os FATOS da parcial que a regra do bloqueio lê, a partir das PCs dela. É a mesma forma que
 * `cteEstado` entrega em SQL — ver o cabeçalho.
 */
function fatosDe(pcs) {
  const cod = (p) => p.codigo_pc;
  return {
    dilig: pcs.filter((p) => p.status === 'diligencia' || p.situacao_atual === 'Diligência').map(cod),
    nao_baixadas: pcs.filter((p) => p.baixada !== true).map(cod),
    sem_ci: pcs.filter((p) => p.enviado_ci !== true || !p.ci_situacao).map(cod),
    na_fila: pcs.filter((p) => p.ci_situacao === 'na_fila').map(cod),
    com_analista: pcs.some((p) => p.ci_situacao === 'com_analista'),
    fora: pcs.filter((p) => p.ci_situacao && !['encerrado', 'com_analista'].includes(p.ci_situacao))
      .map((p) => `${p.codigo_pc}: ${p.ci_situacao}`),
  };
}

/**
 * O que impede a parcial de arquivar, dito do jeito que a pessoa precisa ler. null = nada.
 * ⚠️ A ÚNICA CÓPIA DA REGRA. A reabertura pelo C.I. saiu daqui em 14/09/2026 — ver o cabeçalho.
 */
function bloqueioDeFatos(f) {
  if (f.dilig.length) return `Há diligência aberta nesta parcial (${f.dilig.join(', ')}). Conclua a diligência antes de arquivar.`;
  if (f.nao_baixadas.length) return `Falta baixar ${f.nao_baixadas.length} PC${f.nao_baixadas.length > 1 ? 's' : ''} desta parcial `
    + `(${f.nao_baixadas.join(', ')}). A parcial só arquiva com todas as PCs baixadas.`;
  if (f.sem_ci.length) return `A parcial ainda não foi encaminhada ao Controle Interno (${f.sem_ci.join(', ')}). `
    + 'Ela só arquiva depois que o C.I. devolver.';
  if (f.na_fila.length) return 'A parcial está na fila do Controle Interno — o C.I. ainda não devolveu. '
    + 'Ela só arquiva depois da devolutiva.';
  if (f.fora.length) return `Situação no C.I. não permite arquivar (${f.fora.join(', ')}).`;
  return null;
}

/** Atalho usado pelo `arquivar`: fatos das PCs + a regra. */
function bloqueio(pcs) {
  return bloqueioDeFatos(fatosDe(pcs));
}

/** "falta arquivar a Parcial 1" / "faltam arquivar as Parciais 1, 3" — o bloqueio da final. */
function textoPendentes(pendentes) {
  return pendentes.length === 1 ? `falta arquivar a Parcial ${pendentes[0]}`
    : `faltam arquivar as Parciais ${pendentes.join(', ')}`;
}

/**
 * A data da baixa do Secretário: OBRIGATÓRIA e SEM LIMITE — ver o cabeçalho. O único filtro é
 * ser uma data que existe, em AAAA-MM-DD; futura, antiga ou anterior à baixa da final, passa.
 */
function validarDataSecretario(s) {
  if (s == null || String(s).trim() === '')
    return 'Informe a data da baixa do Secretário no SIGEF — ela é obrigatória para arquivar a PC final.';
  const v = String(s).trim();
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    return `"${v}" não é uma data. Informe a data da baixa do Secretário como AAAA-MM-DD.`;
  return null;
}

function validarMotivo(texto) {
  const m = (texto ?? '').toString().trim();
  if (!m) return 'Escreva o motivo do desarquivamento — ele fica no histórico.';
  if (m.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;
  if (m.length > MOTIVO_MAX) return `O motivo passa de ${MOTIVO_MAX} caracteres.`;
  return null;
}

function validarObs(texto) {
  const o = (texto ?? '').toString().trim();
  if (o.length > OBS_MAX) return `A observação passa de ${OBS_MAX} caracteres.`;
  return null;
}

/** O estado atual, para a resposta do arquivar/desarquivar — inclusive a idempotente. */
function estadoDe(pcs, trArquivada) {
  const f = pcs[0] || {};
  return {
    arquivada: pcs.length > 0 && pcs.every((p) => p.arquivada === true),
    arquivada_em: f.arquivada_em ?? null, arquivada_por: f.arquivada_por ?? null,
    baixa_secretario_em: f.baixa_secretario_em ?? null,
    tr_arquivada: !!trArquivada,
  };
}

async function registrar(cli, h) {
  const { rows: [r] } = await cli.query(SQL_HISTORICO, [h.tr, h.parcial_num, h.setorial_id, h.evento,
    h.valor_anterior ?? null, h.valor_novo ?? null, h.analista_id ?? null, h.observacao ?? null,
    h.executado_por ?? null, h.estado_anterior == null ? null : JSON.stringify(h.estado_anterior)]);
  return r.id;
}

async function trArquivada(cli, setorial_id, tr) {
  const { rows: [r] } = await cli.query(
    `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE arquivada)::int a FROM prestacoes_contas
      WHERE setorial_id = $1 AND tr = $2 AND ${inval.ativa('')}`, [setorial_id, tr]);
  return r.n > 0 && r.a === r.n;
}

// ── ARQUIVAR ────────────────────────────────────────────────────────────────

/**
 * Arquiva a parcial (setorial_id, tr, parcial_num). Devolve { status, erro } ou { status: 200, data }.
 * ⚠️ Não faz BEGIN nem COMMIT — ver o cabeçalho.
 */
async function arquivar(cli, { quem, setorial_id, tr, parcial_num, data_secretario, obs }) {
  const setorial = setorial_id || 'FCEE';
  const num = String(parcial_num);
  const perfil = papel.perfilEfetivo(quem);

  const { rows: pcs } = await cli.query(SQL_PARCELA, [setorial, tr, num]);
  if (!pcs.length) return falha(404, 'Parcial não encontrada.');
  const finais = pcs.filter(ehFinal);
  if (finais.length && finais.length !== pcs.length)
    return falha(409, `A parcial ${num} mistura PC final e parciais (${lista(finais)} é final). `
      + 'Corrija o nº da parcial da final antes de arquivar.');
  const daFinal = finais.length > 0;

  const perm = podeArquivar(quem, perfil, pcs);
  if (!perm.pode) return falha(perm.status, perm.motivo);

  // ⚠️ IDEMPOTÊNCIA: tudo já arquivado devolve o estado atual, sem erro e sem regravar.
  const abertas = pcs.filter((p) => p.arquivada !== true);
  if (!abertas.length)
    return { status: 200, data: { tr, parcial_num: num, final: daFinal, ja_estava: true, arquivadas: 0,
      codigos: [], ...estadoDe(pcs, await trArquivada(cli, setorial, tr)) } };

  const b = bloqueio(pcs);
  if (b) return falha(409, b);
  const eObs = validarObs(obs);
  if (eObs) return falha(400, eObs);

  let dataSec = null;
  if (daFinal) {
    const { rows: demais } = await cli.query(SQL_DEMAIS_DA_TR, [setorial, tr, num]);
    const pend = demais.filter((p) => p.arquivada !== true);
    if (pend.length) {
      const porParcial = {};
      for (const p of pend) porParcial[p.parcial_num] = (porParcial[p.parcial_num] || 0) + 1;
      return falha(409, 'A PC final só arquiva depois de todas as parciais da TR. Ainda não arquivadas: '
        + Object.entries(porParcial).map(([k, n]) => `parcial ${k} (${n} PC${n > 1 ? 's' : ''})`).join(', ') + '.');
    }
    const eData = validarDataSecretario(data_secretario);
    if (eData) return falha(400, eData);
    dataSec = String(data_secretario).trim();
  }

  const codigos = abertas.map((p) => p.codigo_pc);
  const obsTxt = (obs ?? '').toString().trim() || null;
  let foto = null;
  if (daFinal) foto = (await cli.query(SQL_FOTO, [codigos])).rows[0].foto;
  const { rows: feitas } = daFinal
    ? await cli.query(SQL_ARQUIVAR_FINAL, [codigos, quem.id, obsTxt, dataSec])
    : await cli.query(SQL_ARQUIVAR, [codigos, quem.id, obsTxt]);
  if (feitas.length !== codigos.length)
    throw new Error(`Esperava arquivar ${codigos.length} PC(s) e o banco arquivou ${feitas.length}.`);

  const dono = pcs[0].analista_id ?? null;
  const historico_id = await registrar(cli, {
    tr, parcial_num: num, setorial_id: setorial, evento: EVENTO_ARQUIVAR,
    valor_anterior: pcs[0].ci_situacao || null,
    valor_novo: daFinal ? 'arquivada — TR encerrada' : 'arquivada',
    analista_id: dono,
    observacao: `Arquivada por ${quem.nome}: ${daFinal ? 'PC final' : `parcial ${num}`} `
      + `(${codigos.length} PC${codigos.length > 1 ? 's' : ''}: ${codigos.join(', ')}).`
      + (daFinal ? ` Baixa do Secretário no SIGEF, informada pelo analista: ${br(dataSec)}. A TR está encerrada.` : '')
      + (obsTxt ? `\nObservação: ${obsTxt}` : ''),
    // ⚠️ SEMPRE quem executou — decisão do Richard para esta rota, como na engenharia.
    executado_por: quem.id,
    // Só a final destrói dado (a origem_baixa anterior) — é dela a foto, e é dela que o
    // desarquivamento lê o valor para devolver.
    estado_anterior: daFinal ? { pcs: foto } : null,
  });

  const { rows: depois } = await cli.query(SQL_PARCELA, [setorial, tr, num]);
  return { status: 200, data: { tr, parcial_num: num, final: daFinal, ja_estava: false,
    arquivadas: feitas.length, codigos: feitas.map((r) => r.codigo_pc), historico_id,
    ...estadoDe(depois, await trArquivada(cli, setorial, tr)) } };
}

// ── DESARQUIVAR ─────────────────────────────────────────────────────────────

/** Desarquiva a PC final de uma TR, devolvendo a origem_baixa da foto. Uso interno. */
async function desarquivarFinal(cli, { quem, setorial, tr, numFinal, pcsArquivadas, observacao }) {
  const codigos = pcsArquivadas.map((p) => p.codigo_pc);
  const { rows: [ult] } = await cli.query(SQL_ULTIMO_ARQUIVAMENTO, [setorial, tr, numFinal]);
  const fotoArq = (ult && ult.estado_anterior && ult.estado_anterior.pcs) || {};
  const origens = {};
  const semFoto = [];
  for (const c of codigos) {
    if (fotoArq[c] && Object.prototype.hasOwnProperty.call(fotoArq[c], 'origem_baixa')) origens[c] = fotoArq[c].origem_baixa;
    else semFoto.push(c);
  }
  if (semFoto.length)
    return falha(409, `Não há registro da origem_baixa anterior da final (${semFoto.join(', ')}) — `
      + 'o arquivamento dela não passou por esta rota. Desarquive pelo SQL de reversão.');
  const foto = (await cli.query(SQL_FOTO, [codigos])).rows[0].foto;
  const { rows: feitas } = await cli.query(SQL_DESARQUIVAR_FINAL, [JSON.stringify(origens)]);
  if (feitas.length !== codigos.length)
    throw new Error(`Esperava desarquivar ${codigos.length} PC(s) finais e o banco desarquivou ${feitas.length}.`);
  const historico_id = await registrar(cli, {
    tr, parcial_num: numFinal, setorial_id: setorial, evento: EVENTO_DESARQUIVAR,
    valor_anterior: 'arquivada', valor_novo: 'ativa',
    analista_id: pcsArquivadas[0].analista_id ?? null,
    observacao, executado_por: quem.id, estado_anterior: { pcs: foto },
  });
  return { status: 200, codigos: feitas.map((r) => r.codigo_pc), historico_id, origens };
}

/**
 * Desarquiva a parcial. Se ela não for a final e a final da TR estiver arquivada, a final vai
 * junto — a TR não pode ficar arquivada com parcial ativa.
 * ⚠️ Não faz BEGIN nem COMMIT — ver o cabeçalho.
 */
async function desarquivar(cli, { quem, setorial_id, tr, parcial_num, motivo }) {
  const setorial = setorial_id || 'FCEE';
  const num = String(parcial_num);
  const perfil = papel.perfilEfetivo(quem);

  const perm = podeDesarquivar(quem, perfil);
  if (!perm.pode) return falha(perm.status, perm.motivo);
  const eM = validarMotivo(motivo);
  if (eM) return falha(400, eM);
  const mot = String(motivo).trim();

  const { rows: pcs } = await cli.query(SQL_PARCELA, [setorial, tr, num]);
  if (!pcs.length) return falha(404, 'Parcial não encontrada.');
  const finais = pcs.filter(ehFinal);
  if (finais.length && finais.length !== pcs.length)
    return falha(409, `A parcial ${num} mistura PC final e parciais (${lista(finais)} é final). `
      + 'Corrija o nº da parcial da final antes de desarquivar.');
  const daFinal = finais.length > 0;

  const arquivadas = pcs.filter((p) => p.arquivada === true);
  if (!arquivadas.length)
    return { status: 200, data: { tr, parcial_num: num, final: daFinal, ja_estava: true, desarquivadas: 0,
      codigos: [], final_junto: null, ...estadoDe(pcs, await trArquivada(cli, setorial, tr)) } };

  const assinatura = ` · desarquivada por ${quem.nome}`;
  let codigos, historico_id, finalJunto = null;

  if (daFinal) {
    const r = await desarquivarFinal(cli, { quem, setorial, tr, numFinal: num, pcsArquivadas: arquivadas,
      observacao: `${mot}${assinatura} · a data do Secretário foi apagada e a origem_baixa voltou ao valor anterior` });
    if (r.erro) return r;
    codigos = r.codigos; historico_id = r.historico_id;
  } else {
    // A parcela já está travada; a final é travada agora, dentro da mesma transação.
    const { rows: fins } = await cli.query(SQL_FINAIS_DA_TR, [setorial, tr]);
    const finArq = fins.filter((p) => p.arquivada === true);

    const foto = (await cli.query(SQL_FOTO, [arquivadas.map((p) => p.codigo_pc)])).rows[0].foto;
    const { rows: feitas } = await cli.query(SQL_DESARQUIVAR, [arquivadas.map((p) => p.codigo_pc)]);
    if (feitas.length !== arquivadas.length)
      throw new Error(`Esperava desarquivar ${arquivadas.length} PC(s) e o banco desarquivou ${feitas.length}.`);
    codigos = feitas.map((r) => r.codigo_pc);
    historico_id = await registrar(cli, {
      tr, parcial_num: num, setorial_id: setorial, evento: EVENTO_DESARQUIVAR,
      valor_anterior: 'arquivada', valor_novo: 'ativa', analista_id: pcs[0].analista_id ?? null,
      observacao: `${mot}${assinatura}` + (finArq.length ? ' · a PC final da TR foi desarquivada junto' : ''),
      executado_por: quem.id, estado_anterior: { pcs: foto },
    });

    if (finArq.length) {
      const r = await desarquivarFinal(cli, { quem, setorial, tr, numFinal: finArq[0].parcial_num,
        pcsArquivadas: finArq,
        observacao: `Desarquivada junto porque a parcial ${num} foi desarquivada — a TR não fica arquivada `
          + `com parcial ativa. Motivo: ${mot}${assinatura} · a data do Secretário foi apagada e a origem_baixa voltou ao valor anterior` });
      if (r.erro) return r;
      finalJunto = { parcial_num: finArq[0].parcial_num, codigos: r.codigos, historico_id: r.historico_id };
    }
  }

  const { rows: depois } = await cli.query(SQL_PARCELA, [setorial, tr, num]);
  return { status: 200, data: { tr, parcial_num: num, final: daFinal, ja_estava: false,
    desarquivadas: codigos.length, codigos, historico_id, final_junto: finalJunto,
    ...estadoDe(depois, await trArquivada(cli, setorial, tr)) } };
}

// ═════════════════════════════════════════════════════════════════════════════
//  LEITURA PARA A TELA — fase 2b (13/09/2026). Nenhuma escrita daqui para baixo.
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠️ "C.I. DEVOLVEU" É A DATA GRAVADA DA DEVOLUÇÃO — `ci_encerrado_em` (de acordo), senão
// `ci_tecnico_em` (a decisão, nos dois ramos), senão o último evento do C.I. no histórico. Nas
// encerradas pela carga de 16/08 não existe data nenhuma (864 das 866, medido em 13/09), e aí
// vai `ci_devolveu_carga: true` para a tela escrever "— (carga de 16/08)". Decisão do Richard:
// NÃO INVENTAR DATA.
//
// ⚠️ OS FATOS SAEM DO MESMO FORMATO DE `fatosDe`, agregados em SQL — é o que faz a leitura e o
// arquivar caírem na mesma `bloqueioDeFatos`.

/** O WITH das três CTEs do estado. `filtroTr` recorta as TRs (sobre o alias `q`). */
function cteEstado(filtroTr = 'true') {
  return `
  arq_parc AS (
    SELECT q.setorial_id AS s, q.tr AS t, q.parcial_num AS n,
           COUNT(*)::int AS n_pcs,
           BOOL_OR(q.tipo = 'final') AS tem_final, BOOL_AND(q.tipo = 'final') AS so_final,
           COALESCE(array_agg(q.codigo_pc ORDER BY q.codigo_pc)
             FILTER (WHERE q.status = 'diligencia' OR q.situacao_atual = 'Diligência'), '{}') AS dilig,
           COALESCE(array_agg(q.codigo_pc ORDER BY q.codigo_pc)
             FILTER (WHERE q.baixada IS DISTINCT FROM true), '{}') AS nao_baixadas,
           COALESCE(array_agg(q.codigo_pc ORDER BY q.codigo_pc)
             FILTER (WHERE q.enviado_ci IS DISTINCT FROM true OR q.ci_situacao IS NULL OR q.ci_situacao = ''), '{}') AS sem_ci,
           COALESCE(array_agg(q.codigo_pc ORDER BY q.codigo_pc)
             FILTER (WHERE q.ci_situacao = 'na_fila'), '{}') AS na_fila,
           COALESCE(BOOL_OR(q.ci_situacao = 'com_analista'), false) AS com_analista,
           COALESCE(array_agg(q.codigo_pc || ': ' || q.ci_situacao ORDER BY q.codigo_pc)
             FILTER (WHERE q.ci_situacao IS NOT NULL AND q.ci_situacao <> ''
                       AND q.ci_situacao NOT IN ('encerrado', 'com_analista')), '{}') AS fora,
           BOOL_AND(q.arquivada) AS arquivada,
           MAX(q.arquivada_em)::text AS arquivada_em, MAX(q.arquivada_por) AS arquivada_por,
           MAX(q.baixa_secretario_em)::text AS baixa_secretario_em,
           MAX(q.ci_situacao) AS ci_situacao, BOOL_OR(q.ci_tecnico_id IS NOT NULL) AS tem_tecnico,
           COALESCE(MAX(q.ci_encerrado_em), MAX(q.ci_tecnico_em))::text AS ci_col_em,
           BOOL_AND(q.baixada) FILTER (WHERE q.tipo = 'final') AS final_baixada,
           MAX((q.data_baixa AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date)::text AS data_baixa_br,
           MIN(q.analista_id) AS analista_id,
           COALESCE(array_agg(DISTINCT q.analista_id) FILTER (WHERE q.analista_id IS NOT NULL), '{}') AS donos
      FROM prestacoes_contas q
     WHERE ${inval.ativa('q')} AND (${filtroTr})
     GROUP BY q.setorial_id, q.tr, q.parcial_num),
  arq_ci AS (
    SELECT DISTINCT ON (h.setorial_id, h.tr, h.parcial_num)
           h.setorial_id AS s, h.tr AS t, h.parcial_num AS n, h.evento, h.criado_em::text AS em,
           h.criado_em AS em_ts
      FROM parcela_historico h
     WHERE h.evento IN ('ci_decidiu', 'ci_reabriu') AND h.tr IN (SELECT t FROM arq_parc)
     ORDER BY h.setorial_id, h.tr, h.parcial_num, h.criado_em DESC, h.id DESC),
  arq_opc AS (
    SELECT DISTINCT ON (q.setorial_id, q.tr, q.parcial_num)
           q.setorial_id AS s, q.tr AS t, q.parcial_num AS n, m.opcao, m.texto, m.criado_em AS em_ts
      FROM ci_mensagem m
      JOIN prestacoes_contas q ON q.codigo_pc = m.codigo_pc
     WHERE m.direcao = 'ci_para_analista' AND m.opcao IS NOT NULL AND q.tr IN (SELECT t FROM arq_parc)
     ORDER BY q.setorial_id, q.tr, q.parcial_num, m.criado_em DESC, m.id DESC),
  arq_tr AS (
    SELECT s, t,
           COUNT(*) FILTER (WHERE NOT tem_final)::int AS n_parciais,
           COUNT(*) FILTER (WHERE NOT tem_final AND arquivada)::int AS n_parciais_arquivadas,
           COALESCE(array_agg(n ORDER BY (CASE WHEN n ~ '^[0-9]+$' THEN n::int ELSE 999999 END), n)
             FILTER (WHERE NOT tem_final AND NOT arquivada), '{}') AS pendentes,
           BOOL_AND(arquivada) AS tr_arquivada
      FROM arq_parc GROUP BY s, t)`;
}

/** A consulta do estado, uma linha por parcial. `filtroTr` como em `cteEstado`. */
function sqlEstado(filtroTr) {
  return `WITH ${cteEstado(filtroTr)}
    SELECT ap.*, ac.evento AS ci_ultimo_evento, ac.em AS ci_ultimo_em,
           at.n_parciais, at.n_parciais_arquivadas, at.pendentes, at.tr_arquivada,
           -- A opção só vale se a mensagem for do último ato do C.I. (gravados na mesma transação).
           CASE WHEN ao.em_ts IS NOT NULL AND (ac.em_ts IS NULL OR ao.em_ts >= ac.em_ts) THEN ao.opcao END AS ci_opcao,
           CASE WHEN ao.em_ts IS NOT NULL AND (ac.em_ts IS NULL OR ao.em_ts >= ac.em_ts) THEN ao.texto END AS ci_opcao_texto
      FROM arq_parc ap
      LEFT JOIN arq_ci ac ON ac.t = ap.t AND ac.n IS NOT DISTINCT FROM ap.n AND ac.s IS NOT DISTINCT FROM ap.s
      LEFT JOIN arq_tr at ON at.t = ap.t AND at.s IS NOT DISTINCT FROM ap.s
      LEFT JOIN arq_opc ao ON ao.t = ap.t AND ao.n IS NOT DISTINCT FROM ap.n AND ao.s IS NOT DISTINCT FROM ap.s`;
}

/**
 * O estado de arquivamento de UMA parcial, a partir de uma linha de `sqlEstado`. Puro.
 * estado: 'arquivada' | 'pronta' | 'bloqueada'.
 */
function estadoDaLinha(r) {
  const ciDevolveuEm = r.ci_col_em || r.ci_ultimo_em || null;
  const base = {
    tr: r.t, parcial_num: r.n, setorial_id: r.s, final: !!r.tem_final, n_pcs: r.n_pcs,
    ci_situacao: r.ci_situacao || null,
    ci_devolveu_em: ciDevolveuEm,
    ci_devolveu_carga: !ciDevolveuEm && r.ci_situacao === 'encerrado' && !r.tem_tecnico,
    arquivada_em: r.arquivada_em || null, arquivada_por: r.arquivada_por ?? null,
    baixa_secretario_em: r.baixa_secretario_em || null,
    tr_arquivada: !!r.tr_arquivada,
    parciais_total: r.n_parciais ?? 0, parciais_arquivadas: r.n_parciais_arquivadas ?? 0,
    pendentes: r.pendentes || [],
    final_baixada: r.tem_final ? !!r.final_baixada : null,
    data_baixa_final: r.tem_final ? (r.data_baixa_br || null) : null,
    // A opção do C.I. que a analista lê no cartão: a gravada no último ato do C.I.; nas antigas,
    // sem opção, deduzida — encerrada é "De acordo", ressalva é "Com pendência", e a reaberta
    // antiga fica sem (decisão do Richard, 14/09/2026).
    ci_opcao: r.ci_opcao || (r.ci_situacao === 'encerrado' ? 'de_acordo'
      : r.ci_situacao === 'com_analista' && r.ci_ultimo_evento !== 'ci_reabriu' ? 'com_pendencia' : null),
    // ⚠️ A OPÇÃO FOI DEDUZIDA, OU ALGUÉM A REGISTROU? (22/09/2026, a partir de um caso que o
    // Richard viu na tela.) A linha acima DEDUZ a opção das antigas, e a tela escrevia a frase
    // "O C.I. está de acordo" sem distinguir as duas origens — sem técnico, sem data e sem
    // mensagem, porque ninguém decidiu: o `encerrado` delas veio do UPDATE em massa de 16/08.
    //
    // Medido em 22/09/2026: das 1.496 PCs `encerrado`, **1.405 não têm técnico** — 788 parciais
    // em 234 TRs. Nas `com_analista` são 308 de 332.
    //
    // ⚠️ É A MESMA MENTIRA QUE O ANEL DO DASHBOARD CORRIGIU EM 02/09: o rótulo "C.I. de acordo"
    // afirmava um acordo que 1.577 PCs nunca receberam. A dedução continua (é decisão do
    // Richard, 14/09 — a parcial precisa seguir para o arquivamento), mas agora ela vem
    // ETIQUETADA, e quem lê sabe de onde veio.
    ci_opcao_deduzida: !r.ci_opcao && !!(r.ci_situacao === 'encerrado'
      || (r.ci_situacao === 'com_analista' && r.ci_ultimo_evento !== 'ci_reabriu')),
    ci_complemento: r.ci_opcao ? ciLib.complementoDe(r.ci_opcao, r.ci_opcao_texto) : null,
  };
  if (r.arquivada) return { ...base, estado: 'arquivada', motivo: null };
  if (r.tem_final && !r.so_final)
    return { ...base, estado: 'bloqueada', motivo: `A parcial ${r.n} mistura PC final e parciais — corrija o nº da parcial da final.` };
  const b = bloqueioDeFatos(r, r.ci_ultimo_evento || null);
  if (b) return { ...base, estado: 'bloqueada', motivo: b };
  if (r.tem_final && base.pendentes.length) return { ...base, estado: 'bloqueada', motivo: textoPendentes(base.pendentes) };
  return { ...base, estado: 'pronta', motivo: null };
}

/** Está no caminho do arquivamento? O C.I. já devolveu, ou já foi arquivada. */
const noCaminho = (r) => !!r.arquivada || ['encerrado', 'com_analista'].includes(r.ci_situacao);

/**
 * (a) GET /parcela/acoes — os blocos `arquivar` e `desarquivar` de UMA parcial, para `quem`.
 * Devolve null se a parcial não existir.
 */
async function estadoParcela(db, { quem, setorial_id, tr, parcial_num }) {
  const setorial = setorial_id || 'FCEE';
  const num = String(parcial_num);
  const { rows } = await db.query(`${sqlEstado('q.tr = $1')} WHERE ap.s = $2 AND ap.n = $3`, [tr, setorial, num]);
  if (!rows.length) return null;
  const e = estadoDaLinha(rows[0]);
  const perfil = papel.perfilEfetivo(quem);
  const { rows: pcs } = await db.query(
    `SELECT codigo_pc, analista_id FROM prestacoes_contas
      WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3 AND ${inval.ativa('')} ORDER BY codigo_pc`, [setorial, tr, num]);
  const perm = podeArquivar(quem, perfil, pcs);
  const arquivar = { ...e,
    pode: e.estado === 'pronta' && perm.pode,
    motivo: e.estado === 'arquivada' ? 'A parcial já está arquivada.'
      : e.estado === 'bloqueada' ? e.motivo
      : (perm.pode ? null : perm.motivo) };
  const pd = podeDesarquivar(quem, perfil);
  const desarquivar = e.estado !== 'arquivada'
    ? { pode: false, motivo: 'A parcial não está arquivada.' }
    : { pode: pd.pode, motivo: pd.pode ? null : pd.motivo,
        arquivada_em: e.arquivada_em, arquivada_por: e.arquivada_por };
  return { arquivar, desarquivar };
}

/**
 * (b) GET /prestacoes_contas?arquivamento=1 — pendura `arquivamento` em cada PC, pelo estado da
 * parcial dela. Uma consulta a mais, recortada nas TRs das linhas. PC fora do caminho do
 * arquivamento (o C.I. ainda não devolveu) recebe null.
 */
async function anexarEstado(db, rows) {
  const trs = [...new Set((rows || []).map((r) => r.tr).filter(Boolean))];
  if (!trs.length) return rows;
  const { rows: est } = await db.query(sqlEstado('q.tr = ANY($1)'), [trs]);
  const mapa = new Map();
  for (const r of est) {
    if (!noCaminho(r)) continue;
    const e = estadoDaLinha(r);
    mapa.set(`${r.s}|${r.t}|${r.n}`, {
      estado: e.estado, motivo: e.motivo, final: e.final, n_pcs: e.n_pcs,
      ci_devolveu_em: e.ci_devolveu_em, ci_devolveu_carga: e.ci_devolveu_carga,
      tr_arquivada: e.tr_arquivada, parciais_total: e.parciais_total,
      parciais_arquivadas: e.parciais_arquivadas, pendentes: e.pendentes,
      // ⚠️ A MARCA VIAJA JUNTO DA OPÇÃO, e não separada: é ela que diz se a frase do cartão
      // pode afirmar "o C.I. está de acordo" ou se a opção foi deduzida de uma parcial que
      // ninguém decidiu. Mandar a opção sem a marca é o que fazia a tela afirmar demais.
      ci_opcao: e.ci_opcao, ci_opcao_deduzida: e.ci_opcao_deduzida,
      ci_complemento: e.ci_complemento,
    });
  }
  for (const r of rows) r.arquivamento = mapa.get(`${r.setorial_id}|${r.tr}|${r.parcial_num}`) || null;
  return rows;
}

/**
 * (c) GET /arquivamento — a lista por parcial e as três contagens.
 * O analista vê as dele; o coordenador, o grupo dele; o superadmin, tudo (e filtra se quiser).
 * ⚠️ PERFIL EFETIVO: no papel analista, o superadmin vê só as dele.
 */
async function listar(db, { quem, analista_id, grupo }) {
  const perfil = papel.perfilEfetivo(quem);
  if (!quem) return falha(401, 'Usuário não identificado.');
  const alvoAnalista = analista_id != null && analista_id !== '' ? parseInt(analista_id, 10) : null;
  const alvoGrupo = grupo != null && grupo !== '' ? String(grupo) : null;
  let escopo;
  if (perfil === 'superadmin') {
    escopo = { analista_id: alvoAnalista, grupo: alvoAnalista ? null : alvoGrupo };
  } else if (perfil === 'coordenador') {
    if (!quem.grupo) return falha(403, 'Coordenador sem grupo cadastrado.');
    if (alvoGrupo && alvoGrupo !== String(quem.grupo)) return falha(403, 'O coordenador vê só o próprio grupo.');
    if (alvoAnalista) {
      const { rows: [u] } = await db.query(`SELECT grupo FROM usuarios WHERE id = $1`, [alvoAnalista]);
      if (!u || String(u.grupo) !== String(quem.grupo)) return falha(403, 'Este analista não é do seu grupo.');
    }
    escopo = { analista_id: alvoAnalista, grupo: alvoAnalista ? null : String(quem.grupo) };
  } else if (perfil === 'analista') {
    if (alvoAnalista && alvoAnalista !== quem.id) return falha(403, 'O analista vê só o próprio arquivamento.');
    escopo = { analista_id: quem.id, grupo: null };
  } else {
    return falha(403, 'Só analista, coordenador e superadmin veem o arquivamento.');
  }

  const vals = [];
  let filtro = 'true';
  if (escopo.analista_id) {
    vals.push(escopo.analista_id);
    filtro = `q.tr IN (SELECT tr FROM prestacoes_contas WHERE analista_id = $1)`;
  } else if (escopo.grupo) {
    vals.push(escopo.grupo);
    filtro = `q.tr IN (SELECT pp.tr FROM prestacoes_contas pp JOIN usuarios uu ON uu.id = pp.analista_id
                        WHERE uu.grupo::text = $1::text)`;
  }
  const { rows } = await db.query(
    `${sqlEstado(filtro)}
      WHERE (ap.arquivada OR ap.ci_situacao IN ('encerrado', 'com_analista'))`, vals);
  const ids = [...new Set(rows.map((r) => r.analista_id).filter((x) => x != null))];
  const { rows: us } = ids.length
    ? await db.query(`SELECT id, nome, grupo FROM usuarios WHERE id = ANY($1)`, [ids]) : { rows: [] };
  const uMap = new Map(us.map((u) => [u.id, u]));

  const linhas = [];
  for (const r of rows) {
    // O dono de referência da parcial é o menor analista_id dela; o recorte olha para ele.
    if (escopo.analista_id && !(r.donos || []).includes(escopo.analista_id)) continue;
    const u = uMap.get(r.analista_id) || null;
    if (escopo.grupo && (!u || String(u.grupo) !== escopo.grupo)) continue;
    const e = estadoDaLinha(r);
    linhas.push({ analista_id: r.analista_id ?? null, analista_nome: u ? u.nome : null, grupo: u ? u.grupo : null,
      ...e });
  }
  linhas.sort((a, b) => String(a.analista_nome || '').localeCompare(String(b.analista_nome || ''))
    || a.tr.localeCompare(b.tr) || (a.final - b.final) || numParcial(a.parcial_num) - numParcial(b.parcial_num));

  const trsEncerradas = new Set(linhas.filter((l) => l.final && l.estado === 'arquivada').map((l) => l.tr));
  const contagens = {
    prontas: linhas.filter((l) => l.estado === 'pronta').length,
    parciais_arquivadas: linhas.filter((l) => !l.final && l.estado === 'arquivada').length,
    trs_encerradas: trsEncerradas.size,
    bloqueadas: linhas.filter((l) => l.estado === 'bloqueada').length,
    total: linhas.length,
  };
  return { status: 200, data: { escopo: { perfil, ...escopo }, contagens, linhas } };
}

module.exports = {
  EVENTO_ARQUIVAR, EVENTO_DESARQUIVAR, PERFIS_SUPERVISAO, ORIGEM_SECRETARIO,
  MOTIVO_MIN, MOTIVO_MAX, OBS_MAX,
  podeArquivar, podeDesarquivar, fatosDe, bloqueioDeFatos, bloqueio, textoPendentes,
  validarDataSecretario, validarMotivo, validarObs,
  arquivar, desarquivar,
  cteEstado, sqlEstado, estadoDaLinha, estadoParcela, anexarEstado, listar,
  SQL_PARCELA, SQL_ARQUIVAR, SQL_ARQUIVAR_FINAL, SQL_DESARQUIVAR, SQL_DESARQUIVAR_FINAL,
};
