// CAMINHO: sigpc-api/job_sgpe_situacao.js
//
// JOB — mantém a situação de cada processo do SGPe atualizada, consultando o PORTAL PÚBLICO.
// A regra mora em `lib/sgpe-situacao.js`; a consulta, em `lib/sgpe-portal.js`. Aqui só corre a
// rodada.
//
// USO
//   node job_sgpe_situacao.js                       # dry-run: mostra a rodada e não toca em nada
//   node job_sgpe_situacao.js --limite=20 --gravar  # a primeira rodada de verdade, pequena
//   node job_sgpe_situacao.js --gravar              # a rodada normal: 300
//   node job_sgpe_situacao.js --pausa=300 --gravar  # mais devagar
//
// ⚠️ DRY-RUN É O PADRÃO, e no dry-run ele NÃO VAI À REDE. Mostrar quem entraria na rodada não
// exige consultar o portal — e um "dry-run" que faz 300 chamadas a sistema de terceiro é
// exatamente o abuso que a pausa existe para evitar.
//
// ⚠️ NUNCA NO BOOT DO SERVIDOR, como o `job_sgpe_links.js`: processo separado, de propósito.
//
// ⚠️ 180 ms ENTRE CHAMADAS, E O NÚMERO NÃO É ENFEITE. O portal é público e gratuito, e não há
// contrato nenhum por trás dele. 300 consultas a 180 ms é ~1 minuto de rodada — folgado para
// um cron de hora em hora, e devagar o bastante para não parecer ataque. Não baixar.
//
// ⚠️ E HÁ TRAVA DE RODADA ÚNICA (lib/trava.js). Sem ela, uma rodada que passasse da hora seria
// atropelada pela seguinte, e as duas visitariam os MESMOS processos — porque a ordem sai de
// `ORDER BY checado_em`, e a primeira só carimba a data ao terminar cada um.

const { Pool } = require('pg');
const { chavesDeValores } = require('./lib/sgpe-lote');
const { formatarProcesso } = require('./lib/sgpe-link');
const portal = require('./lib/sgpe-portal');
const sit = require('./lib/sgpe-situacao');
const trava = require('./lib/trava');
const { escreverReversao } = require('./lib/reversao');

const LOTE_PADRAO = 300;
const PAUSA_PADRAO = 180;
const REVERSAO = 'reverter_sgpe_situacao_rodada.json';

// DISJUNTOR, como no job dos links: erro isolado é normal, erro em série é o portal fora do ar.
// ⚠️ `NAO_ENCONTRADO` e `SIGILOSO` NÃO CONTAM — são o portal respondendo, e respondendo certo.
// Só `REDE` conta.
const MAX_ERROS_SEGUIDOS = 10;

