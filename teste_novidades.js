// CAMINHO: sigpc-api/teste_novidades.js
//
// NOVIDADES DO SISTEMA (lib/novidades.js). Sem rede e sem banco.
//
// O que protege, em uma frase cada:
//   · "nao lida" se mede pelo `criado_em`, NUNCA pela `data` editorial;
//   · o recorte por publico acontece no SERVIDOR, e o superadmin ve tudo;
//   · so o superadmin publica — e no papel analista ele NAO publica;
//   · o link do Drive vira o endereco que uma <img> desenha, que nao e o do iframe.
//
// USO: node teste_novidades.js

const N = require('./lib/novidades');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

const analista = { id: 13, perfil: 'analista',         papel_ativo: 'analista' };
const tecnico  = { id: 62, perfil: 'controle_interno', papel_ativo: 'analista' };
const coord    = { id: 56, perfil: 'coordenador',      papel_ativo: 'analista' };
const saTec    = { id: 4,  perfil: 'superadmin',       papel_ativo: 'tecnico'  };
const saAna    = { id: 4,  perfil: 'superadmin',       papel_ativo: 'analista' };

console.log('\n═══ 1. QUEM VE O QUE ═══');
{
  const n = (p) => ({ id: 1, publico: p });
  conf(N.visivelPara(analista, n('todos')) === true, 'todo mundo ve a novidade geral');
  conf(N.visivelPara(analista, n('analistas')) === true, 'o analista ve a de analistas');
  conf(N.visivelPara(analista, n('coordenacao')) === false, 'e NAO ve a da coordenacao');
  conf(N.visivelPara(analista, n('controle_interno')) === false, 'nem a do C.I.');
  conf(N.visivelPara(tecnico, n('controle_interno')) === true, 'o tecnico do C.I. ve a dele');
  conf(N.visivelPara(tecnico, n('analistas')) === false, 'e nao ve a de analistas');
  conf(N.visivelPara(coord, n('coordenacao')) === true, 'o coordenador ve a da coordenacao');

  // ⚠️ O SUPERADMIN VE TODAS — e ele quem publica, e publicar sem conseguir reler seria
  // escrever no escuro.
  ['todos','analistas','controle_interno','coordenacao'].forEach(p =>
    conf(N.visivelPara(saTec, n(p)) === true, `o superadmin ve a de ${p}`));

  // ⚠️ MAS NO PAPEL ANALISTA ELE E ANALISTA — a regra unica das rotas desde 14/08. E para
  // isso que o papel existe: ver a tela como a equipe ve.
  conf(N.visivelPara(saAna, n('coordenacao')) === false,
       'no papel analista o superadmin NAO ve a da coordenacao');
  conf(N.visivelPara(saAna, n('analistas')) === true, 'e passa a ver a de analistas');

  conf(N.visivelPara(null, n('todos')) === false, 'sem usuario, ninguem ve');
  conf(N.visivelPara(analista, null) === false, 'novidade nula nao quebra');
}

console.log('\n═══ 2. QUEM PUBLICA ═══');
{
  conf(N.podePublicar(saTec) === true, 'o superadmin publica');
  conf(N.podePublicar(saAna) === false, 'no papel analista, NAO');
  conf(N.podePublicar(coord) === false, 'coordenador nao publica');
  conf(N.podePublicar(tecnico) === false, 'tecnico do C.I. tambem nao');
  conf(N.podePublicar(analista) === false, 'analista tampouco');
  conf(N.podePublicar(null) === false, 'e ninguem logado, muito menos');
}

