# octano-sicoob — Gateway de pagamento Pix (Sicoob) para o cashback

Faz o **Pix de saída** (cashback) via API do Sicoob, isolando o certificado/credenciais
num só lugar (Railway). O núcleo/retaguarda chama `/pix/pagar`; nunca toca no certificado.

## Segurança (dinheiro real)
- `DRY_RUN=1` por padrão → **simula, não paga**. Só paga com `DRY_RUN=0`.
- Idempotência (`idempotencia`): a mesma venda nunca paga 2x.
- `CAP_POR_PIX` e `CAP_DIARIO`: tetos que bloqueiam pagamento anormal.
- Auth do gateway: header `X-Sicoob-Token`.

## Rotas
- `GET /status` → ambiente, dry_run, se tem certificado, tetos, gasto do dia.
- `POST /pix/pagar` `{ idempotencia, chave_pix, valor, descricao }` → paga (ou simula).

---

## Checklist no Portal Developers do Sicoob (o que VOCÊ faz)
Portal: https://developers.sicoob.com.br/portal/

1. **Login** no portal (conta do cooperado, CPF do representante).
2. **Meus Aplicativos → Nova Aplicação**. Autentique com o Sicoobnet e **Aprove**.
3. Na aplicação, **assine/adicione o produto "Pagamentos" (Pix pagamento)** — é a API de
   *pagamentos e transferências* (diferente da de recebimento). Anote os **escopos** que ela
   pede (algo como `pagamentos` / `pix.write`) → vão no `SICOOB_SCOPE`.
4. **Dashboard → credenciais de Sandbox**: copie o **client_id de sandbox** e, se houver, o
   **token de teste** → `SICOOB_CLIENT_ID` e `SICOOB_SANDBOX_TOKEN`.
5. No **Swagger da API de Pagamentos** (dentro do portal), copie a **URL exata do endpoint de
   Pix pagamento** e o **formato do corpo** → `SICOOB_PIX_PAG_URL` (e me manda o print/JSON do
   corpo pra eu ajustar a função `sicoobPixPagar`).
6. **Produção (depois)**: certificado **A1 (PFX)** emitido pro CNPJ do posto. Sobe o `.CER`
   público no app do portal; o `.PFX` vira `SICOOB_PFX_BASE64` (base64) + `SICOOB_PFX_SENHA`.

## Arquitetura (serviço único)
- `POST /pix/pagar` — paga 1 Pix avulso (idempotência via chamador, tetos, dry-run).
- `GET /worker/rodar` — dispara o processamento dos pendentes na hora (teste).
- **Worker (poller)** — a cada `POLL_SEGUNDOS`, lê `oct_cashback status=pendente`, **reivindica**
  a linha (status=processando só se ainda pendente → anti-duplo-pagamento), paga, marca `pago`/`falhou`.

## Endpoint de pagamento (descoberto no sandbox)
`POST .../pix-pagamentos/v2/pagamentos` → 200 com `endToEndId`. Sandbox é **mock** (ignora o corpo).
Em produção, confirmar o corpo exato no Swagger.

## Deploy (Railway — igual ao octano-wpp)
1. Repo novo `octano-sicoob` (público ou com o GitHub App autorizado).
2. Railway → New Project → deploy do repo.
3. Variables (Raw Editor): copie do `.env.sandbox` (inclui Supabase + worker). Preencha `SUPABASE_KEY`
   (service_key) e um `SICOOB_TOKEN` forte.
4. Testar: `GET /status` → `{"ambiente":"sandbox","worker_ativo":true,"supabase_ok":true,...}`.
5. `GET /worker/rodar` (com header `X-Sicoob-Token`) processa os pendentes na hora.

## Ordem sugerida
1. Sandbox: `/status` OK + worker pagando os pendentes (mock).
2. Com o Swagger, ajustar o corpo do POST /pagamentos.
3. Produção: subir o **A1** (`SICOOB_PFX_BASE64`+senha), `SICOOB_AMBIENTE=producao`, escopos no app do portal.
4. Ligar de verdade: `DRY_RUN=0` com `CAP_POR_PIX`/`CAP_DIARIO` baixos; conciliar com o extrato.
