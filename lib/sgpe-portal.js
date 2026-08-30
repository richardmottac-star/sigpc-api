// CAMINHO: sigpc-api/lib/sgpe-portal.js
//
// CONSULTA AO PORTAL PÚBLICO DO SGPe — situação do processo e fila de tramitações.
// Especificação do Richard, 30/08/2026. FASE 1: só o cliente. Sem tela, sem rota, sem banco.
//
// ─────────────────────────────────────────────────────────────────────────────
// O ENDPOINT
//
//   POST https://portal.sgpe.sea.sc.gov.br/adm/portal-servicos-backend/v1/solicitacao/consultar
//   { cdOrgaoSetor, nuAno, nuProcessoOficial }
//
// É PÚBLICO e não pede autenticação — verificado ao vivo em 30/08. É outro endpoint e outro
// host do que o `lib/sgpe-dwr.js` usa (`sgpe.sea.sc.gov.br/cpav/dwr/exec`), e responde outra
// coisa: o DWR devolve o `nuProcesso` interno para montar a URL; este devolve o CONTEÚDO.
//
// ⚠️ `nuProcessoOficial` VAI COM `padStart(5, '0')`. É o número oficial, com zeros à esquerda.
// ⚠️ `cdOrgaoSetor` É O CÓDIGO NUMÉRICO, nunca a sigla — sai do mapa `ORGAOS` de
//    `lib/sgpe-link.js`, que é o único dono dessa tradução.
//
// ⚠️ NADA AQUI DUPLICA A NORMALIZAÇÃO. Sigla, número e ano passam por `normalizarPartes` e
// `orgaoDaSigla` da `sgpe-link.js` — inclusive a trava da sigla colada ("ADR223151/2017", que
// pode ser ADR22 nº 3151 ou ADR2 nº 23151, e por isso é recusada em vez de chutada).
// ─────────────────────────────────────────────────────────────────────────────

const link = require('./sgpe-link');

const ENDPOINT = 'https://portal.sgpe.sea.sc.gov.br'
  + '/adm/portal-servicos-backend/v1/solicitacao/consultar';

const TIMEOUT_MS = 15000;

// Os quatro desfechos. São códigos, não frases: a frase é da tela, e um código estável é o que
// permite a tela mudar de texto sem mexer aqui.
const ERROS = {
  SIGLA_NAO_CADASTRADA: 'SIGLA_NAO_CADASTRADA',
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
  SIGILOSO: 'SIGILOSO',
  ENTRADA_INVALIDA: 'ENTRADA_INVALIDA',
  REDE: 'REDE',
};

// ⚠️ ONDE_ESTA x EM_TRANSITO — a diferença é o `dtRecebto` do ÚLTIMO trâmite, e só ela.
const SITUACAO = { ONDE_ESTA: 'ONDE_ESTA', EM_TRANSITO: 'EM_TRANSITO' };

// ─────────────────────────────────────────────────────────────────────────────
// DATAS
//
// ⚠️ AS DATAS DO PORTAL VÊM COMO TEXTO `AAAA-MM-DD`, e é assim que ficam. Passá-las por
// `new Date(...)` sem fuso as puxaria para o dia anterior a leste de Greenwich — é a
// armadilha 18 do projeto, e a 25 (o `pg` devolvendo `Date` e o `slice` virando "Thu Mar 31").
// Aqui a conta é feita em UTC puro sobre a meia-noite de cada dia: a diferença entre duas
// datas civis não tem hora, e introduzir uma só cria erro de borda.
// ─────────────────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `AAAA-MM-DD` -> milissegundos da meia-noite UTC. `null` para qualquer outra coisa. */
function diaUtc(iso) {
  const s = String(iso == null ? '' : iso).slice(0, 10);
  if (!ISO.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) ? null : t;
}

/**
 * Hoje, em data civil brasileira.
 *
 * ⚠️ NÃO É `new Date().toISOString()`. Às 21h de Brasília o UTC já virou o dia seguinte, e
 * "há N dias" ficaria um dia maior a noite inteira — o mesmo motivo do `HOJE_BR` em
 * `lib/datas.js`, que resolve isso do lado do Postgres. Aqui é do lado do Node.
 */
