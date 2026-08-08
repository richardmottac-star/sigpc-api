// CAMINHO: sigpc-api/job_sgpe_links.js
//
// JOB — resolve no SGPe os processos que ainda não estão em `sgpe_processo_ref` e guarda o
// resultado. É o ÚNICO lugar que consulta o SGPe em volume: as rotas só leem o cache.
//
// USO
//   node job_sgpe_links.js --dry-run              # mostra a fila e não toca em nada
//   node job_sgpe_links.js --limite=200           # morde um pedaço e para (uso do cron)
//   node job_sgpe_links.js --somente-novos        # só o que nunca foi tentado (fim de carga)
//   node job_sgpe_links.js --retentar-erros       # força os que falharam por rede
//   node job_sgpe_links.js --pausa=200            # espera N ms entre processos
//
// ⚠️ NUNCA no boot do servidor. `garantirTabelaSgpe()` é aguardado antes do `app.listen`
// (server.js), e uma rodada de 1h ali derrubaria o deploy do Railway. Este arquivo é processo
// separado, de propósito.
//
// ⚠️ SEQUENCIAL, um processo por vez. O SGPe é sistema de terceiro; o ritmo natural medido em
// produção é ~0,6 s por processo e não deve ser forçado. Ver lib/sgpe-dwr.js.
//
// Sem credencial no código: usa `process.env.DATABASE_URL`. Pode ser versionado, ao contrário
// dos scripts de carga.

const { Pool } = require('pg');
const { formatarProcesso, ProcessoNaoEncontrado, SessaoExpirada } = require('./lib/sgpe-link');
const { resolverNoSgpe } = require('./lib/sgpe-dwr');
const {
  chavesDeValores, gravarResolvido, gravarNegativa, gravarErro,
} = require('./lib/sgpe-lote');

// Depois de 5 falhas de REDE o processo sai da fila automática — só volta com --retentar-erros.
// Não é negativa: a negativa vem do SGPe dizendo que o processo não existe, e essa não volta nunca.
const MAX_TENTATIVAS = 5;

// Recuo entre tentativas de um mesmo processo que falhou por rede. Cresce para não insistir em
// cima de instabilidade: 15 min, 1 h, 6 h, 24 h — e depois desiste.
const RECUO_MINUTOS = [15, 60, 360, 1440];

// DISJUNTOR. Erro isolado é normal e segue adiante; erro em série é o SGPe fora do ar, e aí
// insistir só produz dano: 7 mil linhas marcadas como ERRO, `tentativas` inflado e uma hora
// perdida. Uma rodada abortada não custa nada — o que ficou volta na próxima.
// `naoEncontrado` NÃO conta: é o SGPe respondendo, e respondendo certo.
const MAX_ERROS_SEGUIDOS = 10;

/** Minutos a esperar antes da próxima tentativa; `null` = desistiu. */
function esperaMinutos(tentativas) {
  const t = Number(tentativas) || 0;
  if (t >= MAX_TENTATIVAS) return null;
  return RECUO_MINUTOS[Math.min(Math.max(t, 1), RECUO_MINUTOS.length) - 1];
}

/**
 * Decide quem entra na fila. Pura — sem banco e sem rede, para poder ser testada.
 *
 * @param {Map<string,{sigla,numero,ano}>} alvos       chave canônica -> tripla (o acervo)
 * @param {Map<string,{origem,tentativas,ultima_tentativa}>} existentes  o que já está no cache
 * @returns {Array<{chave: string, p: object}>} ordenada, sem limite aplicado
 */
