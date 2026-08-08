# Link direto para processo no SGPe — referência para a SKILL

Levantado em 08/08/2026 do `sigpc-api`, em produção. Somente leitura: nada foi alterado.
Destino: SKILL reusável por Richard e Igor em outros sistemas.

---

## O AVISO QUE ABRE TUDO

**Não existe fórmula.** O número que vai na URL (`nuProcesso`) **não** é o número que aparece
na tela (`nuProcessooficial`). A diferença é o acúmulo de buracos de numeração (processos
cancelados) dentro de cada órgão+ano — cresce sempre, em degraus imprevisíveis.

Medido em 08/08/2026 sobre **7.699 pares reais** do acervo da FCEE:

```
deslocamento mínimo:    0
deslocamento máximo:  171
média:                  9
```

Exemplos: `FCEE 390/2019 → 391` (+1) · `FCEE 5830/2019 → 5950` (+120) ·
`SDR18 6140/2013 → 6182` (+42) · `SES 135960/2025 → 137111` (+1151).

**Nunca calcular, estimar, interpolar nem reaproveitar o deslocamento de um vizinho.**
Um número errado NÃO dá erro: abre OUTRO processo, em silêncio. A conversão é sempre por
consulta ao SGPe, e o resultado vai para cache.

---

## 6. A URL, LITERAL

```js
function montarUrlSgpe(nuProcesso, cdOrgaosetor, ano) {
  return 'https://sgpe.sea.sc.gov.br/cpav/visualizarDocumentosProcesso.do'
    + '?processoPK=' + nuProcesso + ',' + cdOrgaosetor + ',' + ano + '&itemAba=aba_pecas';
}
```

Exemplo real:

```
https://sgpe.sea.sc.gov.br/cpav/visualizarDocumentosProcesso.do?processoPK=5950,4267,2019&itemAba=aba_pecas
```

**A aba PEÇAS é a única que funciona como link colado no navegador.** A de Processo
(`visualizarProcesso.do`) só funciona navegando dentro da sessão: colada direto, o SGPe
redireciona para a tela de consulta.

Tramitações usa outro estilo de parâmetros, não o `processoPK` composto — registrado por ter
sido verificado, mas não serve como link direto:

```
visualizarTramitacaoProcesso.do?entity.processoPK.cdOrgaosetor=7059
  &entity.processoPK.nuAno=2025&entity.processoPK.nuProcesso=137111&itemAba=aba_tramitacoes
```

---

## 1. `lib/sgpe-link.js` — parte pura

Não faz rede, não toca banco. É o que permite testar tudo sem sessão do SGPe.

### A regex, literal

```js
const PADRAO = /^\s*([A-Za-z]{2,12})(?:([0-9]{1,2})[\s.\-]+|([\s.\-]*))(\d{1,20})\s*\/\s*(\d{4})\s*$/;
```

Os dois caminhos do meio são a regra inteira:

| grupo | significado |
|---|---|
| `m[1]` | letras da sigla (2 a 12) |
| `m[2]` | dígitos da região — **só casa com separador obrigatório depois** |
| `m[3]` | separador opcional, quando não há região |
| `m[4]` | número, **cru**, com zeros à esquerda |
| `m[5]` | ano, 4 dígitos |

Separadores aceitos: espaço, ponto, hífen (`[\s.\-]`).

### A trava de ambiguidade, literal

```js
// ⚠️ TRAVA — NÃO REMOVER. Texto colado em que a sigla sozinha não é órgão, mas
// sigla + 2 primeiros dígitos é: "ADR223151/2017" (ADR não é órgão, ADR22 é) e
// "SDR05001028/2017" (SDR não é órgão, SDR05 é).
if (regiao === undefined && separador === ''
    && !ORGAOS[letras] && ORGAOS[letras + crus.slice(0, 2)]) {
  return null;
}

// Só agora os zeros à esquerda saem.
const numero = crus.replace(/^0+/, '');
if (numero === '' || numero.length > 8) return null;
```

