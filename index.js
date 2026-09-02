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
  // meioIniciacao (enum do Swagger): CHAVE | MANUAL | QRCODE.
  // Fluxo por chave DICT = "CHAVE": LEVA o endToEndId da iniciação e o destino é
  // resolvido pela chave (NÃO se manda destino manual — isso é só do MANUAL, que
  // por sua vez exige conta completa e rejeita o endToEndId).
  const corpo = {
    endToEndId: e2e,
    // valor em REAIS com VÍRGULA decimal ("0,01" = R$0,01). Padrão exigido pelo Sicoob:
    // ^[0-9]{1,18}([,][0-9]{1,2})?$ (vírgula, não ponto). Testes reais 2026-07-18 provaram:
    // "1" saiu R$1,00 (é reais, não centavos) e "0.01" foi rejeitado (ponto inválido).
    valor: valor.toFixed(2).replace(".", ","),
    descricao: (descricao || "").slice(0, 140),
    meioIniciacao: "CHAVE",
    origem: {
      ispb: CFG.origemIspb, cpfCnpj: CFG.origemCnpj, nome: CFG.origemNome,
      conta: CFG.origemConta, agencia: CFG.origemAgencia, tipo: "CORRENTE",
      ...(CFG.origemChave ? { chaveDict: CFG.origemChave } : {}),
    },
  };
  const conf = await axios.post(CFG.pixPagarUrl + "/confirmacao", corpo, reqCfg);
  return { endToEndId: (conf.data && conf.data.endToEndId) || e2e, estado: conf.data && conf.data.estado, raw: conf.data };
}

// ---------- NORMALIZAÇÃO DA CHAVE PIX ----------
// O DICT exige formato exato. O cliente digita "31999998526" (celular sem +55)
// e o Sicoob devolve 404 "A chave DICT não foi encontrada" — foi o que
// aconteceu em 04/08. Aqui arrumamos o que dá para arrumar, e o chamador
// ainda tenta a variante se a primeira falhar.
function _cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d){10}$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * ((n + 1) - i);
    const dig = (soma * 10 % 11) % 10;
    if (dig !== Number(cpf[n])) return false;
  }
  return true;
}

// devolve as formas a tentar, na ordem (a 1ª é a mais provável)
function variantesChave(chaveBruta) {
  const chave = String(chaveBruta || "").trim();
  if (!chave) return [];
  if (chave.includes("@")) return [chave.toLowerCase()];                  // e-mail
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(chave)) return [chave.toLowerCase()];  // EVP (aleatória)
  if (chave.startsWith("+")) return [chave, chave.replace(/\D/g, "")];
  const d = chave.replace(/\D/g, "");
  if (!d) return [chave];
  if (d.length === 14) return [d];                                        // CNPJ
  if (d.length === 13 && d.startsWith("55")) return ["+" + d, d];
  if (d.length === 12 && d.startsWith("55")) return ["+" + d, d];
  if (d.length === 11) {
    // ambíguo: CPF ou celular (DDD + 9 + 8). Celular tem o 3º dígito = 9.
    const pareceCelular = d[2] === "9" && Number(d.slice(0, 2)) >= 11;
    return pareceCelular && !_cpfValido(d) ? ["+55" + d, d]
         : _cpfValido(d) ? [d, "+55" + d]
         : ["+55" + d, d];
  }
  if (d.length === 10) return ["+55" + d, d];                             // fixo com DDD
  return [chave];
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
  // tenta as variantes da chave (ex.: "31999998526" -> "+5531999998526").
  // Só insiste quando o erro é "chave não encontrada" (DICT) — em qualquer
  // outra falha para na hora, para não repetir tentativa de pagamento.
  const tentativas = variantesChave(chave);
  let ultimoErro = "chave_pix inválida";
  for (const c of tentativas) {
    try {
      const token = await getToken();
      const resp = await sicoobPixPagar({ token, chave: c, valor: v, descricao });
      _registraGasto(v);
      return { ok: true, e2e: resp.endToEndId || resp.e2eId || null, valor: v,
               chave_usada: c, raw: resp };
    } catch (e) {
      const det = e.response ? JSON.stringify(e.response.data).slice(0, 1000) : e.message;
      ultimoErro = "falha no Sicoob: " + det;
      const naoEncontrada = /NaoEncontrado|n[aã]o foi encontrada|404/i.test(det);
      if (!naoEncontrada) break;      // erro real (saldo, permissão...): não insiste
    }
  }
  return { ok: false, erro: ultimoErro, chave_tentativas: tentativas };
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

// ---------- ANTIFRAUDE no servidor (autoridade; o PDV também checa, mas aqui é o corte) ----------
const JANELA_2H_MS = 2 * 3600 * 1000;