function montarFila(alvos, existentes, { somenteNovos = false, retentarErros = false, agora = new Date() } = {}) {
  const fila = [];
  for (const [chave, p] of alvos) {
    const ja = existentes.get(chave);

    // Nunca tentado — o caso normal da primeira carga.
    if (!ja) { fila.push({ chave, p }); continue; }

    // Estados definitivos. NAO_ENCONTRADO é o ponto inteiro da negativa: não reconsultar.
    if (ja.origem === 'SGPE' || ja.origem === 'CONFERIDO' || ja.origem === 'NAO_ENCONTRADO') continue;

    // Sobrou 'ERRO': falha de rede, estado provisório.
    if (somenteNovos) continue;
    if (retentarErros) { fila.push({ chave, p }); continue; }

    const espera = esperaMinutos(ja.tentativas);
    if (espera === null) continue;                       // desistiu; só --retentar-erros traz de volta
    const desde = ja.ultima_tentativa ? new Date(ja.ultima_tentativa) : null;
    if (!desde || (agora - desde) >= espera * 60000) fila.push({ chave, p });
  }
  fila.sort((a, b) => a.chave.localeCompare(b.chave));
  return fila;
}

function novoPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
      ? false
      : { rejectUnauthorized: false },
  });
}

/**
 * Roda uma passada. Chamável como módulo (fim de carga) ou pela CLI.
 * `opts.pool` permite reaproveitar a conexão de quem chamou.
 */
