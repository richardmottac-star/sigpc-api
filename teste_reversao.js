// CAMINHO: sigpc-api/teste_reversao.js
//
// O JSON DE REVERSAO NAO PODE SER DESTRUIDO POR UMA SEGUNDA RODADA — a regra mora em
// `lib/reversao.js`, e e ela que se testa.
//
// USO: node teste_reversao.js
//
// ⚠️ SEM BANCO E SEM TOCAR NO REPOSITORIO. Os arquivos de prova nascem e morrem numa pasta
// temporaria: um teste que escrevesse na raiz apagaria justamente os arquivos que ele existe
// para proteger.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { escreverReversao } = require('./lib/reversao');

let ok = 0, falhou = 0;
const conf = (x, r, d) => { x ? ok++ : falhou++; console.log(`  ${x ? 'OK  ' : 'FALHA'}  ${r}${x || !d ? '' : `   [${d}]`}`); };
const secao = (t) => console.log(`\n=== ${t} ===`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigpc-rev-'));
const alvo = path.join(dir, 'reverter_teste_20260827.json');
const ler = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const irmaos = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

const GRAVACAO = { modo: 'gravacao', quando: '2026-08-27T10:23:00.000Z', valores_anteriores: [1, 2, 3] };
const SEGUNDA = { modo: 'gravacao', quando: '2026-08-27T10:31:00.000Z', valores_anteriores: [] };
const DRY = { modo: 'dry-run', quando: '2026-08-27T09:57:00.000Z', valores_anteriores: [1, 2, 3] };

secao('1. O CAMINHO NORMAL — o arquivo nao existe');
{
  const r = escreverReversao(alvo, GRAVACAO);
  conf(r.caminho === alvo, 'escreve no nome pedido');
  conf(r.preservou === null, 'e nao preserva nada, porque nao havia nada');
  conf(ler(alvo).valores_anteriores.length === 3, 'o conteudo esta la');
}

secao('2. O DEFEITO DE 27/08 — a segunda gravacao NAO apaga a primeira');
{
  const r = escreverReversao(alvo, SEGUNDA);
  // ⚠️ ESTE E O TESTE QUE IMPORTA. Sem a protecao, `alvo` passaria a ter
  // `valores_anteriores: []` e as 3.466 chaves do caminho de volta sumiriam em silencio.
  conf(r.caminho !== alvo, 'a segunda rodada escreve AO LADO, nao por cima');
  conf(r.preservou === alvo, 'e diz o que preservou');
  conf(ler(alvo).valores_anteriores.length === 3, 'o arquivo ORIGINAL continua com as 3 chaves');
  conf(ler(alvo).quando === GRAVACAO.quando, 'e continua sendo o da primeira rodada');
  conf(ler(r.caminho).valores_anteriores.length === 0, 'o novo tem o conteudo da segunda');
  conf(r.caminho.includes('2026-08-27T10-31-00-000Z'),
       'o nome do novo carrega o `quando` da rodada nova', r.caminho);
  conf(irmaos().length === 2, 'ficaram DOIS arquivos', irmaos().join(' · '));
}

secao('3. DRY-RUN PODE SOBRESCREVER DRY-RUN');
{
  const d = path.join(dir, 'reverter_teste_20260827_DRYRUN.json');
  escreverReversao(d, DRY);
  const r = escreverReversao(d, { ...DRY, quando: '2026-08-27T11:00:00.000Z' });
  // Um dry-run nao e prova de nada — ele nao gravou. Preservar cada um encheria a pasta de
  // arquivos que ninguem vai ler.
  conf(r.caminho === d, 'o segundo dry-run escreve por cima do primeiro');
  conf(r.preservou === null, 'sem preservar');
  conf(ler(d).quando === '2026-08-27T11:00:00.000Z', 'e o conteudo e o do segundo');
}

secao('4. GRAVACAO POR CIMA DE DRY-RUN — pode');
{
  const d = path.join(dir, 'reverter_misto.json');
  escreverReversao(d, DRY);
  const r = escreverReversao(d, GRAVACAO);
  conf(r.caminho === d && r.preservou === null, 'a gravacao ocupa o nome que era de um dry-run');
  conf(ler(d).modo === 'gravacao', 'e o arquivo passa a ser o da gravacao');
}

secao('5. ARQUIVO ILEGIVEL TAMBEM E PRESERVADO');
{
  const p = path.join(dir, 'reverter_corrompido.json');
  fs.writeFileSync(p, '{ isto nao e json', 'utf8');
  const r = escreverReversao(p, GRAVACAO);
  // ⚠️ Se nao da para saber o que o arquivo era, nao da para saber que sobrescreve-lo e
  // seguro — e o caso em que ele importa e o caso em que algo ja deu errado.
  conf(r.caminho !== p, 'escreve ao lado');
  conf(r.preservou === p, 'e preserva o ilegivel');
  conf(/nao pode ser lido/.test(r.motivo || ''), 'dizendo por que', r.motivo);
  conf(fs.readFileSync(p, 'utf8') === '{ isto nao e json', 'o ilegivel continua intacto');
}

secao('6. COLISAO DE NOME — numera em vez de sobrescrever');
{
  const p = path.join(dir, 'reverter_colisao.json');
  escreverReversao(p, GRAVACAO);
  const r1 = escreverReversao(p, SEGUNDA);
  const r2 = escreverReversao(p, SEGUNDA);   // MESMO `quando` -> mesmo nome candidato
  conf(r1.caminho !== r2.caminho, 'duas rodadas com o mesmo carimbo nao colidem');
  conf(/_2\.json$/.test(r2.caminho), 'a segunda ganha sufixo _2', r2.caminho);
  conf(ler(p).valores_anteriores.length === 3, 'e o original segue intacto');
}

secao('7. SEM `quando` NO CONTEUDO');
{
  const p = path.join(dir, 'reverter_sem_quando.json');
  escreverReversao(p, { modo: 'gravacao', valores_anteriores: [9] });
  const r = escreverReversao(p, { modo: 'gravacao', valores_anteriores: [] });
  // Cai no relogio em vez de explodir: um `undefined` no nome do arquivo daria
  // "reverter_undefined.json", e a segunda rodada sobrescreveria a segunda rodada.
  conf(r.preservou === p, 'ainda preserva');
  conf(!/undefined/.test(r.caminho), 'e o nome nao vira "undefined"', r.caminho);
  conf(ler(p).valores_anteriores.length === 1, 'o original continua la');
}

secao('8. OS TRES SCRIPTS DE 27/08 USAM A LIB');
{
  for (const f of ['migracao_data_baixa_sigef_20260827.js',
                   'migracao_sigef_status_20260827.js',
                   'migracao_sigef_declaracao_20260827.js']) {
    const src = fs.readFileSync('./' + f, 'utf8');
    conf(/require\('\.\/lib\/reversao'\)/.test(src), `${f} importa a lib`);
    // ⚠️ E NAO SOBROU `writeFileSync` NO ARQUIVO DE REVERSAO. E o ponto exato do defeito: a
    // protecao nao serve de nada se o caminho antigo continuar existindo ao lado dela.
    conf(!/writeFileSync\(ARQ_REVERSAO/.test(src), `${f} nao escreve a reversao direto`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
process.exit(falhou ? 1 : 0);
