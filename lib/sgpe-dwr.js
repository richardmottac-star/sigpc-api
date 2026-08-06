// CAMINHO: sigpc-api/lib/sgpe-dwr.js
//
// PASSO 3 — descobrir o `nuProcesso` INTERNO consultando o SGPe.
//
// É a única forma correta de obter o número que vai na URL. Ver o aviso em `sgpe-link.js`:
// não existe fórmula, e errar o número abre outro processo em silêncio.
//
// SÓ NO SERVIDOR. Portado de `segov-sistema/nextjs_space/lib/sgpe-dwr.ts`.
//
// ⚠️ `SGPE_COOKIE` é OPCIONAL. O endpoint DWR responde SEM cookie de sessão (verificado ao vivo
// em 03/08/2026 contra os casos reais: SCC 8855/2025 → 8856, SCC 21206/2025 → 21212,
// SES 135960/2025 → 137111, e SCC 18870/2026 devolvendo size=0). No segov essa variável já foi
// obrigatória, e como ela nunca existiu no ambiente do Railway a consulta automática lançava
// SessaoExpirada em produção 100% das vezes — nenhum processo novo ganhava link sozinho.
// Não torne o cookie obrigatório aqui. Ele é enviado quando existe, e só.

const {
  ProcessoNaoEncontrado, SessaoExpirada, orgaoDaSigla,
} = require('./sgpe-link');

const ENDPOINT = 'https://sgpe.sea.sc.gov.br/cpav/dwr/exec';

/** true se há sessão configurada — a resposta da rota usa para explicar por que o link não saiu. */
const temSessaoSgpe = () => !!process.env.SGPE_COOKIE;

// ── O PARSER DA RESPOSTA ──────────────────────────────────────────────────────
// A resposta NÃO é JSON: é um script DWR, assim —
//   var s0={}
//   var s10=8855
//   s0['nuProcessooficial']=s10
//   var s16=8856
//   s0['nuProcesso']=s16
//   DWREngine._handleResponse('0', s0)
//
// O parser monta os dois dicionários (variáveis e propriedades) e cruza. NÃO depende dos
// índices `s10`/`s16` — eles mudam de resposta para resposta.
function lerRespostaDwr(corpo) {
  const variaveis = {};
  for (const m of corpo.matchAll(/var\s+(s\d+)\s*=\s*("?)([^";\n]*)\2/g)) {
    variaveis[m[1]] = m[3];
  }
  const propriedades = {};
  for (const m of corpo.matchAll(/s0\['([^']+)'\]\s*=\s*(s\d+)/g)) {
    propriedades[m[1]] = m[2];
  }
  const saida = {};
  for (const [nome, ref] of Object.entries(propriedades)) {
    if (ref in variaveis) saida[nome] = variaveis[ref];
  }
  return saida;
}

/**
 * Converte a resposta crua em `nuProcesso`, aplicando TODAS as validações obrigatórias.
 * Separada da rede para poder ser testada com respostas reais gravadas, sem sessão.
 */
function interpretarResposta(corpo, p, cdOrgaosetor) {
  // Sessão caída: o SGPe devolve a tela de login em vez do script.
  if (/<html/i.test(corpo) || !/s0\s*=/.test(corpo)) {
    throw new SessaoExpirada('A sessão do SGPe expirou — o endpoint devolveu HTML de login em vez da resposta DWR.');
  }
  if (/Error converting parameters/i.test(corpo)) {
    throw new Error('O SGPe recusou os parâmetros ("Error converting parameters") — tipo errado na chamada DWR.');
  }

  const campos = lerRespostaDwr(corpo);

  // size = 0 significa que o processo NÃO existe. Caso real: SCC 18870/2026 não existe (o que
  // existe é SCC 18870/2025). Sem esta checagem, geraríamos um link para o nada.
  if (campos.size !== undefined && Number(campos.size) === 0) {
    throw new ProcessoNaoEncontrado(`O SGPe não tem o processo ${p.sigla} ${p.numero}/${p.ano}.`);
  }

  const nuProcesso = Number(campos.nuProcesso);
  if (!Number.isFinite(nuProcesso) || nuProcesso <= 0) {
    throw new ProcessoNaoEncontrado(`Resposta do SGPe sem "nuProcesso" para ${p.sigla} ${p.numero}/${p.ano}.`);
  }

  // Conferência de sanidade: o número oficial que voltou tem de ser o que foi perguntado.
  // Se divergir, a resposta é de outro processo e o link levaria ao lugar errado.
  const oficial = Number(campos.nuProcessooficial);
  if (Number.isFinite(oficial) && oficial !== p.numero) {
    throw new ProcessoNaoEncontrado(
      `O SGPe respondeu sobre o processo ${oficial}, não o ${p.numero} que foi perguntado — resposta descartada.`);
  }

  const orgaoResposta = Number(campos.cdOrgaosetor);
  return {
    nuProcesso,
    cdOrgaosetor: Number.isFinite(orgaoResposta) && orgaoResposta > 0 ? orgaoResposta : cdOrgaosetor,
    ano: p.ano,
  };
}

// ── A CHAMADA ─────────────────────────────────────────────────────────────────
// O corpo é uma diretiva por linha, terminando em \n. `param2` vai com 8 dígitos (zfill).
function corpoDaChamada(p, cdOrgaosetor) {
  return [
    'callCount=1',
    'c0-scriptName=FormatadorDWR',
    'c0-methodName=getProcesso1',
    'c0-id=0',
    'c0-param0=string:P',
    `c0-param1=string:${p.ano}`,
    `c0-param2=string:${String(p.numero).padStart(8, '0')}`,
    `c0-param3=string:${cdOrgaosetor}`,
    'c0-param4=string:PC',
    'c0-param5=string:',
    'c0-param6=boolean:false',
    'c0-param7=boolean:true',
    'xml=true',
    '',
  ].join('\n');
}

/**
 * Consulta o SGPe. Sequencial e com espera entre tentativas: o SGPe é recurso caro e de
 * terceiro — nada de paralelismo agressivo.
 */
async function resolverNoSgpe(p, tentativas = 3) {
  const cookie = process.env.SGPE_COOKIE;   // opcional — ver o aviso no topo do arquivo
  const cdOrgaosetor = orgaoDaSigla(p.sigla);

  let ultimoErro = null;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...(cookie ? { cookie } : {}) },
        body: corpoDaChamada(p, cdOrgaosetor),
        cache: 'no-store',
      });
      // Só 5xx merece nova tentativa; 4xx é problema nosso e repetir não conserta.
      if (r.status >= 500) { ultimoErro = new Error(`SGPe respondeu ${r.status}`); }
      else return interpretarResposta(await r.text(), p, cdOrgaosetor);
    } catch (e) {
      ultimoErro = e;
      if (e instanceof ProcessoNaoEncontrado || e instanceof SessaoExpirada) throw e;
    }
    await new Promise(res => setTimeout(res, 400 * (i + 1)));  // backoff
  }
  throw ultimoErro || new Error('Falha ao consultar o SGPe');
}

module.exports = {
  ENDPOINT,
  temSessaoSgpe,
  lerRespostaDwr,
  interpretarResposta,
  corpoDaChamada,
  resolverNoSgpe,
};