**Por que existe:** `"ADR223151/2017"` pode ser região 22 processo 3151 **ou** região 2
processo 23151. Não dá para saber. Chutar geraria link para um processo REAL porém ERRADO,
em silêncio — pior que não gerar link.

**Duas sutilezas que já causaram bug:**

1. A trava avalia `crus` (com zeros à esquerda), **nunca** o número já limpo. Antes os zeros
   saíam primeiro e a trava recebia `"5001028"`, comparando com `SDR50` (inexistente) em vez
   de `SDR05` (que é órgão) — não disparava, e só não virava link errado por acidente.
2. A regra sai do **mapa**, não de sigla chumbada. Se um dia entrar uma chave `XXX05`, todo
   `"XXX05.../ANO"` colado passa a ser rejeitado sozinho, sem tocar no código.

**O inverso também importa:** a maioria do acervo é sigla SEM região colada ao número —
`"SCC2146/2020"`, `"FCEE264/2017"`, `"SED75922/2024"` (~6.000 processos). Por isso os dígitos
só migram para a sigla quando há separador.

### `SIGLAS_AMBIGUAS` e `SIGLAS_INEXISTENTES`, literal

```js
// Siglas que o cadastro do SGPe devolve com DOIS órgãos. Não dá para escolher sozinho — quem
// resolve é uma pessoa, definindo a sigla na tabela acima.
const SIGLAS_AMBIGUAS = ['DC', 'SAN', 'SAP', 'SAS', 'SC'];

// Sigla que não existe no SGPe, mas aparece na base.
const SIGLAS_INEXISTENTES = ['SSC'];
```

⚠️ **Incoerência conhecida, mantida de propósito:** `DC`, `SAN`, `SAP` e `SAS` estão **nas
duas listas** — em `SIGLAS_AMBIGUAS` e no mapa `ORGAOS`. Resultado: `siglaConhecida()`
devolve `true` e `orgaoDaSigla()` lança `SiglaAmbigua`. Não quebra (o chamador captura), mas
é incoerente. Decisão expressa de 06/08 foi manter intacto. **No acervo da FCEE não há
nenhuma ocorrência dessas siglas** — conferido em 08/08.

### O mapa `ORGAOS`

**183 pares** sigla → `cdOrgaosetor`, conferidos no cadastro do SGPe. Sigla fora dele é erro,
nunca chute. Formato:

```js
const ORGAOS = {
  APSFS: 45, SANTUR: 6949, ADR01: 13265, ADR02: 13287, /* ... */
  FCEE: 4267, SCC: 10068, SED: 7054, SES: 7059, SEA: 7000,
  SDR01: 6994, SDR02: 6992, /* ... */ SDR36: 7027,
  ADR35: 13710, 'CMDO-G': 2338, SAPIENS_EXTERNO_INAT: 15073,
};
```

**Regionais entram com a região colada na sigla** — `ADR20`, `SDR13` — porque cada uma é um
órgão distinto no SGPe, com `cdOrgaosetor` próprio. Só há chaves de **dois dígitos**: `"ADR7"`
não resolve e o processo fica sem link, que é o resultado seguro (completar o zero seria
adivinhar).

⚠️ **Este mapa existe em DUAS cópias** que precisam andar juntas:
`sigpc-api/lib/sgpe-link.js` e `segov-sistema/nextjs_space/lib/sgpe-link.ts`.
(Havia uma terceira, `sigpc-gt/sgpe-link-standalone.js`, removida em 08/08.)
**Para a SKILL, o ideal é a cópia única virar pacote.**

### Funções exportadas, literal

