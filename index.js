// ============================================================
// octano-sicoob — Gateway + Worker de PAGAMENTO Pix (Sicoob) do cashback
// ------------------------------------------------------------
// Serviço único (Railway):
//   - HTTP  POST /pix/pagar  → paga 1 Pix (idempotente, com tetos, dry-run)
//   - WORKER (poller)        → lê oct_cashback 'pendente' e paga cada um
// Guarda o certificado A1 + client_id num lugar só; o núcleo/retaguarda nunca
// toca no certificado.
//
// SEGURANÇA (dinheiro real):
//   - DRY_RUN (padrão LIGADO): simula, não paga. Só paga com DRY_RUN=0.
//   - Anti-duplo-pagamento: o worker "reivindica" a linha (status=processando
//     só se ainda estava pendente) ANTES de pagar. Se travar no meio, fica
//     'processando' (revisão manual) — nunca paga 2x.
//   - Teto por Pix (CAP_POR_PIX) e teto diário (CAP_DIARIO).
//   - Auth do endpoint: header X-Sicoob-Token == env SICOOB_TOKEN.
// ============================================================
const express = require("express");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Railway/Raw Editor pode guardar valores COM aspas (ex.: SICOOB_AMBIENTE="producao").
// Tira aspas envolventes de todas as envs pra não quebrar comparações (ex.: !== "producao").
for (const k in process.env) {
  const v = process.env[k];
  if (typeof v === "string") process.env[k] = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
}

// ---------- config (env) ----------
const CFG = {
  porta: process.env.PORT || 8080,
  ambiente: (process.env.SICOOB_AMBIENTE || "sandbox").toLowerCase(),
  gatewayToken: process.env.SICOOB_TOKEN || "",
  clientId: process.env.SICOOB_CLIENT_ID || "",
  scope: process.env.SICOOB_SCOPE || "",
  tokenUrl: process.env.SICOOB_TOKEN_URL || "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token",
  pixPagarUrl: process.env.SICOOB_PIX_PAG_URL || "",
  sandboxToken: process.env.SICOOB_SANDBOX_TOKEN || "",
  pfxB64: process.env.SICOOB_PFX_BASE64 || "",
  pfxSenha: process.env.SICOOB_PFX_SENHA || "",
  // PEM (cert + chave) em base64 — preferido: o Node/OpenSSL 3 rejeita o PKCS12
  // legado do A1 ICP-Brasil ("Unsupported PKCS12 PFX data"); PEM não tem esse problema.
  certPemB64: process.env.SICOOB_CERT_PEM_B64 || "",
  keyPemB64: process.env.SICOOB_KEY_PEM_B64 || "",
  dryRun: process.env.DRY_RUN !== "0",
  capPorPix: Number(process.env.CAP_POR_PIX || 50),
  capDiario: Number(process.env.CAP_DIARIO || 500),
  // Supabase (worker lê/atualiza oct_cashback)
  supaUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  supaKey: process.env.SUPABASE_KEY || "",
  workerAtivo: process.env.WORKER_ATIVO === "1",
  pollSeg: Number(process.env.POLL_SEGUNDOS || 60),
  ua: "octano-sicoob/1.0",
  // conta ORIGEM (de onde sai o Pix) — usada na CONFIRMAÇÃO em produção
  origemIspb: process.env.SICOOB_ORIGEM_ISPB || "",
  origemCnpj: process.env.SICOOB_ORIGEM_CNPJ || "",
  origemNome: process.env.SICOOB_ORIGEM_NOME || "",
  origemConta: process.env.SICOOB_ORIGEM_CONTA || "",
  origemAgencia: process.env.SICOOB_ORIGEM_AGENCIA || "",
  origemChave: process.env.SICOOB_ORIGEM_CHAVE || "",
  // unidade do valor no /confirmacao. Swagger sugere CENTAVOS-string ("199" -> R$1,99).
  // Flippável por env sem mexer no código, caso o teste de R$0,01 mostre o contrário.
  valorCentavos: process.env.SICOOB_VALOR_CENTAVOS !== "0",
};

function agenteMtls() {
  // preferido: PEM (cert + key). Evita o erro "Unsupported PKCS12 PFX data" do A1.
  if (CFG.certPemB64 && CFG.keyPemB64) {
    return new https.Agent({
      cert: Buffer.from(CFG.certPemB64, "base64"),
      key: Buffer.from(CFG.keyPemB64, "base64"),
    });
  }
  if (CFG.pfxB64) return new https.Agent({ pfx: Buffer.from(CFG.pfxB64, "base64"), passphrase: CFG.pfxSenha });
  return undefined;
}

// ---------- teto diário (memória) ----------
let _dia = null, _gastoDia = 0;
function _hoje() { return new Date().toISOString().slice(0, 10); }
function _gastoHoje() { return _dia === _hoje() ? _gastoDia : 0; }
function _registraGasto(v) { const h = _hoje(); if (_dia !== h) { _dia = h; _gastoDia = 0; } _gastoDia += v; }

