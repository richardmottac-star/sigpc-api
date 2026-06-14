const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

// ══════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', sistema: 'SIGPC-GT API', versao: '1.0.0' });
});

// ══════════════════════════════════════
//  HELPER: montar WHERE dinâmico
// ══════════════════════════════════════
function buildWhere(filters) {
  const conditions = [];
  const values = [];
  let i = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === '') continue;
    if (typeof val === 'object' && val.op === 'ilike') {
      conditions.push(`${col} ILIKE $${i++}`);
      values.push(`%${val.val}%`);
    } else if (typeof val === 'object' && val.op === 'or_ilike') {
      const cols = val.cols.map(c => `${c} ILIKE $${i++}`);
      val.cols.forEach(() => values.push(`%${val.val}%`));
      conditions.push(`(${cols.join(' OR ')})`);
    } else if (typeof val === 'object' && val.op === 'in') {
      conditions.push(`${col} = ANY($${i++})`);
      values.push(val.vals);
    } else {
      conditions.push(`${col} = $${i++}`);
      values.push(val);
    }
  }
  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    values
  };
}

// ══════════════════════════════════════
//  USUARIOS
// ══════════════════════════════════════
app.get('/usuarios', async (req, res) => {
  try {
    const { cpf, setorial_id, perfil, ativo } = req.query;
    const filters = {};
    if (cpf) filters.cpf = cpf;
    if (setorial_id) filters.setorial_id = setorial_id;
    if (perfil) filters.perfil = perfil;
    if (ativo !== undefined) filters.ativo = ativo === 'true';
    const { where, values } = buildWhere(filters);
    const { rows } = await pool.query(`SELECT * FROM usuarios ${where} ORDER BY nome`, values);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/usuarios/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/usuarios', async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, cpf, senha_hash, perfil, setorial_id, ativo, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [b.nome, b.cpf, b.senha_hash, b.perfil, b.setorial_id, b.ativo ?? true]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/usuarios/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  SETORIAIS
// ══════════════════════════════════════
app.get('/setoriais', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM setoriais ORDER BY nome');
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  ESTOQUE
// ══════════════════════════════════════
app.get('/estoque', async (req, res) => {
  try {
    const { setorial_id, status, busca, limit = 20, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR beneficiario ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM estoque ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM estoque ${where} ORDER BY tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/estoque/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM estoque WHERE id = $1', [req.params.id]);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/estoque/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE estoque SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  PLANILHA_ANALISTA
// ══════════════════════════════════════
app.get('/planilha_analista', async (req, res) => {
  try {
    const { analista, situacao, busca, limit = 20, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (analista) { conditions.push(`analista ILIKE $${i++}`); values.push(`${analista}%`); }
    if (situacao) { conditions.push(`situacao = $${i++}`); values.push(situacao); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR beneficiario ILIKE $${i} OR processo_sgp ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM planilha_analista ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM planilha_analista ${where} ORDER BY tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/planilha_analista/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE planilha_analista SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Contagem para produtividade
app.get('/planilha_analista/baixadas/:analista', async (req, res) => {
  try {
    const nome = req.params.analista;
    const { rows } = await pool.query(
      `SELECT baixada FROM planilha_analista WHERE analista ILIKE $1`,
      [`${nome}%`]
    );
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  NOTAS_LIQUIDACAO
// ══════════════════════════════════════
app.get('/notas_liquidacao', async (req, res) => {
  try {
    const { tr, parcela, trs } = req.query;
    let rows;
    if (trs) {
      const lista = trs.split(',');
      const res2 = await pool.query(
        `SELECT * FROM notas_liquidacao WHERE tr = ANY($1) ORDER BY tr`,
        [lista]
      );
      rows = res2.rows;
    } else {
      const conditions = [];
      const values = [];
      let i = 1;
      if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
      if (parcela) { conditions.push(`parcela = $${i++}`); values.push(parcela); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const res2 = await pool.query(`SELECT * FROM notas_liquidacao ${where}`, values);
      rows = res2.rows;
    }
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  REPOSITORIO
// ══════════════════════════════════════
app.get('/repositorio', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM repositorio ORDER BY id');
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/repositorio', async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO repositorio (nome, descricao, url, tipo, setorial_id, adicionado_por)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.nome, b.descricao, b.url, b.tipo, b.setorial_id, b.adicionado_por]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  CONTADORES (dashboard)
// ══════════════════════════════════════
app.get('/contadores', async (req, res) => {
  try {
    const { setorial_id } = req.query;
    const where = setorial_id ? `WHERE setorial_id = $1` : '';
    const values = setorial_id ? [setorial_id] : [];

    const tabelas = ['estoque', 'planilha_analista', 'notas_liquidacao', 'usuarios', 'repositorio'];
    const resultado = {};
    for (const t of tabelas) {
      const r = await pool.query(`SELECT COUNT(*) FROM ${t} ${t === 'estoque' || t === 'planilha_analista' ? where : ''}`, values);
      resultado[t] = parseInt(r.rows[0].count);
    }
    res.json({ data: resultado, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});


// ══════════════════════════════════════
//  MIGRAÇÃO DE DADOS
// ══════════════════════════════════════

app.delete('/migracao/limpar-estoque', async (req, res) => {
  try {
    await pool.query("DELETE FROM estoque WHERE setorial_id = 'FCEE'");
    res.json({ ok: true, msg: 'Estoque FCEE removido' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/migracao/limpar-planilha', async (req, res) => {
  try {
    await pool.query("DELETE FROM planilha_analista WHERE setorial_id = 'FCEE'");
    res.json({ ok: true, msg: 'Planilha FCEE removida' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/migracao/estoque', async (req, res) => {
  const registros = req.body;
  if (!Array.isArray(registros) || registros.length === 0)
    return res.status(400).json({ erro: 'Body deve ser array' });
  try {
    const cols = ['tr','beneficiario','cnpj_cpf','parcela','processo_sgp','processo_mae',
                  'valor_repasse','data_limite_pc','prazo_analise','situacao',
                  'status','tecnico_nome','setorial_id','atualizado_em'];
    const vals = registros.map((r, i) => {
      const base = i * cols.length;
      return `(${cols.map((_,j) => `$${base+j+1}`).join(',')})`;
    });
    const params = registros.flatMap(r => [
      r.tr, r.beneficiario, r.cnpj_cpf, r.parcela, r.processo_sgp, r.processo_mae,
      r.valor_repasse, r.data_limite_pc, r.prazo_analise, r.situacao,
      r.status, r.tecnico_nome, r.setorial_id, new Date().toISOString(),
    ]);
    await pool.query(`INSERT INTO estoque (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
    res.json({ ok: true, inseridos: registros.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/migracao/planilha-analista', async (req, res) => {
  const registros = req.body;
  if (!Array.isArray(registros) || registros.length === 0)
    return res.status(400).json({ erro: 'Body deve ser array' });
  try {
    const cols = ['analista','setorial_id','tr','parcela','beneficiario',
                  'processo_sgp','situacao','baixada','atualizado_em'];
    const vals = registros.map((r, i) => {
      const base = i * cols.length;
      return `(${cols.map((_,j) => `$${base+j+1}`).join(',')})`;
    });
    const params = registros.flatMap(r => [
      r.analista, r.setorial_id, r.tr, r.parcela, r.beneficiario,
      r.processo_sgp, r.situacao, r.baixada, new Date().toISOString(),
    ]);
    await pool.query(`INSERT INTO planilha_analista (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
    res.json({ ok: true, inseridos: registros.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ══════════════════════════════════════
//  START
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SIGPC-GT API rodando na porta ${PORT}`);
});