console.log('\n═══ 3. "NOVA PARA VOCE" SAI DO criado_em, NUNCA DA data ═══');
{
  // ⚠️ ESTA E A ARMADILHA DA TELA. A `data` e EDITORIAL: o formulario deixa datar para tras,
  // e ela serve para agrupar a lista. Se a conta usasse ela, publicar HOJE algo datado de
  // semana passada nasceria JA LIDO para todo mundo — e ninguem veria justamente o que se
  // quis contar.
  const retroativa = { id: 1, data: '2026-08-10', criado_em: '2026-08-25T09:00:00Z' };
  const r = N.marcarNovas([retroativa], '2026-08-20T00:00:00Z');
  conf(r[0].nova === true,
       'novidade DATADA para tras, mas publicada hoje, e NOVA');

  const antiga = { id: 2, data: '2026-08-25', criado_em: '2026-08-10T09:00:00Z' };
  const r2 = N.marcarNovas([antiga], '2026-08-20T00:00:00Z');
  conf(r2[0].nova === false, 'e a publicada antes da ultima visita nao e nova, mesmo datada para hoje');

  // ⚠️ NULO = NUNCA ABRIU A TELA, e ai TUDO e novo. E a resposta ao "quem entra depois nunca
  // ve": o cadastro novo encontra o historico inteiro esperando por ele.
  const todas = N.marcarNovas([retroativa, antiga], null);
  conf(todas.every(x => x.nova === true), 'quem nunca abriu a tela ve TUDO como novo');

  conf(N.marcarNovas(null, null).length === 0, 'lista nula nao quebra');
}

console.log('\n═══ 4. OS CONTADORES DOS CHIPS ═══');
{
  const lista = N.marcarNovas([
    { id:1, publico:'todos',            criado_em:'2026-08-25T10:00:00Z' },
    { id:2, publico:'analistas',        criado_em:'2026-08-25T10:00:00Z' },
    { id:3, publico:'coordenacao',      criado_em:'2026-08-01T10:00:00Z' },
    { id:4, publico:'controle_interno', criado_em:'2026-08-01T10:00:00Z' },
  ], '2026-08-20T00:00:00Z');
  const c = N.contar(lista);
  conf(c.tudo === 4, 'tudo = 4');
  conf(c.novas === 2, 'novas para voce = 2');
  conf(c.analistas === 1 && c.coordenacao === 1 && c.controle_interno === 1, 'um de cada publico');
  conf(c.todos === 1, 'e a geral conta separado');
  // ⚠️ Os chips de publico + a geral fecham o total: se nao fechassem, um recorte estaria
  // escondendo novidade — e esconder e o defeito que a tela veio consertar.
  conf(c.todos + c.analistas + c.coordenacao + c.controle_interno === c.tudo,
       'os quatro publicos fecham o total');
}

console.log('\n═══ 5. O LINK DO DRIVE ═══');
{
  // ⚠️ AS QUATRO FORMAS que o Repositorio ja aceita — a EXTRACAO DO ID e o que se compartilha
  // com ele, e nao a URL final.
  conf(N.driveId('https://drive.google.com/file/d/1AbC-x_9/view?usp=sharing') === '1AbC-x_9', 'file/d/');
  conf(N.driveId('https://docs.google.com/document/d/1Doc9/edit') === '1Doc9', 'docs document/d/');
  conf(N.driveId('https://drive.google.com/drive/folders/1Pasta') === '1Pasta', 'drive/folders/');
  conf(N.driveId('https://drive.google.com/open?id=1Aberto') === '1Aberto', '?id=');
  conf(N.driveId('https://exemplo.org/foto.png') === null, 'link que nao e do Drive nao tem id');
  conf(N.driveId('') === null && N.driveId(null) === null, 'vazio e nulo nao quebram');

  // ⚠️ `thumbnail`, E NAO `/preview`. O `/preview` do Repositorio devolve uma PAGINA HTML com
  // o visualizador dentro — certo para iframe, invisivel numa <img>. Sao dois enderecos para o
  // mesmo arquivo, e o que muda e o consumidor.
  const src = N.imagemDireta('https://drive.google.com/file/d/1AbC-x_9/view');
  conf(/thumbnail\?id=1AbC-x_9/.test(src), 'a imagem vira o endereco que uma <img> desenha', src);
  conf(!/\/preview/.test(src), 'e nao o endereco de iframe');
  conf(/sz=w1600/.test(src), 'com largura pedida');
  // Link que nao e do Drive volta INTACTO: nao cabe a esta funcao recusar o que o navegador aceita.
  conf(N.imagemDireta('https://exemplo.org/foto.png') === 'https://exemplo.org/foto.png',
       'link comum passa intacto');
  conf(N.imagemDireta(null) === null, 'nulo continua nulo');
}