// ---------- token OAuth (client_credentials + mTLS), cacheado ----------
let _tok = null, _tokExp = 0;
async function getToken() {
  if (CFG.ambiente === "sandbox" && CFG.sandboxToken) return CFG.sandboxToken;
  if (_tok && Date.now() < _tokExp - 30000) return _tok;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: CFG.clientId });
  if (CFG.scope) body.append("scope", CFG.scope);
  const r = await axios.post(CFG.tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent: agenteMtls(), timeout: 30000,
  });
  _tok = r.data.access_token; _tokExp = Date.now() + (Number(r.data.expires_in || 300) * 1000);
  return _tok;
}

// ---------- chamada de Pix pagamento no Sicoob (fluxo por chave DICT) ----------
// PRODUÇÃO é em 2 passos (Swagger api.sicoob.com.br/pix-pagamentos/v2):
//   1) POST /pagamentos {chave}           -> resolve a chave, devolve endToEndId + proprietario
//   2) POST /pagamentos/confirmacao {...}  -> EFETIVA (o dinheiro sai aqui)
// SANDBOX: para no passo 1 (o mock já devolve e2e; o /confirmacao do mock rejeita o origem).
// ⚠️ Antes do go-live REAL confirmar: unidade do 'valor' (reais vs centavos) e o formato do
//    'origem'/'destino' (a conta origem vem das envs SICOOB_ORIGEM_*).
async function sicoobPixPagar({ token, chave, valor, descricao }) {
  if (!CFG.pixPagarUrl) throw new Error("SICOOB_PIX_PAG_URL não configurada");
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", client_id: CFG.clientId, "User-Agent": CFG.ua };
  const reqCfg = { headers: H, httpsAgent: agenteMtls(), timeout: 40000 };

  // passo 1: INICIAR (resolve a chave DICT)
  const ini = await axios.post(CFG.pixPagarUrl, { chave }, reqCfg);
  const e2e = ini.data && ini.data.endToEndId;
  if (!e2e) throw new Error("iniciação sem endToEndId: " + JSON.stringify(ini.data).slice(0, 200));

  // sandbox: encerra aqui (não confirma)
  if (CFG.ambiente !== "producao") return { endToEndId: e2e, estado: "SANDBOX", raw: ini.data };

  // passo 2: CONFIRMAR (produção — efetiva o pagamento)
  const prop = (ini.data && ini.data.proprietario) || {};
  const corpo = {
    endToEndId: e2e,
    valor: CFG.valorCentavos ? String(Math.round(valor * 100)) : String(valor.toFixed(2)),
    descricao: (descricao || "").slice(0, 140),
    meioIniciacao: "MANUAL",
    origem: {
      ispb: CFG.origemIspb, cpfCnpj: CFG.origemCnpj, nome: CFG.origemNome,
      conta: CFG.origemConta, agencia: CFG.origemAgencia, tipo: "CORRENTE",
      ...(CFG.origemChave ? { chaveDict: CFG.origemChave } : {}),
    },
    // pagamento POR CHAVE: só a chaveDict (o proprietario.identificador vem MASCARADO
    // na iniciação, então não serve como cpfCnpj). O Sicoob resolve o destino pela chave.
    destino: { chaveDict: chave, boolFavorecido: false },
  };
  const conf = await axios.post(CFG.pixPagarUrl + "/confirmacao", corpo, reqCfg);
  return { endToEndId: (conf.data && conf.data.endToEndId) || e2e, estado: conf.data && conf.data.estado, raw: conf.data };
}

// ---------- núcleo do pagamento (usado pelo endpoint E pelo worker) ----------
// valida tetos, dry-run e devolve {ok, e2e|erro}. NÃO cuida de idempotência de
// registro (isso é do chamador: o endpoint usa a chave; o worker usa o claim).
async function executarPix({ chave, valor, descricao }) {
  const v = Number(valor);
  if (!chave) return { ok: false, erro: "chave_pix ausente" };
  if (!(v > 0)) return { ok: false, erro: "valor inválido" };
  if (v > CFG.capPorPix) return { ok: false, erro: `acima do teto por Pix (R$${CFG.capPorPix})` };
  if (_gastoHoje() + v > CFG.capDiario) return { ok: false, erro: `estouraria o teto diário (R$${CFG.capDiario})` };
  if (CFG.dryRun) { _registraGasto(v); return { ok: true, dry_run: true, e2e: "SIMULADO", valor: v }; }
  try {
    const token = await getToken();
    const resp = await sicoobPixPagar({ token, chave, valor: v, descricao });
    _registraGasto(v);
    return { ok: true, e2e: resp.endToEndId || resp.e2eId || null, valor: v, raw: resp };
  } catch (e) {
    const det = e.response ? JSON.stringify(e.response.data).slice(0, 1000) : e.message;
    return { ok: false, erro: "falha no Sicoob: " + det };
  }
}

