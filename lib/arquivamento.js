// CAMINHO: sigpc-api/lib/arquivamento.js
//
// ARQUIVAMENTO — fase 2, as regras. Especificação do Richard, 13/09/2026.
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
// O QUE É "O C.I. DEVOLVEU SEM PEDIR DILIGÊNCIA" — decisão do Richard, 13/09/2026
//
// O sistema não guarda "o C.I. pediu diligência": o C.I. decide `de_acordo` (a parcial fica
// 'encerrado') ou `ressalva` (volta 'com_analista'). Ficou decidido:
//   · LIBERAM: 'encerrado', com ou sem decisão do C.I. registrada (as declaradas da carga de
//     16/08 entram), e a RESSALVA ('com_analista' cujo último evento do C.I. é `ci_decidiu`);
//   · BLOQUEIAM: a REABERTA ('com_analista' cujo último evento do C.I. é `ci_reabriu` — o
//     processo voltou pelo SGPe e espera o analista), a que está NA FILA, e a que nunca foi.
//
// ⚠️ RESSALVA E REABERTA ESTÃO AS DUAS EM 'com_analista'. Quem as separa é o ÚLTIMO evento do
// C.I. na parcela, e não a existência de uma reabertura antiga: uma parcela reaberta, respondida
// e depois devolvida com ressalva está numa ressalva, não numa reabertura.
//
// ⚠️ AS FUNÇÕES RECEBEM UM CLIENTE JÁ DENTRO DE UMA TRANSAÇÃO, E NÃO FAZEM BEGIN NEM COMMIT.
// Quem faz é a rota. É o que permite testá-las contra o banco real dentro de BEGIN/ROLLBACK —
// uma função que gerencia a própria transação confirmaria o teste (armadilha 10).
//
// ⚠️ TRÊS ESCOLHAS CONFERIDAS PELO RICHARD EM 13/09/2026: `executado_por` é gravado SEMPRE
// (como na engenharia, e não nulo quando o dono executa); o coordenador arquiva e desarquiva de
// qualquer grupo (como na invalidação); e a final gravada com o nº de uma parcial (há 5 com
// parcial_num '1') é recusada até o dado ser corrigido.
// ─────────────────────────────────────────────────────────────────────────────

const inval = require('./invalidada');
const papel = require('./papel');

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

// O último evento do C.I. na parcela — é ele que separa ressalva de reabertura.
const SQL_ULTIMO_EVENTO_CI = `
  SELECT evento, valor_novo FROM parcela_historico
   WHERE setorial_id IS NOT DISTINCT FROM $1 AND tr = $2 AND parcial_num IS NOT DISTINCT FROM $3
     AND evento IN ('ci_decidiu', 'ci_reabriu')
   ORDER BY criado_em DESC, id DESC
   LIMIT 1`;

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
 * O que impede a parcial de arquivar, dito do jeito que a pessoa precisa ler. null = nada.
 * `ultimoCi` é a linha de SQL_ULTIMO_EVENTO_CI (ou null).
 */
function bloqueio(pcs, ultimoCi) {
  const dilig = pcs.filter((p) => p.status === 'diligencia' || p.situacao_atual === 'Diligência');
  if (dilig.length) return `Há diligência aberta nesta parcial (${lista(dilig)}). Conclua a diligência antes de arquivar.`;
  const naoBaixadas = pcs.filter((p) => p.baixada !== true);
  if (naoBaixadas.length) return `Falta baixar ${naoBaixadas.length} PC${naoBaixadas.length > 1 ? 's' : ''} desta parcial `
    + `(${lista(naoBaixadas)}). A parcial só arquiva com todas as PCs baixadas.`;
  const semCi = pcs.filter((p) => p.enviado_ci !== true || !p.ci_situacao);
  if (semCi.length) return `A parcial ainda não foi encaminhada ao Controle Interno (${lista(semCi)}). `
    + 'Ela só arquiva depois que o C.I. devolver.';
  const naFila = pcs.filter((p) => p.ci_situacao === 'na_fila');
  if (naFila.length) return 'A parcial está na fila do Controle Interno — o C.I. ainda não devolveu. '
    + 'Ela só arquiva depois da devolutiva.';
  const comAnalista = pcs.some((p) => p.ci_situacao === 'com_analista');
  if (comAnalista && ultimoCi && ultimoCi.evento === 'ci_reabriu') return 'O Controle Interno reabriu esta parcial: '
    + 'o processo voltou pelo SGPe e aguarda a sua resposta. Responda ao C.I. antes de arquivar.';
  const fora = pcs.filter((p) => !['encerrado', 'com_analista'].includes(p.ci_situacao));
  if (fora.length) return `Situação no C.I. não permite arquivar (${fora.map((p) => `${p.codigo_pc}: ${p.ci_situacao}`).join(', ')}).`;
  return null;
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

/** O estado atual, para a resposta — inclusive a idempotente. */
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

  const { rows: [ultimoCi] } = await cli.query(SQL_ULTIMO_EVENTO_CI, [setorial, tr, num]);
  const b = bloqueio(pcs, ultimoCi || null);
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

module.exports = {
  EVENTO_ARQUIVAR, EVENTO_DESARQUIVAR, PERFIS_SUPERVISAO, ORIGEM_SECRETARIO,
  MOTIVO_MIN, MOTIVO_MAX, OBS_MAX,
  podeArquivar, podeDesarquivar, bloqueio, validarDataSecretario, validarMotivo, validarObs,
  arquivar, desarquivar,
  SQL_PARCELA, SQL_ARQUIVAR, SQL_ARQUIVAR_FINAL, SQL_DESARQUIVAR, SQL_DESARQUIVAR_FINAL,
};