console.log('\n═══ 6. A VALIDACAO ═══');
{
  const bom = { titulo:'Tela nova', texto:'Agora da para ver a fila.' };
  conf(N.validar(bom) === null, 'o basico passa');
  conf(!!N.validar({ ...bom, titulo:'' }), 'titulo vazio e recusado');
  conf(!!N.validar({ ...bom, texto:'   ' }), 'texto so com espaco tambem');
  conf(!!N.validar({ ...bom, categoria:'inventada' }), 'categoria inventada e recusada');
  conf(!!N.validar({ ...bom, publico:'todo_mundo' }), 'publico inventado tambem');
  conf(N.validar({ ...bom, publico:'coordenacao' }) === null, 'publico valido passa');
  conf(!!N.validar({ ...bom, data:'25/08/2026' }), 'data em formato brasileiro e recusada');
  conf(N.validar({ ...bom, data:'2026-08-25' }) === null, 'e a do <input type=date> passa');
  conf(N.validar({ ...bom, titulo:'x'.repeat(161) }), 'titulo gigante e recusado');
  conf(N.validar(null), 'nada informado e recusado');
}

console.log('\n═══ 7. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/app\.get\('\/novidades'/.test(src), 'GET /novidades existe');
  conf(/app\.post\('\/novidades\/marcar_visto'/.test(src), 'POST /novidades/marcar_visto existe');
  // ⚠️ ROTA DE NOME FIXO ANTES DA ROTA COM :id — armadilha 13. `/novidades/marcar_visto`
  // declarada depois de um `POST /novidades/:id` cairia nela com id = "marcar_visto".
  const iM = src.indexOf("app.post('/novidades/marcar_visto'");
  const iP = src.indexOf("app.patch('/novidades/:id'");
  conf(iM > 0 && iP > 0 && iM < iP, 'e vem ANTES da rota com :id', `visto ${iM}, patch ${iP}`);

  conf(/app\.post\('\/novidades'/.test(src) && /app\.delete\('\/novidades\/:id'/.test(src),
       'publicar, editar e excluir existem');
  // ⚠️ AS TRES PASSAM PELA MESMA GUARDA, e ela le o perfil do BANCO. Esconder o botao na tela
  // nao e trava: quatro rotas deste servidor ja confiaram no `perfil` do corpo.
  const g = src.slice(src.indexOf('async function guardaNovidade'), src.indexOf('async function guardaNovidade') + 600);
  conf(/lerUsuario\(pool, \(req\.body \|\| \{\}\)\.usuario_id\)/.test(g), 'a guarda le o usuario do banco');
  conf(/nov\.podePublicar\(quem\)/.test(g), 'e usa a regra unica da lib');

  // ⚠️ O RECORTE POR PUBLICO ACONTECE NO SERVIDOR. Mandar tudo e esconder na tela deixaria a
  // novidade da coordenacao a um DevTools de distancia de qualquer analista.
  const l = src.slice(src.indexOf("app.get('/novidades'"), src.indexOf("app.post('/novidades/marcar_visto'"));
  conf(/rows\.filter\(n => nov\.visivelPara\(quem, n\)\)/.test(l), 'a lista e filtrada no servidor');
  conf(/nov\.imagemDireta\(n\.imagem_url\)/.test(l), 'e a imagem vira o endereco direto aqui, num lugar so');

  // ⚠️ `lerUsuario` PRECISA TRAZER A COLUNA. Sem ela o campo chega `undefined`, a lib le como
  // "nunca viu" e TODA novidade fica marcada como nova para sempre, sem erro para acusar.
  conf(/novidades_visto_em\s*\n?\s*FROM usuarios WHERE id = \$1/.test(src) ||
       /papel_ativo, novidades_visto_em/.test(src),
       'lerUsuario traz novidades_visto_em na projecao');

  // O DELETE por chave explicita — regra 12.
  conf(/DELETE FROM novidade WHERE id = \$1 RETURNING/.test(src), 'o DELETE e por id explicito');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
