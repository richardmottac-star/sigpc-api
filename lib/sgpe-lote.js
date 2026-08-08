// CAMINHO: sigpc-api/lib/sgpe-lote.js
//
// LOTE — traduz uma lista de valores CRUS do acervo em links prontos, lendo SÓ o cache
// (`sgpe_processo_ref`). Não consulta o SGPe: quem consulta é `job_sgpe_links.js`.
//
// É a peça única compartilhada pelas rotas e pelo job. Existe justamente para que a regra de
// normalização (a regex de `sgpe-link.js` mais a trava de ambiguidade) tenha UM dono — ver o
// aviso naquele arquivo sobre as cópias que precisam andar juntas.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A CHAVE DO MAPA É O VALOR CRU, exatamente como está no banco:
//
//   links["SCC2146/2020"]         -> "https://sgpe.sea.sc.gov.br/..."
//   links["ADR20 00001233/2017"]  -> "https://sgpe.sea.sc.gov.br/..."
//
// NÃO é a forma canônica ("SCC 2146/2020"). É de propósito: assim a tela faz
// `links[p.processo_pc]` direto e NÃO precisa da regex. Foi a divergência entre a regex do
// front e a do servidor que produziu o bug silencioso de 05-06/08 (ADR deixou de linkar sem
// nada dar erro). Chave crua = uma cópia da regra a menos, para sempre.
//
// O custo é o mapa carregar as variantes de escrita do mesmo processo — "SCC 2146/2020" e
// "SCC2146/2020" viram duas entradas apontando para a MESMA url. São 54 casos no acervo.
// ─────────────────────────────────────────────────────────────────────────────
//
// LINHA DE NEGATIVA: `nu_processo IS NULL` marca o processo que o SGPe respondeu não existir
// (`origem = 'NAO_ENCONTRADO'`). Ela existe para o job não reconsultar, nunca para virar link
// — daí o filtro em toda leitura. Sem esse filtro a URL sairia como `processoPK=null,null,ano`.

const {
  normalizarProcesso, formatarProcesso, siglaConhecida, montarUrlSgpe,
} = require('./sgpe-link');

/**
 * Valores crus -> Map<bruto, {sigla, numero, ano}>, jogando fora o que não é processo
 * (texto livre, sigla fora do mapa de órgãos, região colada ao número).
 * Preserva o valor cru como chave — é ele que o chamador conhece.
 */
function chavesDeValores(valores) {
  const porBruto = new Map();
  for (const bruto of valores) {
    if (bruto == null || porBruto.has(bruto)) continue;
    const p = normalizarProcesso(bruto);
    if (!p || !siglaConhecida(p.sigla)) continue;
    porBruto.set(bruto, p);
  }
  return porBruto;
}

/**
 * Consulta o cache e devolve `{ links, semLink }` com os links já montados.
 * `links` é indexado pelo valor CRU; `semLink` lista os crus que são processo válido mas
 * ainda não estão resolvidos (ou estão gravados como negativa).
 *
 * @param {{query: Function}} db  pool ou client do pg
 */
async function montarLinks(db, valores) {
  const porBruto = chavesDeValores(valores);
  if (porBruto.size === 0) return { links: {}, semLink: [] };

  // Dedupe por tripla antes de ir ao banco: 2.704 processos do acervo têm mais de uma PC, e
  // ainda pode haver duas grafias do mesmo processo na mesma resposta.
  const porCanonica = new Map();
  for (const p of porBruto.values()) porCanonica.set(formatarProcesso(p), p);
  const triplas = [...porCanonica.values()];

  // `unnest` de três arrays em vez de 3N placeholders — 2 mil processos virariam 6 mil parâmetros.
  const { rows } = await db.query(
    `SELECT sigla, numero_oficial, ano, nu_processo, cd_orgaosetor
       FROM sgpe_processo_ref
      WHERE nu_processo IS NOT NULL
        AND (sigla, numero_oficial, ano)
            IN (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]))`,
    [triplas.map(p => p.sigla), triplas.map(p => p.numero), triplas.map(p => p.ano)]
  );

  const urlPorCanonica = new Map();
  for (const c of rows) {
    // Segunda barreira contra a linha de negativa. O `WHERE` acima já a exclui, mas montar
    // `processoPK=null,null,ano` é o pior resultado possível — url que existe e não é erro.
    // Barato demais para depender de um lugar só.
    if (c.nu_processo == null || c.cd_orgaosetor == null) continue;
    urlPorCanonica.set(
      `${c.sigla} ${c.numero_oficial}/${c.ano}`,
      montarUrlSgpe(c.nu_processo, c.cd_orgaosetor, c.ano)
    );
  }

  const links = {};
  const semLink = [];
  for (const [bruto, p] of porBruto) {
    const url = urlPorCanonica.get(formatarProcesso(p));
    if (url) links[bruto] = url;
    else semLink.push(bruto);
  }
  return { links, semLink };
}