```js
module.exports = {
  PADRAO,                  // a regex
  ORGAOS,                  // 183 pares sigla -> cdOrgaosetor
  SIGLAS_AMBIGUAS,
  SIGLAS_INEXISTENTES,

  ProcessoInvalido,        // erros — sigla que não resolve é ERRO, nunca chute silencioso
  SiglaDesconhecida,
  SiglaAmbigua,
  ProcessoNaoEncontrado,
  SessaoExpirada,

  normalizarProcesso,      // (bruto) -> {sigla, numero, ano} | null   NUNCA lança
  normalizarPartes,        // (sigla, numero, ano) -> idem; passa pela MESMA regex
  formatarProcesso,        // (p) -> "SCC 8855/2025"  (forma canônica)
  orgaoDaSigla,            // (sigla) -> cdOrgaosetor; LANÇA se ambígua/desconhecida
  siglaConhecida,          // (sigla) -> boolean
  montarUrlSgpe,           // (nuProcesso, cdOrgaosetor, ano) -> url
};
```

`normalizarProcesso` devolve `null` — nunca lança — para o que não é processo. A base tem
muito valor que não pode virar link:

```
"Aguardando protocolo" · "-" · "Pendência" · "/2025" · "SDC" (sem número) ·
"SCC 6579" (sem ano) · "SCC 7229 2024" (sem barra) · "9223/2026" (sem sigla) · vazio
```

Exportação dupla, sem bundler e sem build:

```js
raiz.SgpeLink = api;                                    // window.SgpeLink no navegador
if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node
```

---

## 2. `lib/sgpe-dwr.js` — a consulta ao SGPe

Só no servidor. É a única forma correta de obter o `nuProcesso`.

### Endpoint

```js
const ENDPOINT = 'https://sgpe.sea.sc.gov.br/cpav/dwr/exec';
```

### O payload, literal

`POST`, `Content-Type: text/plain`, uma diretiva por linha terminando em `\n`:

```js
function corpoDaChamada(p, cdOrgaosetor) {
  return [
    'callCount=1',
    'c0-scriptName=FormatadorDWR',
    'c0-methodName=getProcesso1',
    'c0-id=0',
    'c0-param0=string:P',
    `c0-param1=string:${p.ano}`,
    `c0-param2=string:${String(p.numero).padStart(8, '0')}`,   // zfill de 8!
    `c0-param3=string:${cdOrgaosetor}`,
    'c0-param4=string:PC',
    'c0-param5=string:',
    'c0-param6=boolean:false',
    'c0-param7=boolean:true',
    'xml=true',
    '',
  ].join('\n');
}
```

⚠️ **`param2` vai com 8 dígitos, zero-preenchido.**

### ⚠️ COOKIE É OPCIONAL

```js
const cookie = process.env.SGPE_COOKIE;   // opcional
const r = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', ...(cookie ? { cookie } : {}) },
  body: corpoDaChamada(p, cdOrgaosetor),
  cache: 'no-store',
});
```

O endpoint DWR **responde sem cookie de sessão** — verificado ao vivo em 03/08/2026 e
confirmado em volume em 08/08 (7.317 consultas, zero erros, sem `SGPE_COOKIE` definida).

No `segov-sistema` essa variável já foi obrigatória, e como nunca existiu no ambiente do
Railway a consulta lançava `SessaoExpirada` 100% das vezes. **Não tornar obrigatório.**

### O que volta

**Não é JSON.** É um script DWR:

```js
var s0={}
var s10=8855
s0['nuProcessooficial']=s10
var s16=8856
s0['nuProcesso']=s16
DWREngine._handleResponse('0', s0)
```

O parser monta dois dicionários e cruza. **Não depende dos índices `s10`/`s16`** — eles mudam
a cada resposta:

```js
function lerRespostaDwr(corpo) {
  const variaveis = {};
  for (const m of corpo.matchAll(/var\s+(s\d+)\s*=\s*("?)([^";\n]*)\2/g)) variaveis[m[1]] = m[3];
  const propriedades = {};
  for (const m of corpo.matchAll(/s0\['([^']+)'\]\s*=\s*(s\d+)/g)) propriedades[m[1]] = m[2];
  const saida = {};
  for (const [nome, ref] of Object.entries(propriedades)) if (ref in variaveis) saida[nome] = variaveis[ref];
  return saida;
}
```

