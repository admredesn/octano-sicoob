// ============================================================
// pix_cobranca.js — PIX PELO APP (14/10/2026): cobranca por compra a prazo / fatura, baixa automatica
// ------------------------------------------------------------
// Fila no banco (oct_pix_cobrancas), mesmo padrao dos boletos: o servidor/app so' INSERE 'pedido';
// quem tem o certificado e' este gateway.
//
//   pedido -> (cria a cobranca imediata PUT /cob/{txid}) -> ativa -> (GET /pix achou o txid) -> paga
//   paga   -> rpc oct_pix_lancar_baixa(id): recebimento (forma Pix) + nota 'pago' / fatura 'liquidada'
//   ativa vencida sem pagamento -> expirada
//
// SEM WEBHOOK: o Florestal ja' tem o da Shipay na chave e cada chave so' aceita um. Consulta por polling:
// UMA chamada GET /pix por posto traz todos os Pix da janela (com txid), serve para todas as cobrancas abertas.
// Rate limit do Sicoob existe (429 "Assembly Rate Limit"): backoff de 60 s por posto.
// Envs: PIX_WORKER=1 liga; PIX_EXPIRACAO_SEG (3600); PIX_POLL_SEGUNDOS (15); PIX_PEDIDO_SEGUNDOS (3).
// Por posto: oct_sicoob_contas.pix_ativo = true e chave_pix preenchida (chave REAL, sem mascara).
// ============================================================
function somenteDigitos(v) { return String(v || "").replace(/\D/g, ""); }

function cpfOk(c) {
  c = somenteDigitos(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[n])) return false;
  }
  return true;
}
function cnpjOk(c) {
  c = somenteDigitos(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [12, 13]) {
    let s = 0, p = n - 7;
    for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; }
    if (((s % 11) < 2 ? 0 : 11 - (s % 11)) !== Number(c[n])) return false;
  }
  return true;
}

// resumo curto e SEM dado pessoal de um erro da API (vai para a coluna erro)
function erroApi(r) {
  const d = (r && r.data) || {};
  const v = Array.isArray(d.violacoes) ? d.violacoes.map(x => x.razao || x.propriedade).join("; ") : "";
  return `HTTP ${r && r.status}: ${d.title || d.httpMessage || ""} ${d.detail || ""} ${v}`.replace(/\s+/g, " ").trim().slice(0, 500);
}