async function rodar(opts = {}) {
  const {
    limite = Infinity, dryRun = false, somenteNovos = false, retentarErros = false,
    pausaMs = 0, pool: poolExterno = null, log = console.log,
    // Injetável só para teste — em produção é sempre a consulta real ao SGPe.
    resolver = resolverNoSgpe,
  } = opts;

  const db = poolExterno || novoPool();
  const proprio = !poolExterno;

  // Ctrl+C encerra depois do processo corrente, sem deixar escrita pela metade.
  let parar = false;
  const aoInterromper = () => { parar = true; log('\n  (interrompido — terminando o processo atual e saindo)'); };
  process.on('SIGINT', aoInterromper);

  const estado = {
    alvos: 0, fila: 0, processados: 0,
    resolvidos: 0, naoEncontrados: 0, erros: 0, restantes: 0,
    interrompido: false, abortadoPorErros: false,
  };

  try {
    // ── 1. o acervo ──
    const { rows: brutos } = await db.query(
      `SELECT processo_pc AS v FROM prestacoes_contas WHERE processo_pc IS NOT NULL
       UNION
       SELECT processo_mae   FROM prestacoes_contas WHERE processo_mae IS NOT NULL`
    );
    // A mesma normalização das rotas — inclusive a trava de ambiguidade. O que não é processo
    // (texto livre, sigla fora do mapa, região colada ao número) nunca chega ao SGPe.
    const porBruto = chavesDeValores(brutos.map(r => r.v));
    const alvos = new Map();
    for (const p of porBruto.values()) alvos.set(formatarProcesso(p), p);
    estado.alvos = alvos.size;

    // ── 2. o que já está resolvido ou descartado ──
    // A tabela inteira: são ~8 mil linhas no pior caso, menos que uma página de PCs.
    const { rows: cache } = await db.query(
      `SELECT sigla, numero_oficial, ano, origem, tentativas, ultima_tentativa FROM sgpe_processo_ref`
    );
    const existentes = new Map(
      cache.map(c => [`${c.sigla} ${c.numero_oficial}/${c.ano}`, c])
    );

    // ── 3. a fila ──
    const filaToda = montarFila(alvos, existentes, { somenteNovos, retentarErros });
    const fila = Number.isFinite(limite) ? filaToda.slice(0, limite) : filaToda;
    estado.fila = fila.length;
    estado.restantes = filaToda.length - fila.length;

    const porEstado = {};
    for (const c of cache) porEstado[c.origem] = (porEstado[c.origem] || 0) + 1;

    log(`  acervo linkável ......... ${alvos.size}`);
    log(`  já no cache ............. ${cache.length}  (${Object.entries(porEstado).map(([k, v]) => `${k}=${v}`).join(' · ') || 'vazio'})`);
    log(`  fila total .............. ${filaToda.length}`);
    log(`  nesta rodada ............ ${fila.length}${estado.restantes ? `  (ficam ${estado.restantes} para as próximas)` : ''}`);
    if (fila.length) {
      const seg = Math.round(fila.length * 0.6);
      log(`  estimativa .............. ~${Math.floor(seg / 60)}min ${seg % 60}s  (0,6 s por processo, medido em produção)`);
    }

    if (dryRun) {
      log('\n  --dry-run: nada foi consultado nem gravado.');
      log(`  primeiros da fila: ${fila.slice(0, 10).map(f => f.chave).join(' · ') || '(nenhum)'}`);
      return estado;
    }
    if (!fila.length) { log('\n  Nada a fazer.'); return estado; }

    // ── 4. resolve ──
    log('');
    const inicio = Date.now();
    let errosSeguidos = 0;
    for (const { chave, p } of fila) {
      if (parar) { estado.interrompido = true; break; }
      try {
        const r = await resolver(p);
        await gravarResolvido(db, p, r);
        estado.resolvidos++;
        errosSeguidos = 0;
      } catch (e) {
        if (e instanceof ProcessoNaoEncontrado) {
          // Definitivo: o SGPe respondeu que não existe. Grava a negativa e nunca mais volta.
          await gravarNegativa(db, p, e.message);
          estado.naoEncontrados++;
          errosSeguidos = 0;   // resposta válida do SGPe — ele está no ar
          log(`  NAO ENCONTRADO  ${chave}`);
        } else if (e instanceof SessaoExpirada) {
          // Derruba a rodada inteira: insistir só geraria erro em série.
          log(`  SESSAO EXPIRADA em ${chave} — encerrando a rodada.`);
          estado.interrompido = true;
          break;
        } else {
          // Rede, timeout, sigla ambígua. Provisório: volta para a fila com recuo.
          await gravarErro(db, p, e.message);
          estado.erros++;
          errosSeguidos++;
          log(`  ERRO  ${chave}  ${e.message}`);
          if (errosSeguidos >= MAX_ERROS_SEGUIDOS) {
            log(`\n  ${MAX_ERROS_SEGUIDOS} ERROS SEGUIDOS — o SGPe provavelmente está fora do ar.`);
            log('  Encerrando a rodada em vez de insistir. O que ficou volta na próxima.');
            estado.interrompido = true;
            estado.abortadoPorErros = true;
            break;
          }
        }
      }
      estado.processados++;
      if (estado.processados % 25 === 0) {
        const s = (Date.now() - inicio) / 1000;
        const falta = Math.round((fila.length - estado.processados) * (s / estado.processados));
        log(`  ${estado.processados}/${fila.length}  ·  ${(s / estado.processados).toFixed(2)}s por processo  ·  faltam ~${Math.floor(falta / 60)}min`);
      }
      if (pausaMs) await new Promise(res => setTimeout(res, pausaMs));
    }

    const s = Math.round((Date.now() - inicio) / 1000);
    log(`\n  resolvidos .............. ${estado.resolvidos}`);
    log(`  não encontrados ......... ${estado.naoEncontrados}   (negativa gravada, não volta)`);
    log(`  erros de rede ........... ${estado.erros}   (voltam para a fila com recuo)`);
    log(`  tempo ................... ${Math.floor(s / 60)}min ${s % 60}s`);
    if (estado.interrompido) log('  RODADA INTERROMPIDA — o que ficou volta na próxima.');
    return estado;
  } finally {
    process.removeListener('SIGINT', aoInterromper);
    if (proprio) await db.end();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function lerArgumentos(argv) {
  const num = (nome, padrao) => {
    const a = argv.find(x => x.startsWith(`--${nome}=`));
    if (!a) return padrao;
    const n = Number(a.split('=')[1]);
    return Number.isFinite(n) && n >= 0 ? n : padrao;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    somenteNovos: argv.includes('--somente-novos'),
    retentarErros: argv.includes('--retentar-erros'),
    limite: num('limite', Infinity),
    pausaMs: num('pausa', 0),
  };
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL não definida.');
    process.exit(1);
  }
  const opts = lerArgumentos(process.argv.slice(2));
  console.log('\n═══ JOB — links do SGPe ═══');
  rodar(opts)
    .then(e => { console.log(''); process.exit(e.erros && !e.resolvidos ? 1 : 0); })
    .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}

module.exports = {
  rodar, montarFila, esperaMinutos, lerArgumentos,
  MAX_TENTATIVAS, RECUO_MINUTOS, MAX_ERROS_SEGUIDOS,
};
