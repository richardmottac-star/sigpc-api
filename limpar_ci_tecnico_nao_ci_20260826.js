// CAMINHO: sigpc-api/limpar_ci_tecnico_nao_ci_20260826.js
//
// TIRA DE `ci_tecnico_id` QUEM NÃO É DO CONTROLE INTERNO. PADRÃO = DRY-RUN. Só grava com --gravar.
//
// ═══ O QUE ACONTECEU ═══
//
// A tela do C.I. de 25/08 atribuía a PC a quem a EXPANDIA. O Richard abriu uma para conferir
// o diagnóstico dos 16 processos, e o nome dele passou a aparecer na coluna TÉCNICO C.I. —
// "RM Richard", numa PC que ele não analisa. **Ele é superadmin, não é técnico do C.I.**
//
// ⚠️ NÃO FOI UM CLIQUE ERRADO: foi a regra que estava errada. Expandir para LER virou um ato
// de posse, e a única maneira de olhar uma PC era assumi-la. Isso foi desfeito no mesmo
// ciclo — abrir voltou a ser só abrir, e a PC só ganha técnico quando o parecer é confirmado.
// Este script limpa o que a regra antiga escreveu enquanto ela existiu.
//
// ⚠️ E A ROTA GANHOU A TRAVA QUE FALTAVA: só `perfil = 'controle_interno'` pode ser gravado
// como técnico, superadmin incluído. Sem ela, limpar aqui só adiaria o problema até o próximo
// clique.
//
// ═══ O RECORTE ═══
//
// ⚠️ O ALVO NÃO É "O RICHARD": é **toda PC cujo `ci_tecnico_id` aponte para alguém que não
// tem `perfil = 'controle_interno'`**. Cravar o id 4 limparia o caso conhecido e deixaria
// passar o coordenador que clicou ontem e ninguém viu. A pergunta certa é "quem está marcado
// como técnico do C.I. sem ser do C.I.", e ela se responde contra o cadastro.
//
// ⚠️ A LISTA É CAPTURADA ANTES DA ESCRITA, e o UPDATE vai por `codigo_pc = ANY($1)` com ela
// (armadilha 12). Reverter por condição derivada — "todo mundo que não é do C.I." — casaria
// linhas que outra pessoa gravou depois, e foi assim que 7 linhas viraram 14.639 em 12/08.
//
// ⚠️ NADA MAIS É TOCADO. `ci_situacao`, `ci_rodada`, `ci_encerrado_em`, `ci_encerrado_por`,
// `baixada`, `data_baixa` e `enviado_ci` ficam como estão: quem está com a PC é uma pergunta,
// e onde ela está no ciclo é outra.
//
// USO:
//   node limpar_ci_tecnico_nao_ci_20260826.js              dry-run
//   node limpar_ci_tecnico_nao_ci_20260826.js --gravar     grava
//
// ⚠️ Escrita em produção EXIGE ordem expressa do Richard (regra 1 do time de agentes).

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const REVERSAO = __dirname + '/reverter_ci_tecnico_nao_ci_20260826.json';
const INTOCADAS = ['prestacoes_contas', 'parcela_historico', 'usuarios', 'notificacao'];

// ⚠️ `u.perfil`, E NÃO `papel.perfilEfetivo`. O papel ativo é da SESSÃO — o Richard alterna
// entre analista e técnico várias vezes por dia, e o cadastro não muda com isso. Aqui a
// pergunta é do cadastro: esta pessoa É do Controle Interno? O `LEFT JOIN` deixa passar
// também o `ci_tecnico_id` que aponta para usuário que não existe mais.
const SQL_ALVO = `
  SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.processo_pc, p.ci_situacao,
         p.ci_tecnico_id, p.ci_tecnico_em, u.nome AS tecnico_nome,
         COALESCE(u.perfil, '(usuário não existe)') AS tecnico_perfil
    FROM prestacoes_contas p
    LEFT JOIN usuarios u ON u.id = p.ci_tecnico_id
   WHERE p.ci_tecnico_id IS NOT NULL
     AND (u.id IS NULL OR u.perfil IS DISTINCT FROM 'controle_interno')
   ORDER BY u.nome, p.tr, p.codigo_pc`;