module.exports = function criarPix(deps) {
  const { axios, tokenUrl, supaGet, supaPatch, supaRpc, agentePrefix, log, agora, aleatorioHex } = deps;
  const BASE = process.env.SICOOB_PIX_URL || "https://api.sicoob.com.br/pix/api/v2";
  const EXPIRACAO = Number(process.env.PIX_EXPIRACAO_SEG || 3600);
  const SCOPE = "cob.write cob.read pix.read";
  const pausaAte = {};      // empresa -> ms (429)
  const ultimaConsulta = {}; // empresa -> ms
  const tokens = {};        // empresa -> {tok, exp}
  const agoraMs = () => (agora ? agora() : Date.now());
  const iso = (ms) => new Date(ms).toISOString();

  async function contaPix(empresaId) {
    const rows = await supaGet(`oct_sicoob_contas?empresa_id=eq.${empresaId}&ativo=eq.true&select=*`);
    const c = (rows || [])[0];
    if (!c || c.pix_ativo !== true || !String(c.chave_pix || "").trim() || String(c.chave_pix).includes("*")) return null;
    if ((c.ambiente || "producao") !== "producao") return null;
    return c;
  }

  async function token(conta) {
    const k = conta.empresa_id;
    const c = tokens[k];
    if (c && agoraMs() < c.exp - 30000) return c.tok;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: conta.client_id, scope: SCOPE });
    const r = await axios.post(tokenUrl, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      httpsAgent: agentePrefix(conta.env_prefix || ""), timeout: 30000,
    });
    tokens[k] = { tok: r.data.access_token, exp: agoraMs() + Number(r.data.expires_in || 300) * 1000 };
    return tokens[k].tok;
  }

  async function chamar(conta, metodo, rota, corpo) {
    const tok = await token(conta);
    const r = await axios.request({
      method: metodo, url: BASE + rota, data: corpo,
      headers: { Authorization: `Bearer ${tok}`, client_id: conta.client_id, Accept: "application/json" },
      httpsAgent: agentePrefix(conta.env_prefix || ""), timeout: 30000,
      validateStatus: () => true,
    });
    if (r.status === 429) pausaAte[conta.empresa_id] = agoraMs() + 60000;
    return r;
  }

  // ---------------- 1. pedido -> cobranca ativa ----------------
  async function criarCobranca(p) {
    // reivindica a linha: so' passa se ainda estava 'pedido' (nunca cria 2 cobrancas para o mesmo pedido)
    const pegou = await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}&status=eq.pedido`,
      { status: "criando", atualizado_em: iso(agoraMs()) }, "return=representation");
    if (!Array.isArray(pegou) || !pegou.length) return { pulou: true };
    const falhar = async (msg) => {
      await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}`, { status: "erro", erro: String(msg).slice(0, 500), atualizado_em: iso(agoraMs()) }, "return=minimal");
      return { erro: msg };
    };
    const conta = await contaPix(p.empresa_id);
    if (!conta) return falhar("Pix pelo app nao habilitado neste posto (pix_ativo/chave_pix).");
    if (pausaAte[p.empresa_id] && agoraMs() < pausaAte[p.empresa_id]) {
      await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}`, { status: "pedido", atualizado_em: iso(agoraMs()) }, "return=minimal");
      return { adiou: true };
    }
    // confere o alvo AGORA (o valor pode ter mudado desde o pedido) e descobre quem e' o devedor
    let valor = Number(p.valor), clienteId = p.cliente_id;
    if (p.nota_prazo_id) {
      const n = ((await supaGet(`oct_pdv_notas_prazo?id=eq.${p.nota_prazo_id}&select=id,status,fatura_id,valor,cliente_id`)) || [])[0];
      if (!n) return falhar("Compra nao encontrada.");
      if (n.status !== "aberto" || n.fatura_id) return falhar("Esta compra ja foi paga ou entrou numa fatura.");
      valor = Number(n.valor); clienteId = n.cliente_id || clienteId;
    } else if (p.fatura_id) {
      const f = ((await supaGet(`oct_faturas?id=eq.${p.fatura_id}&select=id,status,valor,valor_liquido,desconto,acrescimo,cliente_id`)) || [])[0];
      if (!f) return falhar("Fatura nao encontrada.");
      if (f.status !== "aberta") return falhar("Esta fatura nao esta em aberto.");
      const liq = f.valor_liquido != null ? Number(f.valor_liquido) : Number(f.valor) - Number(f.desconto || 0) + Number(f.acrescimo || 0);
      const rec = (await supaGet(`oct_recebimentos_titulo?fatura_id=eq.${p.fatura_id}&select=valor`)) || [];
      valor = Math.round((liq - rec.reduce((s, r) => s + Number(r.valor || 0), 0)) * 100) / 100;
      clienteId = f.cliente_id || clienteId;
    }
    if (!(valor > 0)) return falhar("Nada a pagar neste titulo.");
    const corpo = {
      calendario: { expiracao: EXPIRACAO },
      valor: { original: valor.toFixed(2) },
      chave: String(conta.chave_pix).trim(),
      solicitacaoPagador: "Octano - compra a prazo",
    };
    if (clienteId) {
      const pes = ((await supaGet(`oct_pessoas?id=eq.${clienteId}&select=nome,documento`)) || [])[0];
      const doc = somenteDigitos(pes && pes.documento);
      if (pes && pes.nome && cpfOk(doc)) corpo.devedor = { cpf: doc, nome: String(pes.nome).slice(0, 200) };
      else if (pes && pes.nome && cnpjOk(doc)) corpo.devedor = { cnpj: doc, nome: String(pes.nome).slice(0, 200) };
    }
    const txid = "oct" + aleatorioHex(15);          // 33 caracteres [a-z0-9]
    let r = await chamar(conta, "PUT", `/cob/${txid}`, corpo);
    if (r.status === 400 && corpo.devedor) {         // devedor recusado por qualquer motivo: tenta sem ele
      delete corpo.devedor;
      r = await chamar(conta, "PUT", `/cob/${txid}`, corpo);
    }
    if (r.status === 429) {
      await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}`, { status: "pedido", atualizado_em: iso(agoraMs()) }, "return=minimal");
      return { adiou: true };
    }
    if (r.status !== 200 && r.status !== 201) return falhar(erroApi(r));
    const d = r.data || {};
    await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}`, {
      status: "ativa", txid, valor, copia_cola: d.pixCopiaECola || d.brcode || null, location: d.location || null,
      expira_em: iso(agoraMs() + EXPIRACAO * 1000), atualizado_em: iso(agoraMs()),
    }, "return=minimal");
    log(`[pix] cobranca ${txid.slice(0, 10)}... R$ ${valor.toFixed(2)} (pedido ${p.id})`);
    return { ok: true, txid };
  }

  async function processarPedidos() {
    const ped = await supaGet("oct_pix_cobrancas?status=eq.pedido&select=*&order=id&limit=10");
    const out = { criadas: 0, erros: 0 };
    for (const p of ped || []) {
      try {
        const r = await criarCobranca(p);
        if (r.ok) out.criadas++; else if (r.erro) out.erros++;
      } catch (e) {
        out.erros++;
        await supaPatch(`oct_pix_cobrancas?id=eq.${p.id}`, { status: "erro", erro: String((e.response && e.response.data && JSON.stringify(e.response.data)) || e.message || e).slice(0, 500), atualizado_em: iso(agoraMs()) }, "return=minimal").catch(() => {});
      }
    }
    return out;
  }

  // ---------------- 2. cobranca ativa -> paga (+ baixa) ----------------
  async function marcarPaga(row, pix) {
    const pg = pix.pagador || {};
    await supaPatch(`oct_pix_cobrancas?id=eq.${row.id}`, {
      status: "paga", e2e: pix.endToEndId || null, valor_pago: Number(pix.valor),
      pago_em: pix.horario || iso(agoraMs()),
      pagador_doc: somenteDigitos(pg.cpf || pg.cnpj) || null, pagador_nome: pix.nomePagador || pg.nome || null,
      atualizado_em: iso(agoraMs()),
    }, "return=minimal");
    const res = await supaRpc("oct_pix_lancar_baixa", { p_id: row.id });
    log(`[pix] PAGA ${String(row.txid).slice(0, 10)}... R$ ${Number(pix.valor).toFixed(2)} -> ${res}`);
    return res;
  }

  async function pixDaJanela(conta, desdeMs) {
    const mapa = {};
    for (let pg = 0; pg < 5; pg++) {
      const q = `?inicio=${encodeURIComponent(iso(desdeMs).replace(/\.\d+Z$/, "Z"))}&fim=${encodeURIComponent(iso(agoraMs()).replace(/\.\d+Z$/, "Z"))}&paginaAtual=${pg}`;
      const r = await chamar(conta, "GET", "/pix" + q);
      if (r.status !== 200) return { erro: erroApi(r), status: r.status, mapa };
      for (const p of r.data.pix || []) if (p.txid) (mapa[p.txid] = mapa[p.txid] || []).push(p);
      const pag = (r.data.parametros || {}).paginacao || {};
      if (!(pag.quantidadeDePaginas > pg + 1)) break;
    }
    return { mapa };
  }

  async function consultar() {
    const out = { pagas: 0, expiradas: 0, retentadas: 0 };
    // baixa que falhou antes (rpc fora do ar etc.): idempotente, tenta de novo
    const semBaixa = await supaGet("oct_pix_cobrancas?status=eq.paga&baixa=is.null&select=id&limit=20");
    for (const b of semBaixa || []) { try { await supaRpc("oct_pix_lancar_baixa", { p_id: b.id }); out.retentadas++; } catch (e) { log(`[pix] baixa ${b.id}: ${e.message}`); } }
    // 'criando' esquecida (processo caiu no meio): vira erro para nao ficar presa
    await supaPatch(`oct_pix_cobrancas?status=eq.criando&atualizado_em=lt.${encodeURIComponent(iso(agoraMs() - 300000))}`,
      { status: "erro", erro: "interrompido durante a criacao (verificar no Sicoob)" }, "return=minimal").catch(() => {});

    const ativas = await supaGet("oct_pix_cobrancas?status=eq.ativa&select=*&order=id&limit=200");
    if (!Array.isArray(ativas) || !ativas.length) return out;
    const porEmpresa = {};
    for (const a of ativas) (porEmpresa[a.empresa_id] = porEmpresa[a.empresa_id] || []).push(a);
    for (const emp of Object.keys(porEmpresa)) {
      const rows = porEmpresa[emp];
      if (pausaAte[emp] && agoraMs() < pausaAte[emp]) continue;
      // cobranca recente (< 3 min): consulta a cada tick; mais velha: no maximo a cada 45 s
      const recente = rows.some(r => agoraMs() - Date.parse(r.criado_em) < 180000);
      if (!recente && ultimaConsulta[emp] && agoraMs() - ultimaConsulta[emp] < 45000) continue;
      const conta = await contaPix(emp);
      if (!conta) continue;
      ultimaConsulta[emp] = agoraMs();
      const desde = Math.min(...rows.map(r => Date.parse(r.criado_em))) - 300000;
      const j = await pixDaJanela(conta, desde);
      if (j.erro) { log(`[pix] consulta ${emp.slice(0, 8)}: ${j.erro}`); continue; }
      for (const r of rows) {
        const pagos = j.mapa[r.txid];
        if (pagos && pagos.length) {
          // varios Pix no mesmo txid nao deveriam existir (cobranca imediata paga uma vez); soma e deixa a baixa decidir
          const tot = pagos.reduce((s, p) => s + Number(p.valor), 0);
          await marcarPaga(r, Object.assign({}, pagos[0], { valor: tot.toFixed(2) }));
          out.pagas++;
        } else if (r.expira_em && agoraMs() > Date.parse(r.expira_em) + 90000) {
          // vencida: confere uma vez no banco antes de dar por expirada
          const c = await chamar(conta, "GET", `/cob/${r.txid}`);
          if (c.status === 200 && c.data.status === "CONCLUIDA" && Array.isArray(c.data.pix) && c.data.pix.length) {
            await marcarPaga(r, c.data.pix[0]); out.pagas++;
          } else if (c.status === 200 || c.status === 404) {
            await supaPatch(`oct_pix_cobrancas?id=eq.${r.id}&status=eq.ativa`, { status: "expirada", atualizado_em: iso(agoraMs()) }, "return=minimal");
            out.expiradas++;
          }
        }
      }
    }
    return out;
  }

  return { processarPedidos, consultar, criarCobranca, _t: { cpfOk, cnpjOk, erroApi, pausaAte, tokens } };
};
module.exports.cpfOk = cpfOk;
module.exports.cnpjOk = cnpjOk;