### As quatro validações obrigatórias

```js
// 1. Sessão caída: o SGPe devolve a tela de login em vez do script.
if (/<html/i.test(corpo) || !/s0\s*=/.test(corpo)) throw new SessaoExpirada(...);

// 2. Parâmetros recusados.
if (/Error converting parameters/i.test(corpo)) throw new Error(...);

// 3. size = 0 significa que o processo NÃO existe.
//    Caso real: SCC 18870/2026 não existe (o que existe é SCC 18870/2025).
//    Sem esta checagem, geraríamos um link para o nada.
if (campos.size !== undefined && Number(campos.size) === 0) throw new ProcessoNaoEncontrado(...);

// 4. Conferência de sanidade: o número oficial que voltou tem de ser o que foi perguntado.
//    Se divergir, a resposta é de outro processo e o link levaria ao lugar errado.
const oficial = Number(campos.nuProcessooficial);
if (Number.isFinite(oficial) && oficial !== p.numero) throw new ProcessoNaoEncontrado(...);
```

Retorno: `{ nuProcesso, cdOrgaosetor, ano }` — o `cdOrgaosetor` da resposta tem precedência
sobre o do mapa, quando vier válido.

### Retentativa

`resolverNoSgpe(p, tentativas = 3)`. Só **5xx** merece nova tentativa; 4xx é problema nosso.
Backoff `400 * (i + 1)` ms. `ProcessoNaoEncontrado` e `SessaoExpirada` sobem na hora.

**Sequencial, um por vez.** O SGPe é sistema de terceiro. Ritmo medido em rajada contínua:
**0,35 s por processo**; pelo uso da tela (com pausas), 0,59 s.

---

## 3. `lib/sgpe-lote.js` — o que faz

Traduz uma lista de valores **crus** em links prontos, lendo **só o cache**. Nunca consulta o
SGPe. É a peça única compartilhada pelas rotas HTTP e pelo job — existe para a regra de
normalização ter **um dono**.

| função | assinatura | o que faz |
|---|---|---|
| `chavesDeValores` | `(valores[]) -> Map<bruto, {sigla,numero,ano}>` | normaliza e descarta o que não é processo |
| `montarLinks` | `async (db, valores[]) -> {links, semLink}` | consulta o cache, devolve os links montados |
| `linksDeLinhas` | `async (db, linhas[], campos[]) -> links` | atalho: colhe campos das linhas |
| `gravarResolvido` | `async (db, p, r)` | grava sucesso |
| `gravarNegativa` | `async (db, p, motivo)` | grava "o SGPe não tem" |
| `gravarErro` | `async (db, p, motivo)` | grava falha de rede (provisório) |

### ⚠️ A CHAVE DO MAPA É O VALOR CRU

```js
links["SCC2146/2020"]         -> "https://sgpe.sea.sc.gov.br/..."
links["ADR20 00001233/2017"]  -> "https://sgpe.sea.sc.gov.br/..."
```

**Não** é a forma canônica. É a decisão de projeto mais importante do conjunto: com chave
crua, o front faz `links[linha.processo_pc]` e **não precisa da regex**. Foi a divergência
entre a regex do front e a do servidor que produziu o bug silencioso de 05-06/08 (ADR deixou
de linkar sem nada dar erro).

Custo: duas grafias do mesmo processo viram duas entradas apontando para a mesma URL
(54 casos em 7.700 no acervo da FCEE). Irrelevante.

**Para a SKILL: comece por aqui.** Chave canônica obriga o consumidor a normalizar, e aí a
regra nasce duplicada.

### A query, literal

```sql
SELECT sigla, numero_oficial, ano, nu_processo, cd_orgaosetor
  FROM sgpe_processo_ref
 WHERE nu_processo IS NOT NULL
   AND (sigla, numero_oficial, ano)
       IN (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]))
```

