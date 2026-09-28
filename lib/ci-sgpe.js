// CAMINHO: sigpc-api/lib/ci-sgpe.js
//
// A DEVOLUTIVA DO C.I. PROVADA PELA TRAMITAÇÃO DO SGPe — decisão do Richard, 28/09/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
// ─────────────────────────────────────────────────────────────────────────────
//
// A analista Clara mandou o caso: a parcial 1 da `2020TR000764` está baixada e com parecer, o
// processo `SCC 12315/2020` **já foi ao Controle Interno e já voltou no SGPe** — entrou no
// FCEE/CONIN em 01/12/2025, saiu em 02/12/2025 —, e no sistema ela continuava no passo 2,
// esperando um encaminhamento que só serviria para o C.I. registrar de novo o que fez há dez
// meses. Do Richard: *"eles têm muita demanda, e mandar só para fazer esse trâmite é muito
// ruim"*.
//
// Medido em 28/09 nos 1.347 processos envolvidos: **562 parcelas** têm a passagem provada no
// SGPe (292 no passo 2 e 270 já na fila), **721** estão com o processo no CONIN AGORA — e essas
// continuam sendo trabalho do C.I. —, e 93 nunca passaram por lá.
//
// ⚠️ A PROVA É A TRAMITAÇÃO, E NÃO A PALAVRA DE NINGUÉM. Este caminho não é uma declaração do
// analista: quem responde é o que o portal do SGPe registrou, com data de entrada e de saída.
// É a diferença entre "ela disse que voltou" e "o SGPe mostra quando voltou".
//
// ⚠️ E ELE NÃO AFIRMA O TEOR DO PARECER. A tramitação prova a PASSAGEM, não a decisão: não se
// grava `ci_opcao`, não se diz "o C.I. está de acordo". O que se registra é que o processo foi
// e voltou, com as datas — e a tela precisa dizer isso com todas as letras. Afirmar um acordo
// que ninguém deu é exatamente o defeito que o anel do Dashboard corrigiu em 02/09 e a etiqueta
// da opção deduzida em 22/09.
//
// ⚠️ AS TRÊS CONDIÇÕES SÃO CUMULATIVAS, e a terceira é a que protege o C.I.: se o processo
// estiver no CONIN AGORA, ele está com eles, e registrar a volta seria mentira. A trava do
// arquivamento (23/09) já diz isso do outro lado.
// ─────────────────────────────────────────────────────────────────────────────

const sgpeSit = require('./sgpe-situacao');

/** Quem pode registrar por este caminho: o dono da TR, o coordenador do grupo, e o superadmin. */
const PERFIS_SUPERVISAO = ['superadmin', 'coordenador'];

const MOTIVOS = {
  SEM_PROCESSO: 'Esta parcial não tem processo do SGPe registrado.',
  SEM_LEITURA: 'O sistema ainda não leu a tramitação deste processo no SGPe.',
  NUNCA_FOI: 'A tramitação do SGPe não mostra passagem pelo Controle Interno.',
  AINDA_LA: 'O processo está no Controle Interno AGORA — a devolutiva ainda não aconteceu.',
  SEM_SAIDA: 'O SGPe registra a entrada no Controle Interno, mas não a saída.',
  JA_DEVOLVIDA: 'O Controle Interno já devolveu esta parcial no sistema.',
  NAO_BAIXADA: 'A parcial ainda tem PC sem baixa.',
  SEM_PARECER: 'A parcial ainda tem PC sem parecer registrado.',
  ARQUIVADA: 'A parcial já está arquivada.',
};

/**
 * O que a tramitação prova. PURA — recebe as linhas já lidas.
 *
 * @param tramitacoes  linhas de `sgpe_tramitacao` (ordem livre), com setor_sigla, dt_recebto e dt_encaminha
 * @param setorAtual   a sigla do setor onde o processo está agora (de `sgpe_situacao`)
 * @returns {{prova: boolean, entrada: string|null, saida: string|null, motivo: string|null}}
 */
