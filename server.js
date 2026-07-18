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
    const conditions = [];
    const values = [];
    let i = 1;
    if (cpf) { conditions.push(`cpf = $${i++}`); values.push(cpf); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (perfil) { conditions.push(`perfil = $${i++}`); values.push(perfil); }
    if (ativo !== undefined) { conditions.push(`ativo = $${i++}`); values.push(ativo === 'true'); }
    // Suporte a _gte_ultimo_acesso para "online agora"
    const gteUltimoAcesso = req.query['_gte_ultimo_acesso'];
    if (gteUltimoAcesso) { conditions.push(`ultimo_acesso >= $${i++}`); values.push(gteUltimoAcesso); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
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
    const { setorial_id, status, busca, tr, parcela, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (parcela) { conditions.push(`parcela = $${i++}`); values.push(parcela); }
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
    const { analista, setorial_id, situacao, busca, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (analista) { conditions.push(`analista ILIKE $${i++}`); values.push(`${analista}%`); }
    if (situacao) { conditions.push(`situacao = $${i++}`); values.push(situacao); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR beneficiario ILIKE $${i} OR processo_sgp ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM planilha_analista ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM planilha_analista ${where} ORDER BY analista, tr LIMIT $${i++} OFFSET $${i++}`,
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


// POST /planilha_analista — inserir registro (usado ao assumir TR)
app.post('/planilha_analista', async (req, res) => {
  try {
    const b = req.body;
    const cols = Object.keys(b);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map(k => b[k]);
    const { rows } = await pool.query(
      `INSERT INTO planilha_analista (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Rota dedicada: grupos por analista (para produtividade)
app.get('/estoque/grupos-analistas', async (req, res) => {
  try {
    const { setorial_id } = req.query;
    const where = setorial_id ? 'WHERE setorial_id = $1 AND tecnico_nome IS NOT NULL' : 'WHERE tecnico_nome IS NOT NULL';
    const values = setorial_id ? [setorial_id] : [];
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (tecnico_nome) tecnico_nome, grupo FROM estoque ${where} ORDER BY tecnico_nome, grupo`,
      values
    );
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Rota planilha com JOIN no estoque (para Minha Planilha completa)
app.get('/planilha_analista/completa', async (req, res) => {
  try {
    const { analista, setorial_id, situacao, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (setorial_id) { conditions.push(`p.setorial_id = $${i++}`); values.push(setorial_id); }
    if (analista) { conditions.push(`p.analista ILIKE $${i++}`); values.push(`${analista}%`); }
    if (situacao) { conditions.push(`p.situacao = $${i++}`); values.push(situacao); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM planilha_analista p ${where}`, values
    );
    const { rows } = await pool.query(
      `SELECT p.*, 
        e.beneficiario AS entidade,
        e.processo_sgp AS sgpe,
        e.processo_mae,
        e.valor_repasse,
        e.grupo
       FROM planilha_analista p
       LEFT JOIN estoque e ON e.tr = p.tr AND e.parcela = p.parcela AND e.setorial_id = p.setorial_id
       ${where}
       ORDER BY p.tr, p.parcela
       LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
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
// GET /notas_liquidacao?tr=X&parcela=Y&baixada=true&limit=1&setorial_id=FCEE&trs=A,B,C
app.get('/notas_liquidacao', async (req, res) => {
  try {
    const { tr, parcela, trs, baixada, limit, setorial_id } = req.query;
    if (trs) {
      const lista = trs.split(',');
      const { rows } = await pool.query(
        `SELECT * FROM notas_liquidacao WHERE tr = ANY($1) ORDER BY tr`,
        [lista]
      );
      return res.json({ data: rows, count: rows.length, error: null });
    }
    const conditions = [];
    const values = [];
    let i = 1;
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (parcela) { conditions.push(`parcela = $${i++}`); values.push(parseInt(parcela)); }
    if (baixada !== undefined) { conditions.push(`baixada = $${i++}`); values.push(baixada === 'true'); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    let sql = `SELECT * FROM notas_liquidacao ${where} ORDER BY parcela, codigo_nl`;
    if (limit) { sql += ` LIMIT $${i++}`; values.push(parseInt(limit)); }
    const { rows } = await pool.query(sql, values);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, count: 0, error: { message: e.message } });
  }
});

// PATCH /notas_liquidacao/baixar-parcela — baixa TODAS NLs de um TR+PARCELA
// (precisa vir antes de /:id, senão "baixar-parcela" seria capturado como id)
app.patch('/notas_liquidacao/baixar-parcela', async (req, res) => {
  try {
    const { tr, parcela, baixada } = req.body;
    if (!tr || parcela === undefined)
      return res.status(400).json({ error: { message: 'tr e parcela são obrigatórios' } });
    const { rows, rowCount } = await pool.query(
      `UPDATE notas_liquidacao SET baixada = $1, atualizado_em = NOW()
       WHERE tr = $2 AND parcela = $3 RETURNING *`,
      [baixada !== false, tr, parseInt(parcela)]
    );
    res.json({ data: rows, count: rowCount, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /notas_liquidacao/:id
app.patch('/notas_liquidacao/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const campos = req.body;
    const sets = [];
    const params = [];
    let p = 1;
    const permitidos = ['baixada', 'situacao_pc', 'setorial_id'];
    permitidos.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${p++}`);
        params.push(campos[c]);
      }
    });
    sets.push(`atualizado_em = NOW()`);
    params.push(parseInt(id));
    const sql = `UPDATE notas_liquidacao SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`;
    const { rows } = await pool.query(sql, params);
    res.json({ data: rows[0], error: null });
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
//  PRESTACOES_CONTAS (SIGPC-GT)
// ══════════════════════════════════════
app.get('/prestacoes_contas', async (req, res) => {
  try {
    const {
      tr, codigo_pc, codigo_nl, analista_id, analista_nome, grupo,
      status, baixada, setorial_id, conflito, estornada, limit = 9999, offset = 0
    } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (codigo_pc) { conditions.push(`codigo_pc = $${i++}`); values.push(codigo_pc); }
    if (codigo_nl) { conditions.push(`codigo_nl = $${i++}`); values.push(codigo_nl); }
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (analista_nome) { conditions.push(`analista_nome = $${i++}`); values.push(analista_nome); }
    if (grupo) { conditions.push(`grupo = $${i++}`); values.push(parseInt(grupo)); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (baixada !== undefined) { conditions.push(`baixada = $${i++}`); values.push(baixada === 'true'); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (conflito !== undefined) { conditions.push(`conflito = $${i++}`); values.push(conflito === 'true'); }
    if (estornada !== undefined) { conditions.push(`estornada = $${i++}`); values.push(estornada === 'true'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM prestacoes_contas ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM prestacoes_contas ${where} ORDER BY tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/resumo_tr?analista_id=X&setorial_id=X&busca=X — agrupado por TR
app.get('/prestacoes_contas/resumo_tr', async (req, res) => {
  try {
    const { analista_id, setorial_id, busca } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR entidade ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT tr, MAX(entidade) AS entidade, MAX(analista_nome) AS analista_nome,
              COUNT(*) AS total_pcs,
              COUNT(DISTINCT codigo_nl) AS total_nls,
              COUNT(*) FILTER (WHERE baixada) AS baixadas,
              array_agg(DISTINCT status) AS status
       FROM prestacoes_contas
       ${where}
       GROUP BY tr
       ORDER BY tr`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/nl_compartilhada?codigo_nl=X — PCs que compartilham a NL
app.get('/prestacoes_contas/nl_compartilhada', async (req, res) => {
  try {
    const { codigo_nl } = req.query;
    if (!codigo_nl)
      return res.status(400).json({ data: null, error: { message: 'codigo_nl é obrigatório' } });
    const { rows } = await pool.query(
      `SELECT * FROM prestacoes_contas WHERE codigo_nl = $1 ORDER BY tr`,
      [codigo_nl]
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/produtividade?corte=YYYY-MM-DD&analista_id=X
app.get('/prestacoes_contas/produtividade', async (req, res) => {
  try {
    const { corte, analista_id } = req.query;
    if (!corte)
      return res.status(400).json({ data: null, error: { message: 'corte é obrigatório' } });
    const conditions = ['data_baixa <= $1', '(estornada = false OR data_estorno > $1)'];
    const values = [corte];
    let i = 2;
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    const where = 'WHERE ' + conditions.join(' AND ');
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM prestacoes_contas ${where}`,
      values
    );
    res.json({ data: { total: parseInt(rows[0].count) }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/baixar — body { codigos_pc: [], parecer_tipo, analista_id, registrado_por, override }
app.patch('/prestacoes_contas/baixar', async (req, res) => {
  try {
    const { codigos_pc, parecer_tipo, analista_id, registrado_por, override } = req.body;
    if (!Array.isArray(codigos_pc) || codigos_pc.length === 0)
      return res.status(400).json({ data: null, error: { message: 'codigos_pc é obrigatório' } });
    const params = [parecer_tipo, registrado_por, codigos_pc];
    let where = 'codigo_pc = ANY($3)';
    if (override !== true) {
      params.push(analista_id);
      where += ' AND analista_id = $4';
    }
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET baixada = true, data_baixa = NOW(), origem_baixa = 'sistema', status = 'baixada',
           parecer_tipo = $1, registrado_por = $2, atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/estornar — body { codigos_pc: [], motivo, usuario_id, usuario_nome, perfil, grupo }
app.patch('/prestacoes_contas/estornar', async (req, res) => {
  try {
    const { codigos_pc, motivo, usuario_id, usuario_nome, perfil, grupo } = req.body;
    if (!Array.isArray(codigos_pc) || codigos_pc.length === 0)
      return res.status(400).json({ data: null, error: { message: 'codigos_pc é obrigatório' } });
    if (!motivo || motivo.trim().length < 15)
      return res.status(400).json({ data: null, error: { message: 'motivo deve ter no mínimo 15 caracteres' } });

    const params = [motivo, usuario_nome, codigos_pc];
    let where = 'codigo_pc = ANY($3)';
    if (perfil === 'analista') {
      params.push(usuario_id);
      where += ` AND analista_id = $${params.length}`;
    } else if (perfil === 'coordenador') {
      params.push(parseInt(grupo));
      where += ` AND grupo = $${params.length}`;
    } else if (perfil !== 'master') {
      return res.status(403).json({ data: null, error: { message: 'perfil não autorizado a estornar' } });
    }

    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET estornada = true, data_estorno = NOW(), status = 'analise', baixada = false,
           motivo_estorno = $1, estornado_por = $2, atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/:codigo_pc — atualização pontual (ex: assumir TR)
// precisa vir depois de /baixar e /estornar, senão "baixar"/"estornar" seriam capturados como codigo_pc
app.patch('/prestacoes_contas/:codigo_pc', async (req, res) => {
  try {
    const campos = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    const permitidos = ['analista_nome', 'analista_id', 'status'];
    permitidos.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${i++}`);
        values.push(campos[c]);
      }
    });
    if (sets.length === 0)
      return res.status(400).json({ data: null, error: { message: 'nenhum campo permitido informado' } });
    sets.push(`atualizado_em = NOW()`);
    values.push(req.params.codigo_pc);
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas SET ${sets.join(', ')} WHERE codigo_pc = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  ANOTACOES_TR
// ══════════════════════════════════════
app.get('/anotacoes_tr', async (req, res) => {
  try {
    const { tr } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM anotacoes_tr ${where} ORDER BY criado_em DESC`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/anotacoes_tr', async (req, res) => {
  try {
    const { tr, analista_id, analista_nome, texto } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO anotacoes_tr (tr, analista_id, analista_nome, texto)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tr, analista_id, analista_nome, texto]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// DELETE /anotacoes_tr/:id — só apaga se analista_id do body bater com o do registro
app.delete('/anotacoes_tr/:id', async (req, res) => {
  try {
    const { analista_id } = req.body;
    const { rows } = await pool.query(
      `DELETE FROM anotacoes_tr WHERE id = $1 AND analista_id = $2 RETURNING *`,
      [req.params.id, analista_id]
    );
    if (rows.length === 0)
      return res.status(403).json({ data: null, error: { message: 'Não autorizado ou anotação não encontrada' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  START
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SIGPC-GT API rodando na porta ${PORT}`);
});