function hojeBr(agora) {
  const d = agora || new Date();
  // `en-CA` formata como AAAA-MM-DD, que é exatamente o que o portal usa.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

/** Dias inteiros entre duas datas civis. `null` se qualquer uma não for data. */
function diasEntre(de, ate) {
  const a = diaUtc(de); const b = diaUtc(ate);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

// ─────────────────────────────────────────────────────────────────────────────
// O CORPO DO PEDIDO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monta o corpo a partir de sigla/número/ano. Devolve `{ erro }` em vez de lançar — quem
 * chama trata os quatro desfechos do mesmo jeito.
 */
function montarCorpo(sigla, numero, ano) {
  const p = link.normalizarPartes(sigla, numero, ano);
  // O texto não forma processo (ou caiu na trava da sigla colada).
  if (!p) return { erro: ERROS.ENTRADA_INVALIDA, sigla: sigla == null ? null : String(sigla) };

  // ⚠️ A SIGLA FORA DO MAPA PARA AQUI, E NÃO VAI À REDE. É a regra central desta lib: o portal
  // NÃO distingue "esse órgão não existe" de "esse processo não existe" — as duas coisas
  // voltam como `mensagemErro: "Não foi possível encontrar o Processo."`. Se deixássemos a
  // sigla desconhecida chegar lá, o sistema diria ao analista que o processo não existe
  // quando o que falta é a sigla no NOSSO mapa. Essa distinção é nossa, e é aqui que ela mora.
  if (!link.siglaConhecida(p.sigla)) return { erro: ERROS.SIGLA_NAO_CADASTRADA, sigla: p.sigla };

  return {
    partes: p,
    corpo: {
      cdOrgaoSetor: link.orgaoDaSigla(p.sigla),
      nuAno: p.ano,
      // ⚠️ `padStart(5,'0')` — é o número OFICIAL, com zeros. Sem eles o portal não acha.
      nuProcessoOficial: String(p.numero).padStart(5, '0'),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A LEITURA DA RESPOSTA — pura, sem rede. É por aqui que se testa sem depender do portal.
// ─────────────────────────────────────────────────────────────────────────────

/** Um trâmite, com o tempo que o processo ficou parado naquele setor. */
function lerTramite(t, i) {
  const recebido = !!diaUtc(t.dtRecebto);
  const encaminhado = !!diaUtc(t.dtEncaminha);
  return {
    ordem: t.nuTramite == null ? i + 1 : t.nuTramite,
    setor_sigla: t.sgOrgaotrami || null,
    setor_nome: t.nmOrgaotrami || null,
    cd_orgao: t.cdOrgaotrami == null ? null : t.cdOrgaotrami,
    dt_recebto: t.dtRecebto || null,
    dt_encaminha: t.dtEncaminha || null,
    recebido,
    encaminhado,
    // ⚠️ PERMANÊNCIA = ENTRE RECEBER E ENCAMINHAR, e só existe quando as duas datas existem.
    // No trâmite ainda aberto ela é `null`, e NÃO zero: zero diria "passou no mesmo dia", que
    // é uma afirmação diferente de "ainda não saiu".
    permanencia_dias: recebido && encaminhado ? diasEntre(t.dtRecebto, t.dtEncaminha) : null,
    parecer: t.deParecer || null,
    quem_recebeu: t.nmUsuarioreceb || null,
    quem_encaminhou: t.nmUsuarioencaminha || null,
  };
}

/**
 * Onde o processo está AGORA, pelo último trâmite.
 *
 * ⚠️ NUNCA PELO CAMPO `setorAtual`. Ele vem defasado: medido em 30/08 no SCC 2146/2020, o
 * `setorAtual` diz "SCC/NCRI", **idêntico ao `setorAbertura`**, enquanto o último trâmite está
 * em FCEE/GEAFC/GEESP — e o próprio `orgaoAtual` do portal já diz FCEE. O campo é mantido no
 * retorno como `setorAtual_CRU` só para conferência; não é para ser exibido.
 */
function ondeEsta(tramites, hoje) {
  if (!tramites.length) return null;
  const ult = tramites[tramites.length - 1];

  if (ult.recebido) {
    return {
      situacao: SITUACAO.ONDE_ESTA,
      setor_sigla: ult.setor_sigla,
      setor_nome: ult.setor_nome,
      desde: ult.dt_recebto,
      dias: diasEntre(ult.dt_recebto, hoje),
      ordem: ult.ordem,
    };
  }

  // ⚠️ EM TRÂNSITO: foi encaminhado e ninguém recebeu. A conta é desde o ENCAMINHAMENTO
  // ANTERIOR — o trâmite de agora não tem data nenhuma, e é justamente isso que o define.
  // Sem o anterior não há de onde contar, e `dias` fica `null` em vez de 0.
  const ant = tramites.length > 1 ? tramites[tramites.length - 2] : null;
  const partida = ant ? (ant.dt_encaminha || ant.dt_recebto) : null;
  return {
    situacao: SITUACAO.EM_TRANSITO,
    setor_sigla: ult.setor_sigla,
    setor_nome: ult.setor_nome,
    desde: partida,
    dias: partida ? diasEntre(partida, hoje) : null,
    ordem: ult.ordem,
  };
}

/**
 * Interpreta o JSON do portal. Devolve um dos quatro desfechos.
 *
 * ⚠️ O PORTAL RESPONDE **HTTP 200 EM TODOS OS CASOS**, inclusive quando não acha. Quem
 * distingue é o corpo:
 *   · `mensagemErro` preenchida  -> NÃO ENCONTRADO
 *   · tudo nulo e SEM mensagem   -> SIGILOSO
 *
 * ⚠️ E POR QUE "TUDO NULO SEM MENSAGEM" É SIGILOSO, e não "não achou": o portal só chega a
 * responder depois de casar `cdOrgaoSetor` + ano + número. **Responder já prova que o órgão
 * existe e que o processo foi localizado** — o que falta é o conteúdo, e o que esconde
 * conteúdo é o sigilo. Tratar isso como NÃO ENCONTRADO mandaria o analista procurar um
 * processo que existe.
 */
function interpretar(json, partes, agora) {
  if (!json || typeof json !== 'object') return { erro: ERROS.NAO_ENCONTRADO };
  if (json.mensagemErro) return { erro: ERROS.NAO_ENCONTRADO, motivo: String(json.mensagemErro) };

  const bruto = Array.isArray(json.tramitacoes) ? json.tramitacoes : [];
  const semNada = json.numero == null && json.situacao == null && json.estado == null;
  if (semNada) return { erro: ERROS.SIGILOSO, sigla: partes.sigla, numero: partes.numero, ano: partes.ano };

  const hoje = hojeBr(agora);
  const tramitacoes = bruto.map(lerTramite);
  const atual = ondeEsta(tramitacoes, hoje);

  return {
    ok: true,
    consultado_em: hoje,
    processo: {
      sigla: partes.sigla,
      numero: partes.numero,
      ano: partes.ano,
      numero_oficial: json.numero || null,
      cd_orgao_setor: json.cdOrgaoSetor == null ? null : json.cdOrgaoSetor,
      tipo: json.tipo || null,
      titulo: json.titulo || null,
      classe: json.classe || null,
      assunto: json.nmAssunto || null,
      detalhamento: json.detalhamentoSigiloso ? null : (json.detalhamentoComplemento || null),
      situacao_portal: json.situacao || null,   // ARQUIVADO, EM ANDAMENTO…
      estado_portal: json.estado || null,       // Finalizada, Em tramitação…
      dt_entrada: json.dtEntrada || null,
      orgao_abertura: json.orgaoAbertura || null,
      setor_abertura: json.setorAbertura || null,
      orgao_atual: json.orgaoAtual || null,
      interessados: Array.isArray(json.interessados) ? json.interessados : [],
      sigiloso: {
        detalhamento: !!json.detalhamentoSigiloso,
        interessado: !!json.interessadoSigiloso,
        parecer: !!json.parecerSigiloso,
        documento: !!json.documentoSigiloso,
      },
    },
    // ⚠️ NÃO USAR ESTE CAMPO PARA DIZER ONDE O PROCESSO ESTÁ. Ele vem defasado e, nos casos
    // medidos, repete o `setorAbertura`. Está aqui só para conferência — quem responde
    // "onde está" é `atual`, que sai do ÚLTIMO TRÂMITE.
    setorAtual_CRU: json.setorAtual || null,
    atual,
    tramitacoes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A CONSULTA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consulta um processo no portal público.
 *
 * @param sigla   'SCC'
 * @param numero  2146  (ou '00002146' — a normalização tira os zeros e o padStart recoloca)
 * @param ano     2020
 * @param opc     { fetchImpl, timeoutMs, agora } — os três só para teste
 */
async function consultar(sigla, numero, ano, opc) {
  const o = opc || {};
  const m = montarCorpo(sigla, numero, ano);
  if (m.erro) return m;

  const buscar = o.fetchImpl || fetch;
  // ⚠️ TIMEOUT SEMPRE. O portal é sistema de terceiro; sem isto uma consulta pendurada
  // seguraria a requisição do analista até o proxy desistir.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs || TIMEOUT_MS);
  try {
    const r = await buscar(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(m.corpo),
      signal: ac.signal,
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (_) { json = null; }
    // ⚠️ HTTP != 200 é REDE, não "não encontrado": o portal responde 200 mesmo quando não
    // acha. Confundir os dois faria uma instabilidade dele virar "o processo não existe".
    if (!r.ok) return { erro: ERROS.REDE, http: r.status, motivo: texto.slice(0, 200) };
    if (json === null) return { erro: ERROS.REDE, http: r.status, motivo: 'resposta não é JSON' };
    return interpretar(json, m.partes, o.agora);
  } catch (e) {
    return { erro: ERROS.REDE, motivo: e.name === 'AbortError' ? 'tempo esgotado' : e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  ENDPOINT, TIMEOUT_MS, ERROS, SITUACAO,
  diaUtc, hojeBr, diasEntre,
  montarCorpo, lerTramite, ondeEsta, interpretar, consultar,
};