`unnest` de três arrays em vez de 3N placeholders — 2 mil processos virariam 6 mil parâmetros.

Dupla barreira contra a negativa (o `WHERE` **e** um `continue` no laço): montar
`processoPK=null,null,ano` seria uma URL que existe e não dá erro — o pior resultado possível.

### Precedência entre estados — a regra que importa

```
CONFERIDO       (à mão)                      nada sobrescreve
SGPE            (resolvido)                  só CONFERIDO sobrescreve
NAO_ENCONTRADO  (o SGPe disse que não tem)   só um sucesso posterior sobrescreve
ERRO            (rede/transporte)            provisório, qualquer definitivo sobrescreve
```

Implementada com `ON CONFLICT ... DO UPDATE ... WHERE`:

```sql
INSERT INTO sgpe_processo_ref
  (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, tentativas, ultima_tentativa, motivo)
VALUES ($1, $2, $3, $4, $5, 'SGPE', 1, NOW(), NULL)
ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
   SET nu_processo      = EXCLUDED.nu_processo,
       cd_orgaosetor    = EXCLUDED.cd_orgaosetor,
       origem           = 'SGPE',
       tentativas       = sgpe_processo_ref.tentativas + 1,
       ultima_tentativa = NOW(),
       motivo           = NULL
 WHERE sgpe_processo_ref.origem <> 'CONFERIDO'
```

A negativa troca o guarda por `NOT IN ('CONFERIDO','SGPE')`; o erro, por
`NOT IN ('CONFERIDO','SGPE','NAO_ENCONTRADO')`.

---

## 4. `job_sgpe_links.js` — parâmetros e execução

Único lugar que consulta o SGPe em volume. Processo **separado** — nunca no boot do servidor.

### Parâmetros

| flag | efeito |
|---|---|
| `--dry-run` | mostra a fila e não toca em nada (nem rede, nem banco) |
| `--limite=N` | processa N e para; o resto fica para a próxima. **É o que o torna incremental** |
| `--somente-novos` | só o que nunca foi tentado — uso no fim de carga |
| `--retentar-erros` | força os que falharam por rede, ignorando recuo e teto |
| `--pausa=N` | espera N ms entre processos (padrão 0) |

Também chamável como módulo, reaproveitando a conexão de quem chamou:

```js
const { rodar } = require('./job_sgpe_links')
await rodar({ pool, somenteNovos: true, limite: 500 })
```

`opts.resolver` existe para injetar um resolvedor falso **em teste** — em produção é sempre a
consulta real.

### O ciclo

1. `SELECT DISTINCT processo_pc, processo_mae FROM prestacoes_contas` (UNION)
2. normaliza com `chavesDeValores` — a trava de ambiguidade vale aqui também
3. lê a tabela de cache inteira (é pequena) e monta a fila
4. resolve **sequencialmente**, gravando sucesso / negativa / erro
5. loga a cada 25, com ritmo real e ETA recalculada

### As três defesas

```js
const MAX_TENTATIVAS     = 5;                      // desiste do processo depois de 5 falhas de rede
const RECUO_MINUTOS      = [15, 60, 360, 1440];    // 15min · 1h · 6h · 24h entre tentativas
const MAX_ERROS_SEGUIDOS = 10;                     // DISJUNTOR: aborta a rodada inteira
```

**O disjuntor é o que permite rodar sem supervisão.** Erro isolado segue adiante; 10 em série
é o SGPe fora do ar, e insistir só marca milhares de linhas como `ERRO` e infla `tentativas`.
Rodada abortada não custa nada — o que ficou volta na próxima.

⚠️ **`naoEncontrado` NÃO conta para o disjuntor.** É o SGPe respondendo, e respondendo certo.
Um lote inteiro de processos inexistentes não pode ser confundido com queda.