// ============================================================
// WORKER — lê oct_cashback 'pendente' e paga
// ============================================================
function _supaHeaders(extra) {
  return { apikey: CFG.supaKey, Authorization: "Bearer " + CFG.supaKey, "Content-Type": "application/json", ...(extra || {}) };
}
async function _supaGet(query) {
  const r = await axios.get(`${CFG.supaUrl}/rest/v1/${query}`, { headers: _supaHeaders(), timeout: 20000 });
  return r.data;
}
async function _supaPatch(query, body, prefer) {
  const r = await axios.patch(`${CFG.supaUrl}/rest/v1/${query}`, body, {
    headers: _supaHeaders({ Prefer: prefer || "return=representation" }), timeout: 20000,
  });
  return r.data;
}

let _rodando = false;
async function processarPendentes() {
  if (_rodando) return { pulado: "já rodando" };
  if (!CFG.supaUrl || !CFG.supaKey) return { erro: "Supabase não configurado" };
  _rodando = true;
  const res = { pagos: 0, falhas: 0, itens: [] };
  try {
    const pend = await _supaGet("oct_cashback?status=eq.pendente&chave_pix=not.is.null&select=id,cliente_nome,valor_cashback,chave_pix,tentativas&order=criado_em&limit=50");
    for (const c of pend) {
      // 1) REIVINDICA a linha: vira 'processando' só se AINDA estava 'pendente'.
      //    (dois polls concorrentes: só um consegue; o outro recebe [] e pula.)
      let claim;
      try {
        claim = await _supaPatch(`oct_cashback?id=eq.${c.id}&status=eq.pendente`, { status: "processando" });
      } catch (e) { continue; }
      if (!Array.isArray(claim) || !claim.length) continue;   // já foi reivindicada
      // 2) paga
      const r = await executarPix({ chave: c.chave_pix, valor: Number(c.valor_cashback), descricao: "Cashback Octano" });
      // 3) marca resultado
      if (r.ok) {
        await _supaPatch(`oct_cashback?id=eq.${c.id}`, {
          status: "pago", pix_e2e: r.e2e, sicoob_id: r.e2e, pago_em: new Date().toISOString(),
          tentativas: (Number(c.tentativas) || 0) + 1,
        });
        res.pagos++; res.itens.push({ cliente: c.cliente_nome, valor: r.valor, e2e: r.e2e, dry: !!r.dry_run });
      } else {
        // falha: volta pra 'pendente' até 3 tentativas; depois 'falhou'
        const tent = (Number(c.tentativas) || 0) + 1;
        await _supaPatch(`oct_cashback?id=eq.${c.id}`, {
          status: tent >= 3 ? "falhou" : "pendente", erro: String(r.erro).slice(0, 900), tentativas: tent,
        });
        res.falhas++; res.itens.push({ cliente: c.cliente_nome, erro: r.erro, tentativa: tent });
      }
    }
  } catch (e) {
    res.erro = e.message;
  } finally { _rodando = false; }
  return res;
}

// ---------- auth do gateway ----------
function checaToken(req, res) {
  const t = req.get("X-Sicoob-Token") || "";
  if (!CFG.gatewayToken || t !== CFG.gatewayToken) { res.status(401).json({ ok: false, erro: "token inválido" }); return false; }
  return true;
}

// ============================================================
// ROTAS
// ============================================================
app.get("/status", (req, res) => {
  res.json({
    ok: true, ambiente: CFG.ambiente, dry_run: CFG.dryRun, worker_ativo: CFG.workerAtivo, poll_seg: CFG.pollSeg,
    tem_certificado: !!CFG.pfxB64, tem_client_id: !!CFG.clientId, pix_pagar_configurado: !!CFG.pixPagarUrl,
    supabase_ok: !!(CFG.supaUrl && CFG.supaKey), caps: { por_pix: CFG.capPorPix, diario: CFG.capDiario }, gasto_hoje: _gastoHoje(),
  });
});

// POST /pix/pagar  { chave_pix, valor, descricao }  (pagamento avulso/manual)
app.post("/pix/pagar", async (req, res) => {
  if (!checaToken(req, res)) return;
  const { chave_pix, valor, descricao } = req.body || {};
  const r = await executarPix({ chave: chave_pix, valor, descricao });
  res.status(r.ok ? 200 : 422).json(r);
});

// GET /worker/rodar  → dispara o processamento dos pendentes na hora (teste)
app.get("/worker/rodar", async (req, res) => {
  if (!checaToken(req, res)) return;
  res.json(await processarPendentes());
});

app.listen(CFG.porta, () => {
  console.log(`octano-sicoob on :${CFG.porta} [${CFG.ambiente}] dry_run=${CFG.dryRun} worker=${CFG.workerAtivo}`);
  if (CFG.workerAtivo) {
    setInterval(() => { processarPendentes().then(r => { if (r.pagos || r.falhas) console.log("worker:", JSON.stringify(r)); }); },
      Math.max(15, CFG.pollSeg) * 1000);
  }
});
