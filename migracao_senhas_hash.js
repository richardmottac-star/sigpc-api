// CAMINHO: sigpc-api/migracao_senhas_hash.js
//
// CONVERTE AS SENHAS EM TEXTO PURO PARA HASH BCRYPT, de uma vez.
//
// ⚠️ NÃO RODA SOZINHO. Sem `--executar` ele só mostra o que faria.
//
// ------------------------------------------------------------
// ISTO É OPCIONAL — e é bom entender por quê antes de rodar
// ------------------------------------------------------------
// O login já converte a senha de cada pessoa no momento em que ela entra (ver o comentário
// de `precisaRehash` em lib/auth.js). Então este script não é necessário para o sistema
// funcionar: ele só antecipa, para quem ainda não entrou, o que aconteceria no primeiro
// acesso.
//
// O que ele resolve: enquanto sobrar texto puro na coluna, quem tiver acesso ao banco lê a
// senha das pessoas. A rota já não devolve mais `senha_hash` — mas o painel do Railway,
// um backup ou um SELECT continuam mostrando.
//
// O que ele NÃO resolve: a senha continua sendo a mesma, e 44 pessoas continuam
// compartilhando uma. Quem resolve isso é a troca obrigatória — migracao_senhas.sql.
//
// ------------------------------------------------------------
// USO
// ------------------------------------------------------------
//   node migracao_senhas_hash.js              # mostra o que faria, não escreve
//   node migracao_senhas_hash.js --executar   # converte
//
// Reverter NÃO é possível: o hash não volta a ser a senha. É o objetivo. Antes de rodar
// com --executar, guarde o resultado do modo de conferência se quiser registro do estado.

const { Pool } = require('pg');
const auth = require('./lib/auth');

const EXECUTAR = process.argv.includes('--executar');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const { rows } = await pool.query(
    `SELECT id, nome, senha_hash FROM usuarios
      WHERE senha_hash IS NOT NULL AND senha_hash NOT LIKE '$2%'
      ORDER BY id`);

  if (!rows.length) {
    console.log('Nenhuma senha em texto puro. Nada a fazer.');
    await pool.end();
    return;
  }

  console.log(`\n${rows.length} senha(s) em texto puro:\n`);
  for (const u of rows) {
    // O valor NÃO é impresso — imprimir a senha aqui recriaria, no terminal e no histórico
    // do shell, exatamente o vazamento que estamos fechando.
    console.log(`  id ${String(u.id).padStart(3)}  ${u.nome.padEnd(28)}  ${u.senha_hash.length} caracteres`);
  }

  if (!EXECUTAR) {
    console.log('\n── MODO CONFERÊNCIA — nada foi escrito. ──');
    console.log('Para converter de verdade:  node migracao_senhas_hash.js --executar\n');
    await pool.end();
    return;
  }

  console.log('\nConvertendo...\n');
  const c = await pool.connect();
  let feitos = 0;
  try {
    // Uma transação só: ou converte todas, ou nenhuma. Converter metade deixaria o banco
    // num estado que ninguém sabe descrever depois.
    await c.query('BEGIN');
    for (const u of rows) {
      await c.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2',
                    [await auth.hashSenha(u.senha_hash), u.id]);
      feitos++;
    }
    await c.query('COMMIT');
    console.log(`  ${feitos} senha(s) convertida(s).`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('  ERRO — nada foi convertido:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
  }

  const sobrou = await pool.query(
    `SELECT COUNT(*) AS n FROM usuarios WHERE senha_hash IS NOT NULL AND senha_hash NOT LIKE '$2%'`);
  console.log(`  Restam em texto puro: ${sobrou.rows[0].n}\n`);
  await pool.end();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
