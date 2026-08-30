// CAMINHO: sigpc-api/lib/trava.js
//
// A TRAVA DE RODADA ÚNICA — advisory lock do Postgres.
//
// Impede que duas rodadas do mesmo job corram ao mesmo tempo. Hoje o `job_sgpe_links.js` não
// tem trava nenhuma: se uma rodada passar da hora, a do cron seguinte começa por cima, e as
// duas resolvem os MESMOS processos — porque a fila sai de `ORDER BY`, não de um estado que a
// primeira já tenha marcado. O resultado é o dobro de tráfego num sistema de terceiro,
// `tentativas` inflado em dobro, e duas transações disputando as mesmas linhas.
//
// ⚠️ ADVISORY LOCK, E NÃO UMA TABELA DE "job_rodando". A tabela precisa que alguém limpe a
// linha quando o processo morre — e processo morto é exatamente quando isso não acontece. O
// advisory lock é do BANCO e é preso à CONEXÃO: se o Node cair, o Railway reiniciar, ou a rede
// sumir, o Postgres derruba a sessão e solta a trava sozinho. Trava que depende de o programa
// se comportar bem na hora de morrer não é trava.
//
// ⚠️ `pg_try_advisory_lock`, NUNCA `pg_advisory_lock`. O sem `try` FICA ESPERANDO. Num cron
// isso empilharia processos em vez de descartá-los: a rodada nova deve DESISTIR quando a
// anterior ainda corre, não entrar na fila para começar quando ela terminar — o que corre é
// justamente a rodada que ainda vai fazer o trabalho.
//
// ⚠️ E A TRAVA VIVE NUMA CONEXÃO PRÓPRIA, tomada do pool e segurada até o fim. Numa conexão
// devolvida ao pool, a próxima consulta de outro trecho a receberia com a trava presa, e um
// `pg_advisory_unlock` de qualquer lugar a soltaria no meio da rodada.

// As chaves. Números fixos e ESCRITOS AQUI, num lugar só: advisory lock é um espaço global do
// banco inteiro, sem nome e sem catálogo. Dois jobs que sorteiem a mesma chave travam um ao
// outro sem que nada acuse — e quem for depurar não tem onde olhar para descobrir a colisão.
// Esta lista É o catálogo.
const CHAVES = {
  SGPE_LINKS:    811001,   // job_sgpe_links.js  — resolve o link no SGPe
  SGPE_SITUACAO: 811002,   // job_sgpe_situacao.js — sincroniza situação e tramitações
};

/**
 * Tenta tomar a trava. Devolve `{ pegou, soltar }` — e `soltar()` é seguro de chamar mesmo
 * quando não se pegou, para que o `finally` de quem chama não precise de um `if`.
 *
 * @param pool  o Pool do pg
 * @param chave um valor de CHAVES
 */
async function tomar(pool, chave) {
  const cli = await pool.connect();
  let pegou = false;
  try {
    const { rows } = await cli.query('SELECT pg_try_advisory_lock($1) AS ok', [chave]);
    pegou = rows[0].ok === true;
  } catch (e) {
    cli.release();
    throw e;
  }
  if (!pegou) {
    // Sem a trava a conexão não serve para nada aqui — devolvê-la já é a limpeza inteira.
    cli.release();
    return { pegou: false, soltar: async () => {} };
  }
  let solta = false;
  return {
    pegou: true,
    soltar: async () => {
      if (solta) return;
      solta = true;
      // O `try` é porque a conexão pode já ter morrido — e aí a trava também já morreu com
      // ela, que é o comportamento que se quer. Falhar ao soltar não é erro a propagar.
      try { await cli.query('SELECT pg_advisory_unlock($1)', [chave]); } catch (_) {}
      cli.release();
    },
  };
}

/** Quem está segurando as travas deste catálogo, agora. Só leitura — para diagnóstico. */
const SQL_QUEM_SEGURA = `
  SELECT l.objid AS chave, l.pid, a.application_name, a.state,
         (NOW() - a.backend_start) AS ha
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory' AND l.objid = ANY($1::int[])
   ORDER BY l.objid`;

module.exports = { CHAVES, tomar, SQL_QUEM_SEGURA };