// 1) o MESMO ABASTECIMENTO já gerou cashback vivo? (cancelar cupom + relançar
//    muda a chave da NFC-e, mas o abastecimento é o mesmo -> barra aqui)
async function _duplicadoPorAbastecimento(c) {
  if (!Array.isArray(c.abast_ids) || !c.abast_ids.length) return null;
  const lista = c.abast_ids.map(s => String(s).replace(/[{},"]/g, "")).join(",");
  const q = `oct_cashback?id=neq.${c.id}&status=in.(processando,pago)` +
    `&abast_ids=ov.{${encodeURIComponent(lista)}}&select=id,numero_nfe,status&limit=1`;
  const dup = await _supaGet(q);
  return (Array.isArray(dup) && dup.length) ? dup[0] : null;
}

// 2) a MESMA PESSOA (cliente ou chave Pix) recebeu nas últimas 2 horas?
async function _bloqueado2h(c) {
  const corte = new Date(Date.now() - JANELA_2H_MS).toISOString();
  const filtroPessoa = c.cliente_id
    ? `or=(cliente_id.eq.${c.cliente_id},chave_pix.eq.${encodeURIComponent(c.chave_pix)})`
    : `chave_pix=eq.${encodeURIComponent(c.chave_pix)}`;
  const q = `oct_cashback?id=neq.${c.id}&status=in.(processando,pago)` +
    `&criado_em=gte.${encodeURIComponent(corte)}&${filtroPessoa}&select=id,criado_em&limit=1`;
  const rec = await _supaGet(q);
  return (Array.isArray(rec) && rec.length) ? rec[0] : null;
}

// CHAVE GERAL por posto (pedido Ronan 20/08): oct_empresas.cashback_ativo.
// Sem TRUE explícito o posto NÃO paga cashback — posto que não oferece a
// função fica protegido mesmo que alguém crie pendentes por engano.
let _cbAtivoCache = { ts: 0, set: null };
async function _cashbackLigado(empresaId) {
  if (!_cbAtivoCache.set || Date.now() - _cbAtivoCache.ts > 60000) {
    const rows = await _supaGet("oct_empresas?cashback_ativo=eq.true&select=id");
    _cbAtivoCache = { ts: Date.now(), set: new Set(rows.map(r => r.id)) };
  }
  return _cbAtivoCache.set.has(empresaId);
}

let _rodando = false;
async function processarPendentes() {
  if (_rodando) return { pulado: "já rodando" };
  if (!CFG.supaUrl || !CFG.supaKey) return { erro: "Supabase não configurado" };
  _rodando = true;
  const res = { pagos: 0, falhas: 0, bloqueados: 0, itens: [] };
  try {
    const pend = await _supaGet("oct_cashback?status=eq.pendente&chave_pix=not.is.null&select=id,empresa_id,cliente_id,cliente_nome,valor_cashback,chave_pix,tentativas,abast_ids,litros&order=criado_em&limit=50");
    for (const c of pend) {
      // 1) REIVINDICA a linha: vira 'processando' só se AINDA estava 'pendente'.
      //    (dois polls concorrentes: só um consegue; o outro recebe [] e pula.)
      let claim;
      try {
        claim = await _supaPatch(`oct_cashback?id=eq.${c.id}&status=eq.pendente`, { status: "processando" });
      } catch (e) { continue; }
      if (!Array.isArray(claim) || !claim.length) continue;   // já foi reivindicada

      // 1.4) CHAVE GERAL do posto — desligado NÃO paga (fail-safe: erro na
      //      checagem devolve pra pendente, igual ao antifraude)
      try {
        if (!(await _cashbackLigado(c.empresa_id))) {
          await _supaPatch(`oct_cashback?id=eq.${c.id}`,
            { status: "bloqueado_off", erro: "cashback DESLIGADO p/ este posto (chave geral na tela Empresa)" });
          res.bloqueados++; res.itens.push({ cliente: c.cliente_nome, bloqueio: "posto_off" });
          continue;
        }
      } catch (e) {
        await _supaPatch(`oct_cashback?id=eq.${c.id}`, { status: "pendente", erro: "chave geral indisponível: " + e.message.slice(0, 200) });
        continue;
      }

      // 1.5) ANTIFRAUDE (depois do claim, antes do dinheiro sair)
      try {
        const dup = await _duplicadoPorAbastecimento(c);
        if (dup) {
          await _supaPatch(`oct_cashback?id=eq.${c.id}`,
            { status: "duplicado", erro: `abastecimento já pagou cashback (cupom ${dup.numero_nfe || dup.id})` });
          res.bloqueados++; res.itens.push({ cliente: c.cliente_nome, bloqueio: "duplicado" });
          continue;
        }
        const rec2h = await _bloqueado2h(c);
        if (rec2h) {
          await _supaPatch(`oct_cashback?id=eq.${c.id}`,
            { status: "bloqueado_2h", erro: `cliente já recebeu cashback às ${rec2h.criado_em} (janela 2h)` });
          res.bloqueados++; res.itens.push({ cliente: c.cliente_nome, bloqueio: "2h" });
          continue;
        }
      } catch (e) {
        // antifraude indisponível = NÃO paga (fail-safe): volta pra pendente e tenta no próximo poll
        await _supaPatch(`oct_cashback?id=eq.${c.id}`, { status: "pendente", erro: "antifraude falhou: " + e.message.slice(0, 200) });
        continue;
      }

      // 2) paga
      const r = await executarPix({ chave: c.chave_pix, valor: Number(c.valor_cashback), descricao: "Cashback Octano" });
      // 3) marca resultado
      if (r.ok) {
        await _supaPatch(`oct_cashback?id=eq.${c.id}`, {
          status: "pago", pix_e2e: r.e2e, sicoob_id: r.e2e, pago_em: new Date().toISOString(),
          tentativas: (Number(c.tentativas) || 0) + 1,
        });
        res.pagos++; res.itens.push({ cliente: c.cliente_nome, valor: r.valor, e2e: r.e2e, dry: !!r.dry_run });
        notificarWhatsApp(c, r).catch(e => console.log("wpp:", e.message));   // best-effort, não trava o worker
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

// ============================================================
// NOTIFICAÇÃO WhatsApp do cashback pago (via gateway octano-wpp)
// Envs: WPP_URL, WPP_TOKEN, WPP_LOGO_B64 (opcional: logo do posto em base64 ->
// manda imagem com legenda; sem logo manda texto).
// ============================================================
async function notificarWhatsApp(c, pagto) {
  if (!process.env.WPP_URL || !process.env.WPP_TOKEN) return;
  if (pagto && pagto.dry_run) return;   // simulação não notifica
  // telefone do cliente (oct_pessoas)
  let tel = null, nomePosto = "seu posto";
  try {
    if (c.cliente_id) {
      const p = await _supaGet(`oct_pessoas?id=eq.${c.cliente_id}&select=telefone,whatsapp`);
      if (Array.isArray(p) && p.length) tel = p[0].whatsapp || p[0].telefone || null;
    }
    if (c.empresa_id) {
      const e = await _supaGet(`oct_empresas?id=eq.${c.empresa_id}&select=nome,nome_fantasia`);
      if (Array.isArray(e) && e.length) nomePosto = e[0].nome_fantasia || e[0].nome || nomePosto;
    }
  } catch (e) { /* segue sem os extras */ }
  if (!tel) return;
  const valor = Number(c.valor_cashback).toFixed(2).replace(".", ",");
  const litros = c.litros ? Number(c.litros).toFixed(2).replace(".", ",") + " litros" : "seu abastecimento";
  const nome = (c.cliente_nome || "").split(" ")[0];
  const msg =
    `🎉 *Cashback recebido!*\n\n` +
    `Olá${nome ? " " + nome : ""}! Você acabou de receber *R$ ${valor}* de cashback ` +
    `pelo abastecimento de ${litros} no *${nomePosto}*.\n\n` +
    `💰 O Pix já está na sua conta.\n\n` +
    `Obrigado pela preferência — bom trajeto e até o próximo abastecimento! ⛽`;
  const H = { "Content-Type": "application/json", "x-wpp-token": process.env.WPP_TOKEN };
  const base = process.env.WPP_URL.replace(/\/$/, "");
  const logo = (process.env.WPP_LOGO_B64 || "").trim();
  if (logo) {
    await axios.post(base + "/send-image", { phone: tel, image: logo, caption: msg }, { headers: H, timeout: 30000 });
  } else {
    await axios.post(base + "/send-text", { phone: tel, message: msg }, { headers: H, timeout: 30000 });
  }
}

// ============================================================
// EXTRATO — importa o extrato da conta de CADA posto (API Conta Corrente v4)
// para oct_banco_movimentos. O conciliador (sync 6/6h no PC dev) casa os
// débitos com oct_contas_pagar (baixa automática + juros/multa/desconto).
// Config por posto em oct_sicoob_contas (numero_conta, client_id, env_prefix,
// ambiente). Certificado por posto nas envs SICOOB_CERT_PEM_B64_<PREFIX> /
// SICOOB_KEY_PEM_B64_<PREFIX> (mesmo A1 e-CNPJ da NF-e). Sandbox usa o token
// fixo do portal (sem mTLS).
// Envs: EXTRATO_ATIVO=1, EXTRATO_POLL_SEGUNDOS (padrão 1800), EXTRATO_DIAS (5).
// ============================================================
const crypto = require("crypto");
const EXT = {
  ativo: process.env.EXTRATO_ATIVO === "1",
  pollSeg: Number(process.env.EXTRATO_POLL_SEGUNDOS || 1800),
  dias: Number(process.env.EXTRATO_DIAS || 5),
  urlSandbox: "https://sandbox.sicoob.com.br/sicoob/sandbox/conta-corrente/v4",
  urlProd: "https://api.sicoob.com.br/conta-corrente/v4",
  scope: process.env.SICOOB_EXTRATO_SCOPE || "cco_consulta cco_extrato",
  estado: { ultima: null, contas: {}, erro: null },
};

function _agentePrefix(prefix) {
  const cert = process.env[`SICOOB_CERT_PEM_B64_${prefix}`];
  const key = process.env[`SICOOB_KEY_PEM_B64_${prefix}`];
  if (cert && key) return new https.Agent({ cert: Buffer.from(cert, "base64"), key: Buffer.from(key, "base64") });
  return agenteMtls();   // fallback: certificado global
}

// token OAuth por conta (produção), cacheado por empresa
const _tokConta = {};
async function _tokenConta(conta) {
  if ((conta.ambiente || "producao") === "sandbox") return CFG.sandboxToken;
  const k = conta.empresa_id;
  const c = _tokConta[k];
  if (c && Date.now() < c.exp - 30000) return c.tok;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: conta.client_id, scope: EXT.scope });
  const r = await axios.post(CFG.tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    httpsAgent: _agentePrefix(conta.env_prefix || ""), timeout: 30000,
  });
  _tokConta[k] = { tok: r.data.access_token, exp: Date.now() + Number(r.data.expires_in || 300) * 1000 };
  return _tokConta[k].tok;
}

// data do extrato pode vir "dd/mm/aaaa" (produção) ou ISO — normaliza p/ aaaa-mm-dd
function _dataISO(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}
function _valorNum(v) {
  if (typeof v === "number") return v;
  let s = String(v || "").trim();
  // produção manda formato AMERICANO ("1700.00" — validado 19/08 na conta real);
  // só trata como BR ("1.700,00") quando existe vírgula decimal.
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  s = s.replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return isFinite(n) ? n : null;
}

async function _extratoConta(conta, mes, ano, diaIni, diaFim) {
  const base = (conta.ambiente || "producao") === "sandbox" ? EXT.urlSandbox : EXT.urlProd;
  const token = await _tokenConta(conta);
  const url = `${base}/extrato/${mes}/${ano}?diaInicial=${diaIni}&diaFinal=${diaFim}` +
              `&numeroContaCorrente=${encodeURIComponent(conta.numero_conta)}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, client_id: conta.client_id || CFG.clientId },
    httpsAgent: (conta.ambiente || "producao") === "sandbox" ? undefined : _agentePrefix(conta.env_prefix || ""),
    timeout: 40000,
  });
  const d = r.data || {};
  return d.transacoes || d.resultado?.transacoes || [];
}

// Monta as janelas MENSAIS que a API do Sicoob exige (a consulta é por mês,
// com diaInicial/diaFinal). Um período de 3 meses vira 3 chamadas por conta.
function _janelasPeriodo(dIni, dFim) {
  const janelas = [];
  let ano = dIni.getFullYear(), mes = dIni.getMonth();
  while (ano < dFim.getFullYear() || (ano === dFim.getFullYear() && mes <= dFim.getMonth())) {
    const primeiro = (ano === dIni.getFullYear() && mes === dIni.getMonth()) ? dIni.getDate() : 1;
    const ultimoDoMes = new Date(ano, mes + 1, 0).getDate();
    const ultimo = (ano === dFim.getFullYear() && mes === dFim.getMonth()) ? dFim.getDate() : ultimoDoMes;
    janelas.push({ mes: mes + 1, ano, d1: primeiro, d2: ultimo });
    mes++;
    if (mes > 11) { mes = 0; ano++; }
    if (janelas.length > 36) break;      // trava: no máximo 3 anos por chamada
  }
  return janelas;
}

// opts.desde / opts.ate ("aaaa-mm-dd") importam um período fechado — usado para
// buscar extrato ANTIGO, anterior ao início da importação automática. Sem opts,
// mantém o comportamento de sempre: os últimos EXTRATO_DIAS.
// opts.empresa limita a uma conta (o resto do grupo não é tocado).
async function importarExtratos(opts) {
  if (!CFG.supaUrl || !CFG.supaKey) return { erro: "Supabase não configurado" };
  opts = opts || {};
  const res = { contas: 0, gravados: 0, lidos: 0 };
  let contas = await _supaGet("oct_sicoob_contas?ativo=eq.true&select=*");
  if (opts.empresa) contas = contas.filter(c => c.empresa_id === opts.empresa);
  const hoje = new Date();
  let janelas;
  if (opts.desde) {
    const p = (t) => { const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
    const dIni = p(opts.desde), dFim = p(opts.ate) || hoje;
    if (!dIni) return { erro: "desde inválido (use aaaa-mm-dd)" };
    if (dFim < dIni) return { erro: "ate anterior a desde" };
    janelas = _janelasPeriodo(dIni, dFim);
    res.periodo = { desde: opts.desde, ate: opts.ate || null, janelas: janelas.length };
  } else {
    const ini = new Date(hoje.getTime() - EXT.dias * 864e5);
    janelas = _janelasPeriodo(ini, hoje);
  }
  for (const conta of contas) {
    res.contas++;
    const st = { lidos: 0, gravados: 0, erro: null };
    try {
      const linhas = [];
      for (const j of janelas) {
        const trans = await _extratoConta(conta, j.mes, j.ano, j.d1, j.d2);
        st.lidos += trans.length;
        // id determinístico: conta+data+doc+valor+descrição+contador entre iguais
        const vistos = {};
        for (const t of trans) {
          const data = _dataISO(t.data) || _dataISO(t.dataLote);
          const valor = _valorNum(t.valor);
          if (!data || valor === null) continue;
          const tipoStr = String(t.tipo || "").toUpperCase();
          const debito = /D[EÉ]B/.test(tipoStr) || valor < 0;
          const chave = `${conta.empresa_id}|${data}|${t.numeroDocumento || ""}|${Math.abs(valor)}|${(t.descricao || "").slice(0, 40)}`;
          vistos[chave] = (vistos[chave] || 0) + 1;
          linhas.push({
            // produção tem transactionId (id perfeito); fallback: hash determinístico
            id: t.transactionId ? "sicoob-" + t.transactionId
              : crypto.createHash("sha1").update(`${chave}|${vistos[chave]}`).digest("hex"),
            empresa_id: conta.empresa_id, banco: "sicoob",
            data, valor: Math.abs(valor), tipo: debito ? "debito" : "credito",
            descricao: (t.descricao || "").slice(0, 200) || null,
            documento: t.numeroDocumento || null,
            cpf_cnpj: (t.cpfCnpj || "").replace(/\D/g, "") || null,
            info: (t.descInfComplementar || "").slice(0, 300) || null,
          });
        }
      }
      if (linhas.length) {
        await axios.post(`${CFG.supaUrl}/rest/v1/oct_banco_movimentos?on_conflict=id`, linhas, {
          headers: _supaHeaders({ Prefer: "resolution=ignore-duplicates,return=minimal" }), timeout: 40000,
        });
        st.gravados = linhas.length;
        res.gravados += linhas.length;
      }
      res.lidos += st.lidos;
    } catch (e) {
      st.erro = (e.response ? JSON.stringify(e.response.data) : e.message).slice(0, 300);
    }
    EXT.estado.contas[conta.empresa_id] = { ...st, quando: new Date().toISOString() };
  }
  EXT.estado.ultima = new Date().toISOString();
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
    cobranca: { escopo: COB.scope, dry_run: COB.dryRun },
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

// GET /extrato/status → última importação por conta
app.get("/extrato/status", (req, res) => {
  res.json({ ok: true, ativo: EXT.ativo, poll_seg: EXT.pollSeg, dias: EXT.dias, ...EXT.estado });
});

// POST /extrato/sync → importa os extratos agora (teste/manual)
//   sem corpo            = últimos EXTRATO_DIAS (o de sempre)
//   {desde,ate,empresa}  = período fechado, para buscar extrato ANTIGO
// Aceita também por querystring: /extrato/sync?desde=2026-03-01&ate=2026-06-30
app.post("/extrato/sync", async (req, res) => {
  if (!checaToken(req, res)) return;
  const q = Object.assign({}, req.query || {}, req.body || {});
  try { res.json(await importarExtratos({ desde: q.desde, ate: q.ate, empresa: q.empresa })); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ============================================================
// COBRANÇA BANCÁRIA — registro de BOLETO (Sicoob API v3)
// ------------------------------------------------------------
// O Faturar agrupa notas a prazo numa fatura; aqui essa fatura vira um boleto
// REGISTRADO no banco. Boleto sem registro não é pago nem baixa — por isso o
// registro é o passo que importa, não o desenho do papel.
//
// Reaproveita o que o extrato já montou: conta por posto em oct_sicoob_contas,
// certificado mTLS por prefixo (SICOOB_CERT_PEM_B64_<PREFIX>) e token OAuth.
// O que muda é o ESCOPO: cobrança é outro produto no portal do Sicoob.
//
// Envs: SICOOB_COBRANCA_SCOPE (padrão abaixo), COBRANCA_DRY_RUN=1 para simular.
// ============================================================
const COB = {
  urlSandbox: "https://sandbox.sicoob.com.br/sicoob/sandbox/cobranca-bancaria/v3",
  urlProd: "https://api.sicoob.com.br/cobranca-bancaria/v3",
  scope: process.env.SICOOB_COBRANCA_SCOPE ||
         "boletos_inclusao boletos_consulta boletos_alteracao",
  dryRun: process.env.COBRANCA_DRY_RUN !== "0",   // por padrão NÃO chama o banco
};

const _tokCob = {};
async function _tokenCobranca(conta) {
  if ((conta.ambiente || "producao") === "sandbox") return CFG.sandboxToken;
  const k = "cob:" + conta.empresa_id;
  const c = _tokCob[k];
  if (c && Date.now() < c.exp - 30000) return c.tok;
  const body = new URLSearchParams({
    grant_type: "client_credentials", client_id: conta.client_id, scope: COB.scope,
  });
  const r = await axios.post(CFG.tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    httpsAgent: _agentePrefix(conta.env_prefix || ""), timeout: 30000,
  });
  _tokCob[k] = { tok: r.data.access_token, exp: Date.now() + Number(r.data.expires_in || 300) * 1000 };
  return _tokCob[k].tok;
}

function _so_digitos(v) { return String(v || "").replace(/\D/g, ""); }

// O Sicoob recusa o registro (HTTP 400) quando falta dado do pagador. Conferir
// ANTES economiza uma ida ao banco e devolve um erro que o operador entende.
function _validarPagador(p) {
  const faltas = [];
  const doc = _so_digitos(p.documento);
  if (doc.length !== 11 && doc.length !== 14) faltas.push("CPF/CNPJ");
  if (!String(p.nome || "").trim()) faltas.push("nome");
  if (!String(p.endereco || "").trim()) faltas.push("endereço");
  if (!String(p.bairro || "").trim()) faltas.push("bairro");
  if (!String(p.cidade || "").trim()) faltas.push("cidade");
  if (_so_digitos(p.cep).length !== 8) faltas.push("CEP");
  if (!String(p.uf || "").trim()) faltas.push("UF");
  return faltas;
}

// Nosso número: sequencial DENTRO da faixa que o convênio reservou. Reservado de
// forma atômica no banco (lê e grava o próximo) para dois boletos simultâneos
// não pegarem o mesmo número — a UNIQUE de oct_boletos é a rede de segurança.
async function _proximoNossoNumero(conta) {
  const ini = Number(conta.nosso_numero_ini || 1);
  const fim = Number(conta.nosso_numero_fim || 0);
  const atual = Number(conta.nosso_numero_atual || 0);
  const prox = Math.max(atual + 1, ini);
  if (fim && prox > fim) throw new Error(`faixa de nosso número esgotada (${ini}-${fim})`);
  await _supaPatch(`oct_sicoob_contas?empresa_id=eq.${conta.empresa_id}`,
                   { nosso_numero_atual: prox }, "return=minimal");
  return prox;
}

function _montarBoleto(conta, fatura, pagador, nossoNumero) {
  const hoje = new Date().toISOString().slice(0, 10);
  const doc = _so_digitos(pagador.documento);
  return {
    numeroCliente: Number(conta.numero_cliente),
    codigoModalidade: Number(conta.cobranca_modalidade || 1),
    numeroContaCorrente: Number(_so_digitos(conta.numero_conta)) || 0,
    codigoEspecieDocumento: "DM",             // duplicata mercantil
    dataEmissao: hoje,
    nossoNumero: Number(nossoNumero),
    seuNumero: String(fatura.numero || fatura.id || "").slice(0, 18),
    identificacaoBoletoEmpresa: String(fatura.numero || "").slice(0, 25),
    identificacaoEmissaoBoleto: 2,            // 2 = cliente emite
    identificacaoDistribuicaoBoleto: 2,       // 2 = cliente distribui
    valor: Number(fatura.valor),
    dataVencimento: String(fatura.vencimento).slice(0, 10),
    numeroParcela: 1,
    pagador: {
      numeroCpfCnpj: doc,
      nome: String(pagador.nome || "").slice(0, 50),
      endereco: String(pagador.endereco || "").slice(0, 40),
      bairro: String(pagador.bairro || "").slice(0, 30),
      cidade: String(pagador.cidade || "").slice(0, 30),
      cep: _so_digitos(pagador.cep),
      uf: String(pagador.uf || "").toUpperCase().slice(0, 2),
      email: String(pagador.email || "").slice(0, 60) || undefined,
    },
  };
}

// Registra o boleto de UMA fatura. Devolve {http, corpo} para a rota e para o
// worker responderem igual. Nunca lanca: erro vira linha 'erro' em oct_boletos,
// para o operador ver na tela o motivo em vez de um silencio.
async function registrarBoleto(fatura_id, opts) {
  opts = opts || {};
  const fat = (await _supaGet(`oct_faturas?id=eq.${fatura_id}&select=*`))[0];
  if (!fat) return { http: 404, corpo: { ok: false, erro: "fatura não encontrada" } };
  if (!fat.vencimento) return { http: 400, corpo: { ok: false, erro: "fatura sem vencimento" } };

  const jaTem = (await _supaGet(
    `oct_boletos?fatura_id=eq.${fatura_id}&status=in.(registrado,liquidado)&select=id,nosso_numero`))[0];
  if (jaTem) return { http: 409, corpo: { ok: false, erro: "fatura já tem boleto registrado",
                                          nosso_numero: jaTem.nosso_numero } };

  const conta = (await _supaGet(
    `oct_sicoob_contas?empresa_id=eq.${fat.empresa_id}&ativo=eq.true&select=*`))[0];
  if (!conta) return { http: 400, corpo: { ok: false, erro: "posto sem conta Sicoob configurada" } };
  // numero_cliente e' indispensavel ate' para MONTAR o payload.
  if (!conta.numero_cliente)
    return { http: 400, corpo: { ok: false, erro: "convênio de cobrança não configurado para este posto",
      detalhe: "falta numero_cliente em oct_sicoob_contas" } };
  // cobranca_ativa e' a trava de EMISSAO, nao de simulacao: no dry-run o payload
  // precisa poder ser montado e conferido ANTES de alguem ligar a chave.
  if (!conta.cobranca_ativa && !COB.dryRun)
    return { http: 400, corpo: { ok: false, erro: "cobrança não está ativa para este posto",
      detalhe: "ligue cobranca_ativa em oct_sicoob_contas quando quiser emitir de verdade" } };

  const pag = (await _supaGet(`oct_pessoas?id=eq.${fat.cliente_id}&select=*`))[0];
  if (!pag) return { http: 400, corpo: { ok: false, erro: "cliente da fatura não encontrado" } };
  const faltas = _validarPagador(pag);
  if (faltas.length)
    return { http: 422, corpo: { ok: false, erro: "cadastro do cliente incompleto para boleto",
                                 faltando: faltas, cliente: pag.nome } };

  // TOKEN PRIMEIRO: reservar o nosso numero antes queimava um numero da faixa a
  // cada falha de autenticacao (o contador nao volta atras).
  let token = null;
  if (!COB.dryRun) {
    try {
      token = await _tokenCobranca(conta);
    } catch (e) {
      const det = e.response?.data || e.message;
      // DIAGNOSTICO: o mesmo client_id/certificado autentica no escopo do
      // EXTRATO? Se sim, credencial esta' boa e o que falta e' o PRODUTO de
      // cobranca na aplicacao do portal. Se nao, o problema e' client_id/cert.
      // QUAL certificado o gateway esta' mandando? O Sicoob amarra o client_id ao
      // certificado usado no cadastro da aplicacao -- se o Railway manda outro
      // (ou um vencido), o erro e' invalid_client mesmo com a aplicacao ATIVA.
      let certInfo = "sem certificado";
      try {
        const pfx = conta.env_prefix || "";
        const pem = process.env[`SICOOB_CERT_PEM_B64_${pfx}`];
        const bruto = pem ? Buffer.from(pem, "base64") : (CFG.pfxB64 ? null : null);
        if (bruto) {
          const x = new crypto.X509Certificate(bruto);
          certInfo = `${x.subject.replace(/
/g, " ").slice(0, 90)} | vale ate ${x.validTo}`;
        } else {
          certInfo = `SICOOB_CERT_PEM_B64_${pfx} NAO existe -> caiu no certificado GLOBAL`;
        }
      } catch (e3) { certInfo = "erro ao ler certificado: " + String(e3.message).slice(0, 80); }
      let diag = "nao testado";
      try {
        const b2 = new URLSearchParams({ grant_type: "client_credentials",
                                         client_id: conta.client_id, scope: EXT.scope });
        await axios.post(CFG.tokenUrl, b2.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          httpsAgent: _agentePrefix(conta.env_prefix || ""), timeout: 30000,
        });
        diag = "credencial OK no escopo do EXTRATO -> falta o produto/escopo de COBRANCA na aplicacao";
      } catch (e2) {
        diag = "falhou tambem no escopo do EXTRATO (" +
               JSON.stringify(e2.response?.data || e2.message).slice(0, 160) +
               ") -> client_id ou certificado";
      }
      return { http: 401, corpo: { ok: false, erro: "Sicoob não autorizou o token de cobrança",
                                   detalhe: det, diagnostico: diag },
               patch: { status: "erro",
                        erro: ("TOKEN: " + JSON.stringify(det) + " | DIAG: " + diag +
                               " | CERT: " + certInfo).slice(0, 900) } };
    }
  }

  const nossoNumero = await _proximoNossoNumero(conta);
  const corpo = _montarBoleto(conta, fat, pag, nossoNumero);
  const patch = {
    nosso_numero: String(nossoNumero), seu_numero: corpo.seuNumero,
    numero_contrato: String(conta.numero_cliente), modalidade: corpo.codigoModalidade,
  };

  if (COB.dryRun) {
    // grava o PAYLOAD em `resposta`: no dry-run pelo worker o retorno HTTP e'
    // descartado, e sem isto a simulacao nao mostraria nada de util.
    return { http: 200, corpo: { ok: true, dry_run: true, corpo_que_seria_enviado: corpo },
             patch: { ...patch, status: "simulado", erro: "COBRANCA_DRY_RUN ligado — não foi ao banco",
                      resposta: { dry_run: true, payload: corpo } } };
  }

  const base = (conta.ambiente || "producao") === "sandbox" ? COB.urlSandbox : COB.urlProd;
  try {
    const resp = await axios.post(`${base}/boletos`, corpo, {
      headers: { Authorization: `Bearer ${token}`, client_id: conta.client_id,
                 "Content-Type": "application/json" },
      httpsAgent: (conta.ambiente || "producao") === "sandbox" ? undefined
                                                               : _agentePrefix(conta.env_prefix || ""),
      timeout: 40000,
    });
    const d = resp.data?.resultado || resp.data || {};
    return { http: 200, corpo: { ok: true, nosso_numero: String(nossoNumero) }, patch: {
      ...patch, status: "registrado", registrado_em: new Date().toISOString(),
      linha_digitavel: d.linhaDigitavel || d.linha_digitavel || null,
      codigo_barras: d.codigoBarras || d.codigo_barras || null,
      pix_copia_cola: d.qrCode || d.pixCopiaECola || null,
      resposta: resp.data, erro: null,
    } };
  } catch (e) {
    const det = e.response?.data || e.message;
    return { http: 502, corpo: { ok: false, erro: "Sicoob recusou o registro", detalhe: det },
             patch: { ...patch, status: "erro", erro: JSON.stringify(det).slice(0, 900) } };
  }
}

// POST /boleto/registrar { fatura_id }
app.post("/boleto/registrar", async (req, res) => {
  if (!checaToken(req, res)) return;
  try {
    const { fatura_id } = req.body || {};
    if (!fatura_id) return res.status(400).json({ ok: false, erro: "fatura_id obrigatório" });
    const r = await registrarBoleto(fatura_id);
    if (r.patch) {
      const linha = (await _supaGet(`oct_boletos?fatura_id=eq.${fatura_id}&order=id.desc&limit=1&select=id`))[0];
      if (linha) await _supaPatch(`oct_boletos?id=eq.${linha.id}`, r.patch, "return=minimal");
    }
    res.status(r.http).json(r.corpo);
  } catch (e) {
    res.status(500).json({ ok: false, erro: String(e.message || e) });
  }
});

// ---------- WORKER: pega os boletos que a tela deixou 'pendente' ----------
// A tela do Faturar so' INSERE a linha pendente; quem tem o certificado e' aqui.
const BOL_POLL = Number(process.env.BOLETO_POLL_SEGUNDOS || 20);
async function _workerBoletos() {
  try {
    const pend = await _supaGet(
      "oct_boletos?status=eq.pendente&select=id,fatura_id&order=criado_em&limit=20");
    for (const b of pend) {
      let r;
      try {
        r = await registrarBoleto(b.fatura_id);
      } catch (e) {
        r = { patch: { status: "erro", erro: String(e.message || e).slice(0, 900) } };
      }
      const patch = r.patch || { status: "erro", erro: JSON.stringify(r.corpo || {}).slice(0, 900) };
      await _supaPatch(`oct_boletos?id=eq.${b.id}`, patch, "return=minimal");
    }
  } catch (e) {
    console.error("[boletos] worker:", e.message);
  }
}
if (process.env.BOLETO_WORKER === "1") {
  setInterval(_workerBoletos, BOL_POLL * 1000);
  console.log(`[boletos] worker ligado (a cada ${BOL_POLL}s)`);
}

// GET /boleto/consultar?empresa_id=..&nosso_numero=..
app.get("/boleto/consultar", async (req, res) => {
  if (!checaToken(req, res)) return;
  try {
    const { empresa_id, nosso_numero } = req.query || {};
    const conta = (await _supaGet(
      `oct_sicoob_contas?empresa_id=eq.${empresa_id}&ativo=eq.true&select=*`))[0];
    if (!conta) return res.status(400).json({ ok: false, erro: "posto sem conta Sicoob" });
    const base = (conta.ambiente || "producao") === "sandbox" ? COB.urlSandbox : COB.urlProd;
    const token = await _tokenCobranca(conta);
    const r = await axios.get(`${base}/boletos?numeroCliente=${conta.numero_cliente}` +
                              `&codigoModalidade=${conta.cobranca_modalidade || 1}` +
                              `&nossoNumero=${nosso_numero}`, {
      headers: { Authorization: `Bearer ${token}`, client_id: conta.client_id },
      httpsAgent: (conta.ambiente || "producao") === "sandbox" ? undefined
                                                               : _agentePrefix(conta.env_prefix || ""),
      timeout: 30000,
    });
    res.json({ ok: true, dados: r.data });
  } catch (e) {
    res.status(502).json({ ok: false, erro: e.response?.data || String(e.message || e) });
  }
});


app.listen(CFG.porta, () => {
  console.log(`octano-sicoob on :${CFG.porta} [${CFG.ambiente}] dry_run=${CFG.dryRun} worker=${CFG.workerAtivo}`);
  if (CFG.workerAtivo) {
    setInterval(() => { processarPendentes().then(r => { if (r.pagos || r.falhas) console.log("worker:", JSON.stringify(r)); }); },
      Math.max(15, CFG.pollSeg) * 1000);
  }
  if (EXT.ativo) {
    importarExtratos().then(r => console.log("extrato:", JSON.stringify(r))).catch(e => console.log("extrato:", e.message));
    setInterval(() => {
      importarExtratos().then(r => { if (r.gravados) console.log("extrato:", JSON.stringify(r)); })
        .catch(e => console.log("extrato:", e.message));
    }, Math.max(300, EXT.pollSeg) * 1000);
  }
});
