# SIGPC-API — ESTADO EM 08/08/2026

Cole no início do chat novo.

---

## CONCLUÍDO EM 08/08 — link do SGPe vem pronto no GET

O link deixou de ser carregado progressivamente pela tela. As **três** rotas que alimentam
os números de processo passam a devolver um mapa `links` ao lado de `data`:

| rota | campos |
|---|---|
| `GET /prestacoes_contas` | `processo_pc` + `processo_mae` |
| `GET /prestacoes_contas/resumo_tr` | `processo_mae` |
| `GET /prestacoes_contas/alertas_prazo` | `processo_pc` do `top10` |

**A chave do mapa é o VALOR CRU** (`links["SCC2146/2020"]`), não a forma canônica. É o que
permite ao front fazer `links[p.processo_pc]` sem regex — e é o que vai matar a REGRA CRÍTICA
abaixo quando a Fase 6 (front) entrar.

Nenhuma das três consulta o SGPe: só leem o cache. Quem consulta é `job_sgpe_links.js`.

- **Negativa gravada** — `origem = 'NAO_ENCONTRADO'` com `nu_processo` NULL. Processo que o
  SGPe não tem para de ser reconsultado a cada sessão. Precedência entre estados:
  `CONFERIDO` > `SGPE` > `NAO_ENCONTRADO` > `ERRO` (provisório, volta com recuo).
- **`ERRO`** é falha de rede: volta para a fila em 15 min / 1 h / 6 h / 24 h e desiste na 5ª.
- **`POST /sgpe/links` continua no ar**, agora ciente da negativa — é a rede de segurança
  até o front trocar.

### PARADO DE PROPÓSITO (combinado com o Richard em 08/08)

- **Fase 6 — front (`sigpc-gt/index.html`)**: não começou.
- **Job de carga (~1h15)**: não rodou. Fila em 7.317, para rodar acompanhado.

---

## REGRA CRÍTICA

A regex do `index.html` (sigpc-gt) e a de `lib/sgpe-link.js` (sigpc-api) são **a mesma regra
em dois lugares**. Mexeu numa, mexa na outra e rode o teste de paridade.

Já quebrou uma vez, em 06/08: o servidor passou a aceitar região na sigla e o front ficou
para trás. O sintoma foi silencioso — ADR não linkava na tela, FCEE e SCC linkavam, e a
API respondia certo porque ninguém perguntava. Nada dá erro quando isso acontece.

O teste de paridade extrai a regex e a `sgpeChave` do próprio `index.html` e compara com a
lib contra todos os processos do banco. É a única forma de perceber a divergência.

---

## CONCLUÍDO EM 06/08

- **Tabela de 183 `cdOrgaosetor`** extraída do SGPe e no ar
  (`9938571`, `feature/baixa-por-parcial`)
- **Regex da sigla aceita região** (ADR20, SDR13) com separador
- **Trava de ambiguidade corrigida** para avaliar dígitos crus antes da remoção de zeros
  (`1cf8a0f`) — 39 testes passando
- **22 ADRs validadas** contra o SGPe por `sgOrgaosetor`
- **UPDATE do grupo A no banco:** 76 valores, 1.641 linhas
- **Paridade front/servidor restaurada** (sigpc-gt `61e0d62`, `main`) — 8.159/8.159,
  0 divergências

### ⚠️ Correção ao registro do UPDATE

A tabela `prestacoes_contas_bkp_processo_pc` **não existe**. Conferido em 06/08 com
`to_regclass`: as únicas tabelas de backup no banco são `_backup_baixada_20260805` e
`_backup_parcial_num_20260805`, ambas de outra frente.

O UPDATE do grupo A foi aplicado **sem esse backup** — ou ele foi removido depois. O dado
está correto (a transformação foi validada valor a valor antes de rodar, e o
`ainda_colados` zerou), e o rollback continua trivial: basta remover o espaço inserido
entre região e número. Mas a rede de segurança prevista no plano não está lá.

---

## PENDENTE