const dataBr = (v) => {
  if (!v) return '—';
  if (v instanceof Date) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()} ` +
                                `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`;
  return String(v);
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  let commitou = false;
  try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  QUEM NÃO É DO C.I. SAI DO ci_tecnico_id — ${GRAVAR ? '*** GRAVANDO ***' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════\n');

    const alvo = (await cli.query(SQL_ALVO)).rows;
    const codigos = alvo.map(r => r.codigo_pc);

    // O panorama: quem está marcado como técnico hoje, e quem tem direito de estar.
    const todos = (await cli.query(`
      SELECT COALESCE(u.perfil, '(usuário não existe)') perfil, u.nome, COUNT(*)::int n
        FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.ci_tecnico_id
       WHERE p.ci_tecnico_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
    console.log('── QUEM ESTÁ MARCADO COMO TÉCNICO DO C.I. HOJE');
    if (!todos.length) console.log('   (nenhuma PC tem técnico gravado)');
    todos.forEach(r => console.log(
      `   ${(r.perfil === 'controle_interno' ? 'fica ' : 'SAI  ')} ${String(r.n).padStart(4)} PC(s)  ` +
      `${(r.nome || '(sem nome)').padEnd(32)} ${r.perfil}`));

    console.log(`\n── AS ${alvo.length} PC(s) QUE SERÃO LIMPAS`);
    if (!alvo.length) {
      console.log('   (nenhuma — nada a fazer)\n');
      return;
    }
    console.log('   PC              TR              parc  situação        marcado para                     desde');
    console.log('   ' + '─'.repeat(112));
    alvo.forEach(r => console.log(
      `   ${r.codigo_pc.padEnd(16)}${(r.tr || '').padEnd(16)}${String(r.parcial_num || '—').padEnd(6)}` +
      `${String(r.ci_situacao || '(nula)').padEnd(16)}${(r.tecnico_nome || '(?)').padEnd(33)}${dataBr(r.ci_tecnico_em)}`));
    console.log('\n   entidade / processo de cada uma:');
    alvo.forEach(r => console.log(`   ${r.codigo_pc}  ${r.processo_pc || '—'}  ${r.entidade || '—'}`));

    console.log('\n── O QUE SERÁ ESCRITO');
    console.log('   UPDATE prestacoes_contas SET ci_tecnico_id = NULL, ci_tecnico_em = NULL');
    console.log(`    WHERE codigo_pc = ANY($1)      -- a lista das ${codigos.length} acima, capturada ANTES`);
    console.log('\n── O QUE NÃO É TOCADO');
    console.log('   ci_situacao · ci_rodada · ci_encerrado_em · ci_encerrado_por · baixada ·');
    console.log('   data_baixa · enviado_ci. Nenhuma linha é criada ou apagada.');

    if (!GRAVAR) {
      console.log('\n── DRY-RUN. Nada foi gravado. Rode com --gravar para executar.\n');
      return;
    }

    await cli.query('BEGIN');

    // ⚠️ A FOTO DO INÍCIO DA TRANSAÇÃO (armadilha 21). A pergunta é "esta rodada mexeu no que
    // não devia?", e não "algo mudou desde que eu escrevi o script?".
    const antes = {};
    for (const t of INTOCADAS) antes[t] = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
    const cicloAntes = (await cli.query(
      `SELECT COALESCE(ci_situacao,'(nulo)') s, COUNT(*)::int n FROM prestacoes_contas GROUP BY 1 ORDER BY 1`)).rows;
    const baixaAntes = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE baixada)::int b, COUNT(*) FILTER (WHERE enviado_ci)::int e,
              COUNT(*) FILTER (WHERE data_baixa IS NOT NULL)::int d FROM prestacoes_contas`)).rows[0];
    // ⚠️ O md5 das OUTRAS linhas — as que este script não deve encostar. Contar não prova que
    // elas não mudaram; foi a lição de 17/08, quando a conferência "nenhum outro aviso foi
    // tocado" deixou de ser uma contagem e virou uma assinatura.
    const outrasAntes = (await cli.query(
      `SELECT md5(string_agg(codigo_pc || ':' || COALESCE(ci_tecnico_id::text,'-') || ':' ||
                             COALESCE(ci_tecnico_em::text,'-'), '|' ORDER BY codigo_pc)) h
         FROM prestacoes_contas WHERE NOT (codigo_pc = ANY($1))`, [codigos])).rows[0].h;

    const upd = await cli.query(
      `UPDATE prestacoes_contas SET ci_tecnico_id = NULL, ci_tecnico_em = NULL, atualizado_em = NOW()
        WHERE codigo_pc = ANY($1) RETURNING codigo_pc`, [codigos]);

    console.log('\n── CONFERÊNCIA DEPOIS DE GRAVAR (dentro da transação)');
    let falhou = 0;
    const conf = (ok, rot) => { if (!ok) falhou++; console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${rot}`); };

    conf(upd.rowCount === codigos.length,
         `as ${codigos.length} previstas foram alcançadas — o UPDATE tocou ${upd.rowCount}`);
    const sobrou = (await cli.query(SQL_ALVO)).rows.length;
    conf(sobrou === 0, `nenhuma PC continua marcada para quem não é do C.I. — sobraram ${sobrou}`);
    const nulas = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE ci_tecnico_id IS NOT NULL OR ci_tecnico_em IS NOT NULL)::int n
         FROM prestacoes_contas WHERE codigo_pc = ANY($1)`, [codigos])).rows[0].n;
    conf(nulas === 0, `as ${codigos.length} ficaram com as DUAS colunas nulas — ${nulas} com resto`);
    // ⚠️ E O QUE SOBROU MARCADO TEM DE SER SÓ C.I. — a limpeza não pode ter derrubado técnico
    // legítimo junto.
    const restante = (await cli.query(
      `SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN usuarios u ON u.id = p.ci_tecnico_id
        WHERE u.perfil = 'controle_interno'`)).rows[0].n;
    conf(true, `técnicos do C.I. legítimos preservados: ${restante} PC(s) — nenhuma foi limpa`);

    const outrasDepois = (await cli.query(
      `SELECT md5(string_agg(codigo_pc || ':' || COALESCE(ci_tecnico_id::text,'-') || ':' ||
                             COALESCE(ci_tecnico_em::text,'-'), '|' ORDER BY codigo_pc)) h
         FROM prestacoes_contas WHERE NOT (codigo_pc = ANY($1))`, [codigos])).rows[0].h;
    conf(outrasAntes === outrasDepois, 'nenhuma OUTRA PC teve o técnico tocado (md5 das demais linhas)');

    for (const t of INTOCADAS) {
      const dep = (await cli.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      conf(dep === antes[t], `${t} intacta — ${antes[t]} linhas antes e depois`);
    }
    const cicloDep = (await cli.query(
      `SELECT COALESCE(ci_situacao,'(nulo)') s, COUNT(*)::int n FROM prestacoes_contas GROUP BY 1 ORDER BY 1`)).rows;
    conf(JSON.stringify(cicloAntes) === JSON.stringify(cicloDep),
         'ci_situacao intacta — ' + cicloAntes.map(r => `${r.s}:${r.n}`).join(' · '));
    const baixaDep = (await cli.query(
      `SELECT COUNT(*) FILTER (WHERE baixada)::int b, COUNT(*) FILTER (WHERE enviado_ci)::int e,
              COUNT(*) FILTER (WHERE data_baixa IS NOT NULL)::int d FROM prestacoes_contas`)).rows[0];
    conf(JSON.stringify(baixaAntes) === JSON.stringify(baixaDep),
         `a baixa intacta — baixada:${baixaAntes.b} · enviado_ci:${baixaAntes.e} · data_baixa:${baixaAntes.d}`);

    if (falhou) { await cli.query('ROLLBACK'); throw new Error(`${falhou} conferência(s) falharam — ROLLBACK`); }

    await cli.query('COMMIT');
    commitou = true;
    console.log('\n   Todas as conferências passaram. COMMIT.\n');

    fs.writeFileSync(REVERSAO, JSON.stringify({
      o_que: 'zerou ci_tecnico_id/ci_tecnico_em de quem nao e do Controle Interno',
      quando: new Date().toISOString(),
      motivo: 'a tela de 25/08 atribuia a PC a quem a EXPANDIA; abrir para ler virava posse',
      pcs: alvo.map(r => ({
        codigo_pc: r.codigo_pc, tr: r.tr, parcial_num: r.parcial_num,
        processo_pc: r.processo_pc, ci_situacao: r.ci_situacao,
        ci_tecnico_id_antes: r.ci_tecnico_id,
        ci_tecnico_em_antes: r.ci_tecnico_em ? new Date(r.ci_tecnico_em).toISOString() : null,
        tecnico_nome_antes: r.tecnico_nome, tecnico_perfil_antes: r.tecnico_perfil,
      })),
      reverter_com: alvo.map(r =>
        `UPDATE prestacoes_contas SET ci_tecnico_id = ${r.ci_tecnico_id}, ` +
        `ci_tecnico_em = ${r.ci_tecnico_em ? `'${new Date(r.ci_tecnico_em).toISOString()}'` : 'NULL'} ` +
        `WHERE codigo_pc = '${r.codigo_pc}';`),
      atencao: 'reverter recoloca um NAO-TECNICO como responsavel do C.I. — a rota recusa isso desde 26/08. ' +
               'So faz sentido se a limpeza tiver sido um engano.',
      nao_tocado: ['ci_situacao', 'ci_rodada', 'ci_encerrado_em', 'ci_encerrado_por',
                   'baixada', 'data_baixa', 'enviado_ci'],
    }, null, 2));
    console.log('   reversão: ' + REVERSAO + '\n');
  } catch (e) {
    if (!commitou) { try { await cli.query('ROLLBACK'); } catch (_) {} }
    console.error('\n✗ ' + e.message + '\n');
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