`SessaoExpirada` derruba a rodada na hora. `SIGINT` (Ctrl+C) encerra depois do processo
corrente, sem escrita pela metade.

### Como roda em produção

Serviço separado no Railway, de hora em hora:

```
node job_sgpe_links.js --limite=200
```

Resultado da carga completa (08/08/2026, FCEE):

```
resolvidos .............. 7.311
não encontrados ......... 6
erros de rede ........... 0
tempo ................... 42min 5s   (0,35 s por processo)
```

---

## 5. `sgpe_processo_ref` — DDL final

Conferido em `information_schema` em 08/08/2026, com a tabela em produção.

```sql
CREATE TABLE IF NOT EXISTS sgpe_processo_ref (
  sigla            TEXT      NOT NULL,
  numero_oficial   INTEGER   NOT NULL,          -- o número DA TELA
  ano              INTEGER   NOT NULL,
  nu_processo      INTEGER,                     -- o número INTERNO; NULL = negativa
  cd_orgaosetor    INTEGER,                     -- NULL = negativa
  origem           TEXT      NOT NULL DEFAULT 'SGPE',
  criado_em        TIMESTAMP NOT NULL DEFAULT NOW(),
  tentativas       INTEGER   NOT NULL DEFAULT 0,
  ultima_tentativa TIMESTAMP,
  motivo           TEXT,
  PRIMARY KEY (sigla, numero_oficial, ano)
);
```

Único índice: `sgpe_processo_ref_pkey`, UNIQUE btree em `(sigla, numero_oficial, ano)`.

`origem` assume quatro valores: `SGPE` · `CONFERIDO` · `NAO_ENCONTRADO` · `ERRO`.

**Sem TTL, de propósito:** o `nu_processo` não muda depois do processo autuado, então o que
foi resolvido uma vez vale para sempre.

⚠️ **Se a tabela já existir**, `CREATE TABLE IF NOT EXISTS` não alcança coluna nenhuma. Para
evoluir:

```sql
ALTER TABLE sgpe_processo_ref
  ALTER COLUMN nu_processo   DROP NOT NULL,
  ALTER COLUMN cd_orgaosetor DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS tentativas       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultima_tentativa TIMESTAMP,
  ADD COLUMN IF NOT EXISTS motivo           TEXT;
```

Conteúdo em 08/08/2026: `SGPE` 7.699 · `NAO_ENCONTRADO` 6.

---

## PARA A SKILL — o que levar para outro sistema

**A ordem de montagem que funcionou:**

1. Parte pura (`sgpe-link.js`) — testável sem rede, sem banco, sem sessão. 39 testes.
2. Tabela de cache com **negativa** desde o começo. Não gravar negativa foi o erro que fez o
   mesmo processo inexistente ser reconsultado a cada sessão de navegador.
3. Consulta DWR (`sgpe-dwr.js`) isolada, com `interpretarResposta` separada da rede para
   poder ser testada com respostas gravadas.
4. Camada de lote (`sgpe-lote.js`) — **um dono só** para a normalização e para a forma dos
   INSERTs.
5. Job separado, incremental, com disjuntor.
6. A API devolve `links` **com chave crua** ao lado dos dados; o consumidor faz `Map.get`.

**Os três erros que custaram caro aqui, para não repetir:**

1. **Duplicar a regex** no cliente. Divergiu em silêncio: o servidor passou a aceitar região
   na sigla, o front ficou para trás, e ADR deixou de linkar sem nada dar erro. A cura foi a
   chave crua — o cliente parou de precisar da regra.
2. **Não persistir a negativa.** O que o SGPe não tem era reperguntado para sempre.
3. **Resolver ao vivo no caminho da tela.** Gera carregamento progressivo e um teto artificial
   (25 por requisição) que nunca alcança um acervo de 7 mil.

**O que verificar antes de confiar num link gerado:** que `nuProcessooficial` da resposta é
o número perguntado. É a única defesa contra abrir o processo errado em silêncio.