- **Skill `sgpe-link` (SKILL.md)** — a fazer hoje à noite
- **22 valores dos grupos B e C** (ano grudado / ambíguos) em `adr_sdr_sem_link.csv`,
  neste repositório — conferência manual. Atingem 345 PCs.
  Composição: 18 com ano grudado, 1 com barra extra, 1 com ponto no ano, 2 sem região.
- **Merge da feature na main do sigpc-api** — produção roda da feature, confirmado no
  painel do Railway. Não há registro dessa configuração no código do repositório.
- **Sondar `cdOrgaosetor` das 9 regionais** agora testáveis: ADR01, 18, 21, 22, 24, 26,
  28, 29, 32. A ADR22 (`13580`) nunca foi verificada — foi ela que originou a frente.

---

## O QUE ESTÁ NO AR

| Peça | Onde | Commit |
|---|---|---|
| `POST /sgpe/links` | Railway, roda da `feature/baixa-por-parcial` | `1cf8a0f` |
| Mapa de 183 órgãos | `lib/sgpe-link.js` | `9938571` |
| Cache de links | tabela `sgpe_processo_ref` | criada no boot |
| Mapa `links` nas 3 rotas | `server.js` + `lib/sgpe-lote.js` | 08/08 |
| Colunas de negativa | `tentativas`, `ultima_tentativa`, `motivo`; `nu_processo` passou a aceitar NULL | ALTER aplicado à mão em 08/08 e no boot |
| Job | `job_sgpe_links.js` — **ainda não rodou em volume** | 08/08 |

`main` do sigpc-api está em `d425328`, **quatro commits atrás** da feature.

### Cache em 08/08

388 resolvidos · **7.317 na fila** · 7.700 processos linkáveis no acervo.
Fora de alcance para sempre: 72 que não casam a regex + 4 de sigla desconhecida
(`ADR`, `SCCSCC`, `AR19`) — esses nem chegam a consultar o SGPe.

### O job

```bash
node job_sgpe_links.js --dry-run          # mostra a fila, não toca em nada
node job_sgpe_links.js --limite=200       # o que o cron vai rodar
node job_sgpe_links.js --somente-novos    # fim de carga
node job_sgpe_links.js --retentar-erros   # força os que falharam por rede
```

Ritmo medido: **0,59 s por processo** (mediana), p90 0,79 s. A fila cheia leva **~1h15**.
Ctrl+C encerra depois do processo corrente, sem escrita pela metade.

**FALTA CRIAR:** serviço separado no Railway para o cron (de hora em hora,
`--limite=200`). Não há `railway.json` no repositório — é configuração de painel.

---

## ARMADILHAS DESTA FRENTE

1. **Não existe fórmula** para o `nuProcesso` interno do SGPe. Só consulta. Errar não dá
   erro: abre outro processo, em silêncio.
2. **Região colada ao número é ambígua** e a trava devolve `null` de propósito.
   `ADR223151/2017` pode ser região 22 nº 3151 ou região 2 nº 23151. Não adivinhar.
3. **A trava sai do mapa, não de sigla chumbada.** Entrou chave nova, a proteção passa a
   valer sozinha.
4. **`SIGLAS_AMBIGUAS` conflita com o mapa novo:** `DC`, `SAN`, `SAP` e `SAS` estão nas
   duas listas. `siglaConhecida` devolve `true` e `orgaoDaSigla` lança `SiglaAmbigua`;
   a rota captura e joga em `naoEncontrados`. Não quebra, mas é incoerente. Mantido
   intacto por decisão expressa de 06/08.
5. **O deploy do Railway não é imediato.** Em 05/08 levou ~10 minutos de 404 antes de
   publicar. Não há `railway.json`, `nixpacks.toml` nem qualquer config no repositório.

---

## COMO TESTAR

```bash
npm run teste               # 39 + 33 testes, sem rede e sem banco
node --check server.js lib/*.js job_sgpe_links.js
```

Produção:

```bash
curl -s -X POST https://sigpc-api-production.up.railway.app/sgpe/links \
  -H "Content-Type: application/json" \
  -d '{"processos":["ADR20 1225/2017","SCC2146/2020"]}'
```