const log = (s) => console.log(s);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function rodar(opc = {}) {
  const { limite = LOTE_PADRAO, pausaMs = PAUSA_PADRAO, gravar = false, pool = null } = opc;
  const db = pool || new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const proprio = !pool;

  const e = {
    universo: 0, nunca: 0, rodada: 0, consultados: 0,
    ok: 0, naoEncontrado: 0, sigiloso: 0, siglaNaoCadastrada: 0, rede: 0,
    tramitesGravados: 0, situacoesGravadas: 0,
    interrompido: false, abortadoPorErros: false, semTrava: false,
  };

  let parar = false;
  const aoInterromper = () => { if (!parar) { parar = true; log('\n  Interrompendo ao fim do processo atual...') } };
  process.on('SIGINT', aoInterromper);

  // A trava vem ANTES de qualquer trabalho — inclusive antes de ler o acervo.
  const t = await trava.tomar(db, trava.CHAVES.SGPE_SITUACAO);
  if (!t.pegou) {
    e.semTrava = true;
    log('\n  OUTRA RODADA JA ESTA CORRENDO (advisory lock ' + trava.CHAVES.SGPE_SITUACAO + ').');
    log('  Esta desiste em vez de atropelar. O que ficar volta na proxima.\n');
    process.removeListener('SIGINT', aoInterromper);
    if (proprio) await db.end();
    return e;
  }

  try {
    // ── 1. O UNIVERSO ────────────────────────────────────────────────────────
    const { rows: brutos } = await db.query(sit.SQL_UNIVERSO);
    const alvos = new Map();
    for (const p of chavesDeValores(brutos.map(x => x.v)).values()) alvos.set(formatarProcesso(p), p);
    e.universo = alvos.size;

    // ── 2. QUEM JA FOI CHECADO ───────────────────────────────────────────────
    let checados = new Map();
    let temTabela = true;
    try {
      const { rows } = await db.query(sit.SQL_JA_CHECADOS);
      checados = new Map(rows.map(r => [`${r.sigla} ${r.numero_oficial}/${r.ano}`, r.checado_em]));
    } catch (err) {
      temTabela = false;
    }
    // ⚠️ SEM A TABELA, O DRY-RUN CONTINUA — e continua de propósito. O dry-run é o que se
    // mostra ANTES de decidir criar as tabelas; se ele exigisse as tabelas, só daria para
    // olhar a rodada depois de já ter feito o que ele deveria ajudar a decidir. Sem nenhuma
    // linha de situação, todo mundo é "nunca checado", que é exatamente o estado do primeiro
    // dia. Já a GRAVAÇÃO para: escrever antes da estrutura existir é erro, não previsão.
    if (!temTabela) {
      log('\n  A tabela sgpe_situacao ainda NAO EXISTE.');
      if (gravar) {
        log('  Rode antes:  node migracao_sgpe_situacao_20260830.js --gravar\n');
        return e;
      }
      log('  Seguindo o dry-run como se nada tivesse sido checado — que e o primeiro dia.\n');
    }

    // ── 3. O RODIZIO ─────────────────────────────────────────────────────────
    const todos = sit.montarRodizio(alvos, checados);
    e.nunca = todos.filter(x => x.checadoEm === null).length;
    const fila = todos.slice(0, limite);
    e.rodada = fila.length;

    const maisAntigo = todos.find(x => x.checadoEm !== null);
    log(`  universo ................ ${e.universo} processos  (processo_pc ∪ processo_mae)`);
    log(`  ja com situacao ......... ${checados.size}`);
    log(`  nunca checados .......... ${e.nunca}   ← vao primeiro (NULLS FIRST)`);
    log(`  nesta rodada ............ ${fila.length} de ${limite}`);
    log(`  ciclo completo .......... ${Math.ceil(e.universo / Math.max(1, limite))} rodadas neste tamanho`);
    if (maisAntigo) log(`  o mais antigo da fila ... ${maisAntigo.chave}  checado em ${new Date(maisAntigo.checadoEm).toISOString().slice(0, 16).replace('T', ' ')}`);
    log(`  ritmo ................... ${pausaMs} ms entre chamadas  →  ~${Math.round(fila.length * (pausaMs + 700) / 1000)}s de rodada`);

    if (!gravar) {
      log('\n  ── DRY-RUN: o portal NAO foi consultado e NADA foi gravado. ──');
      log(`  os 15 primeiros: ${fila.slice(0, 15).map(f => f.chave).join(' · ') || '(nenhum)'}`);
      log('\n  Para valer:  node job_sgpe_situacao.js --limite=20 --gravar\n');
      return e;
    }
    if (!fila.length) { log('\n  Nada a fazer.'); return e; }

    // ── 4. A RODADA ──────────────────────────────────────────────────────────
    log('');
    const inicio = Date.now();
    const detalhe = [];
    let errosSeguidos = 0;

    for (const { chave, p } of fila) {
      if (parar) { e.interrompido = true; break }

      const r = await portal.consultar(p.sigla, p.numero, p.ano);
      e.consultados++;

      const linha = sit.linhaDaSituacao(p, r);
      // ⚠️ UMA TRANSACAO POR PROCESSO, e nao uma pela rodada inteira. Sao 300 processos com
      // ate 34 tramites cada; uma transacao de 10 mil linhas segurada por um minuto de rede
      // prenderia os registros o tempo todo e perderia TUDO num erro no fim. Aqui, o processo
      // que falha nao leva junto os que ja deram certo — e o rodizio ja e a retomada.
      const cli = await db.connect();
      try {
        await cli.query('BEGIN');
        await cli.query(sit.SQL_GRAVAR_SITUACAO, sit.paramsSituacao(linha));
        e.situacoesGravadas++;
        if (r && r.ok) {
          for (const tr of (r.tramitacoes || [])) {
            await cli.query(sit.SQL_GRAVAR_TRAMITE, sit.paramsTramite(p, tr));
            e.tramitesGravados++;
          }
        }
        await cli.query('COMMIT');
      } catch (err) {
        try { await cli.query('ROLLBACK') } catch (_) {}
        log(`  ERRO DE BANCO  ${chave}  ${err.message}`);
        throw err;   // erro de banco derruba a rodada: nao e coisa de insistir
      } finally { cli.release() }

      if (r && r.ok) {
        e.ok++; errosSeguidos = 0;
        const a = r.atual || {};
        detalhe.push(`  OK              ${chave.padEnd(20)} ${String(r.processo.situacao_portal || '—').padEnd(10)} ${String(a.situacao || '—').padEnd(12)} ${String(a.setor_sigla || '—').padEnd(18)} ${a.dias === null || a.dias === undefined ? '—' : a.dias + 'd'} · ${(r.tramitacoes || []).length} tram.`);
      } else if (r.erro === portal.ERROS.NAO_ENCONTRADO) {
        e.naoEncontrado++; errosSeguidos = 0;
        detalhe.push(`  NAO ENCONTRADO  ${chave}`);
      } else if (r.erro === portal.ERROS.SIGILOSO) {
        e.sigiloso++; errosSeguidos = 0;
        detalhe.push(`  SIGILOSO        ${chave}`);
      } else if (r.erro === portal.ERROS.SIGLA_NAO_CADASTRADA) {
        e.siglaNaoCadastrada++; errosSeguidos = 0;
        detalhe.push(`  SIGLA FORA DO MAPA  ${chave}  (nao foi a rede)`);
      } else {
        e.rede++; errosSeguidos++;
        detalhe.push(`  REDE            ${chave}  ${r.motivo || ''}   (a situacao anterior fica)`);
        if (errosSeguidos >= MAX_ERROS_SEGUIDOS) {
          log(`\n  ${MAX_ERROS_SEGUIDOS} ERROS DE REDE SEGUIDOS — o portal provavelmente esta fora do ar.`);
          log('  Encerrando a rodada em vez de insistir. O que ficou volta na proxima.');
          e.interrompido = true; e.abortadoPorErros = true;
          break;
        }
      }

      // ⚠️ A PAUSA VEM DEPOIS DA GRAVACAO, nao antes: o tempo do banco nao desconta o tempo de
      // cortesia com o portal. Sao coisas separadas.
      // A sigla fora do mapa nao foi a rede — nao ha por que esperar por ela.
      if (pausaMs && !(r && r.erro === portal.ERROS.SIGLA_NAO_CADASTRADA)) await esperar(pausaMs);
    }

    const seg = Math.round((Date.now() - inicio) / 1000);
    log(detalhe.join('\n'));
    log(`\n  ── O QUE ACONTECEU ──`);
    log(`  consultados ............. ${e.consultados}`);
    log(`  sucesso ................. ${e.ok}`);
    log(`  NAO_ENCONTRADO .......... ${e.naoEncontrado}`);
    log(`  SIGILOSO ................ ${e.sigiloso}`);
    log(`  sigla fora do mapa ...... ${e.siglaNaoCadastrada}   (nao chegaram ao portal)`);
    log(`  REDE .................... ${e.rede}   (situacao anterior preservada)`);
    log(`  linhas em sgpe_situacao . ${e.situacoesGravadas}`);
    log(`  linhas em sgpe_tramitacao ${e.tramitesGravados}`);
    log(`  tempo ................... ${Math.floor(seg / 60)}min ${seg % 60}s`);
    if (e.interrompido) log('  RODADA INTERROMPIDA — o que ficou volta na proxima.');

    escreverReversao(REVERSAO, {
      modo: 'gravacao',
      script: 'job_sgpe_situacao.js',
      em: new Date().toISOString(),
      // ⚠️ A REVERSAO E POR LISTA EXPLICITA DE CHAVES (armadilha 12). Nunca por condicao
      // derivada: um `WHERE checado_em > ...` casaria tudo o que rodadas anteriores gravaram.
      chaves: fila.slice(0, e.consultados).map(f => f.chave),
      desfazer: 'DELETE FROM sgpe_situacao   WHERE (sigla, numero_oficial, ano) IN (as chaves acima)'
              + ' ; DELETE FROM sgpe_tramitacao WHERE (sigla, numero_oficial, ano) IN (as chaves acima)',
      resumo: { ok: e.ok, naoEncontrado: e.naoEncontrado, sigiloso: e.sigiloso, rede: e.rede },
    });

    return e;
  } finally {
    process.removeListener('SIGINT', aoInterromper);
    await t.soltar();
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
    gravar: argv.includes('--gravar'),
    limite: num('limite', LOTE_PADRAO),
    pausaMs: num('pausa', PAUSA_PADRAO),
  };
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL não definida.'); process.exit(1) }
  const o = lerArgumentos(process.argv.slice(2));
  console.log('\n═══ JOB — situação dos processos no SGPe ═══');
  console.log(o.gravar ? '  MODO: GRAVAÇÃO\n' : '  MODO: DRY-RUN — sem rede e sem escrita\n');
  rodar(o)
    .then(e => { console.log(''); process.exit(e.abortadoPorErros ? 1 : 0) })
    .catch(err => { console.error('ERRO:', err.message); process.exit(1) });
}

module.exports = { rodar, lerArgumentos, LOTE_PADRAO, PAUSA_PADRAO, MAX_ERROS_SEGUIDOS, REVERSAO };