function analisarTramitacao(tramitacoes, setorAtual) {
  const linhas = Array.isArray(tramitacoes) ? tramitacoes : [];
  if (!linhas.length) return { prova: false, entrada: null, saida: null, motivo: MOTIVOS.SEM_LEITURA };

  // ⚠️ O SETOR DO C.I. VEM DA `lib/sgpe-situacao`, aqui também: é a mesma pergunta que a trava
  // do arquivamento faz, e duas respostas divergiriam no dia em que houvesse um segundo setor.
  const noCi = linhas.filter((t) => sgpeSit.ehSetorCI(t.setor_sigla));
  if (!noCi.length) return { prova: false, entrada: null, saida: null, motivo: MOTIVOS.NUNCA_FOI };

  // ⚠️ ESTAR NO C.I. AGORA MANDA MAIS QUE QUALQUER PASSAGEM ANTIGA. Um processo pode ter ido ao
  // C.I., voltado, e ido de novo — e é a ida de agora que vale.
  if (sgpeSit.ehSetorCI(setorAtual)) {
    const ultima = noCi[noCi.length - 1] || {};
    return { prova: false, entrada: ultima.dt_recebto || null, saida: null, motivo: MOTIVOS.AINDA_LA };
  }

  // A passagem que interessa é a MAIS RECENTE com saída registrada.
  const comSaida = noCi.filter((t) => t.dt_encaminha)
    .sort((a, b) => String(a.dt_encaminha).localeCompare(String(b.dt_encaminha)));
  if (!comSaida.length) {
    const ultima = noCi[noCi.length - 1] || {};
    return { prova: false, entrada: ultima.dt_recebto || null, saida: null, motivo: MOTIVOS.SEM_SAIDA };
  }
  const p = comSaida[comSaida.length - 1];
  return {
    prova: true,
    entrada: p.dt_recebto ? String(p.dt_recebto).slice(0, 10) : null,
    saida: String(p.dt_encaminha).slice(0, 10),
    motivo: null,
  };
}

/**
 * O estado da parcela permite registrar por este caminho?
 *
 * ⚠️ A PARCELA NA FILA DO C.I. ENTRA, e isso é decisão do Richard: são 270 parcelas cujo
 * processo o C.I. já devolveu no SGPe sem registrar aqui — deixá-las de fora manteria na mesa
 * deles justamente o que o levantamento mostrou que já saiu.
 */
function estadoPermite(pcs) {
  const lista = Array.isArray(pcs) ? pcs : [];
  if (!lista.length) return MOTIVOS.SEM_PROCESSO;
  if (lista.some((p) => p.arquivada === true)) return MOTIVOS.ARQUIVADA;
  if (lista.some((p) => p.baixada !== true)) return MOTIVOS.NAO_BAIXADA;
  if (lista.some((p) => !p.parecer_tipo)) return MOTIVOS.SEM_PARECER;
  // Já devolvida no sistema: não há o que registrar.
  if (lista.some((p) => p.ci_situacao === 'encerrado' || p.ci_situacao === 'com_analista'))
    return MOTIVOS.JA_DEVOLVIDA;
  return null;
}

/** Quem clicou pode? O dono da TR, o coordenador do grupo dela, ou o superadmin. */
function podeRegistrar(quem, perfil, pcs) {
  if (!quem) return { pode: false, status: 401, motivo: 'Usuário não identificado.' };
  if (PERFIS_SUPERVISAO.includes(perfil)) return { pode: true };
  const donos = [...new Set((pcs || []).map((p) => p.analista_id).filter((x) => x != null).map(String))];
  if (donos.length && donos.every((d) => d === String(quem.id))) return { pode: true };
  return { pode: false, status: 403,
    motivo: 'Só o analista responsável, o coordenador do grupo ou o superadmin registram a devolutiva pelo SGPe.' };
}

// A tramitação de um processo, pela chave normalizada — a mesma do rodízio.
const SQL_TRAMITACAO = `
  SELECT setor_sigla, dt_recebto::text AS dt_recebto, dt_encaminha::text AS dt_encaminha, ordem
    FROM sgpe_tramitacao
   WHERE sigla = $1 AND numero_oficial = $2 AND ano = $3
   ORDER BY ordem`;

const SQL_SITUACAO = `
  SELECT setor_sigla, setor_nome, checado_em FROM sgpe_situacao
   WHERE sigla = $1 AND numero_oficial = $2 AND ano = $3`;

// ⚠️ NÃO GRAVA `ci_opcao`, `ci_tecnico_id` NEM `parecer_ci`: a tramitação prova a passagem, não
// a decisão. E `dt_envio_ci` e `ci_encerrado_em` levam as DATAS DO SGPe, não NOW() — o fato
// aconteceu naquele dia, e datar de hoje inventaria um evento que não houve.
const SQL_REGISTRAR = `
  UPDATE prestacoes_contas
     SET enviado_ci = true,
         dt_envio_ci = COALESCE(dt_envio_ci, $4::date),
         enviado_ci_por = $5,
         ci_situacao = 'encerrado',
         ci_encerrado_em = $6::date,
         ci_rodada = GREATEST(ci_rodada, 1),
         atualizado_em = NOW()
   WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3 AND baixada = true
   RETURNING codigo_pc`;

module.exports = {
  MOTIVOS, PERFIS_SUPERVISAO,
  analisarTramitacao, estadoPermite, podeRegistrar,
  SQL_TRAMITACAO, SQL_SITUACAO, SQL_REGISTRAR,
};