/**
 * Atalho para as rotas: colhe os campos de processo das linhas e devolve só o mapa.
 * Ex.: linksDeLinhas(pool, rows, ['processo_pc', 'processo_mae'])
 */
async function linksDeLinhas(db, linhas, campos) {
  const valores = [];
  for (const l of linhas) for (const c of campos) valores.push(l[c]);
  const { links } = await montarLinks(db, valores);
  return links;
}

// ── ESCRITA NO CACHE ────────────────────────────────────────────────────────
// Um lugar só para a forma do INSERT, usado pelo job e pela rota POST /sgpe/links.
//
// A precedência entre estados é a regra que importa:
//   CONFERIDO       (à mão)  — nada sobrescreve
//   SGPE            (ok)     — só CONFERIDO sobrescreve
//   NAO_ENCONTRADO  (o SGPe disse que não existe) — só um sucesso posterior sobrescreve
//   ERRO            (rede/transporte) — estado provisório, qualquer definitivo sobrescreve
//
// `tentativas` e `ultima_tentativa` sustentam o recuo do job: erro de rede volta para a fila
// depois de um tempo, negativa NÃO volta nunca.

async function gravarResolvido(db, p, r) {
  await db.query(
    `INSERT INTO sgpe_processo_ref
       (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, tentativas, ultima_tentativa, motivo)
     VALUES ($1, $2, $3, $4, $5, 'SGPE', 1, NOW(), NULL)
     ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
        SET nu_processo      = EXCLUDED.nu_processo,
            cd_orgaosetor    = EXCLUDED.cd_orgaosetor,
            origem           = 'SGPE',
            tentativas       = sgpe_processo_ref.tentativas + 1,
            ultima_tentativa = NOW(),
            motivo           = NULL
      WHERE sgpe_processo_ref.origem <> 'CONFERIDO'`,
    [p.sigla, p.numero, p.ano, r.nuProcesso, r.cdOrgaosetor]
  );
}

async function gravarNegativa(db, p, motivo) {
  await db.query(
    `INSERT INTO sgpe_processo_ref
       (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, tentativas, ultima_tentativa, motivo)
     VALUES ($1, $2, $3, NULL, NULL, 'NAO_ENCONTRADO', 1, NOW(), $4)
     ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
        SET nu_processo      = NULL,
            cd_orgaosetor    = NULL,
            origem           = 'NAO_ENCONTRADO',
            tentativas       = sgpe_processo_ref.tentativas + 1,
            ultima_tentativa = NOW(),
            motivo           = $4
      WHERE sgpe_processo_ref.origem NOT IN ('CONFERIDO', 'SGPE')`,
    [p.sigla, p.numero, p.ano, String(motivo || '').slice(0, 300)]
  );
}

async function gravarErro(db, p, motivo) {
  await db.query(
    `INSERT INTO sgpe_processo_ref
       (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, tentativas, ultima_tentativa, motivo)
     VALUES ($1, $2, $3, NULL, NULL, 'ERRO', 1, NOW(), $4)
     ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
        SET origem           = 'ERRO',
            tentativas       = sgpe_processo_ref.tentativas + 1,
            ultima_tentativa = NOW(),
            motivo           = $4
      WHERE sgpe_processo_ref.origem NOT IN ('CONFERIDO', 'SGPE', 'NAO_ENCONTRADO')`,
    [p.sigla, p.numero, p.ano, String(motivo || '').slice(0, 300)]
  );
}

module.exports = {
  chavesDeValores,
  montarLinks,
  linksDeLinhas,
  gravarResolvido,
  gravarNegativa,
  gravarErro,
};
