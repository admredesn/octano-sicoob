// ============================================================
// boleto_pdf.js — desenha a ficha de compensação do Sicoob em PDF.
// ------------------------------------------------------------
// POR QUE existe: a API de Cobrança v3 NÃO entrega PDF. Ela registra o título e
// devolve linha digitável + código de barras; desenhar o boleto é do emissor --
// é o que diz o rodapé dos boletos do posto ("EMITIDO PELA COOPERATIVA
// CONTRATANTE SEM RESPONSABILIDADE DO BANCOOB").
//
// O layout veio das COORDENADAS do boleto real do Florestal e foi conferido
// lado a lado com ele: RECIBO DO PAGADOR em cima, linha de corte, FICHA DE
// COMPENSAÇÃO embaixo. Cada campo é uma CAIXA fechada, com rótulo miúdo em
// cima e valor em negrito embaixo.
//
// Mora aqui (e não no retaguarda) porque o ENVIO precisa de um arquivo: a tela
// imprime direto do HTML, mas o WhatsApp e o e-mail precisam do PDF pronto.
// ============================================================
const PDFDocument = require("pdfkit");

const MM = 2.834645669;                      // 1 mm em pontos
const mm = (v) => v * MM;

// Interleaved 2 of 5: cada par de dígitos vira 5 barras + 5 espaços,
// onde 1 = larga e 0 = fina. Tabela oficial FEBRABAN.
const I25 = { "0": "00110", "1": "10001", "2": "01001", "3": "11000", "4": "00101",
              "5": "10100", "6": "01100", "7": "00011", "8": "10010", "9": "01010" };

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2,
                                                  maximumFractionDigits: 2 });
}

function dataBr(s) {
  s = String(s || "").slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s;
}

function formatarLd(ld) {
  ld = String(ld || "").replace(/\D/g, "");
  if (ld.length !== 47) return ld;
  return `${ld.slice(0, 5)}.${ld.slice(5, 10)}  ${ld.slice(10, 15)}.${ld.slice(15, 21)}  ` +
         `${ld.slice(21, 26)}.${ld.slice(26, 32)}  ${ld.slice(32, 33)}  ${ld.slice(33)}`;
}

// Nosso número: posições 34-41 do campo livre. Calcular o DV por módulo 11 deu
// resultado diferente do boleto real do posto, então não se inventa dígito em
// documento de cobrança -- usa-se o que o banco gravou.
function nossoNumeroDoCodigo(cb, fallback) {
  cb = String(cb || "");
  if (cb.length === 44) {
    const nn = cb.slice(19).slice(14, 22);
    if (/^\d+$/.test(nn)) return String(parseInt(nn, 10));
  }
  return String(fallback || "");
}

class Desenho {
  constructor(doc) { this.d = doc; }

  caixa(x, y, w, h, rotulo, valor, opts) {
    opts = opts || {};
    const d = this.d;
    if (opts.cinza) d.rect(mm(x), mm(y), mm(w), mm(h)).fill("#e9e9e9");
    d.lineWidth(0.6).strokeColor("#000").rect(mm(x), mm(y), mm(w), mm(h)).stroke();
    if (rotulo) {
      d.font("Helvetica").fontSize(5.6).fillColor("#000")
        .text(rotulo, mm(x + 1.1), mm(y + 0.8), { width: mm(w - 2.2), lineBreak: false });
    }
    if (valor !== undefined && valor !== null && valor !== "") {
      d.font(opts.leve ? "Helvetica" : "Helvetica-Bold").fontSize(opts.tam || 8.5)
        .fillColor("#000")
        .text(String(valor), mm(x + 1.1), mm(y + h) - (opts.tam || 8.5) - 1.6,
              { width: mm(w - 2.2), align: opts.alinha || "right", lineBreak: false });
    }
  }

  linhas(x, y, w, textos, opts) {
    opts = opts || {};
    const d = this.d;
    const tam = opts.tam || 7.4;
    const dy = opts.dy || 4.0;
    d.font(opts.leve ? "Helvetica" : "Helvetica-Bold").fontSize(tam).fillColor("#000");
    textos.forEach((t, i) => {
      d.text(String(t == null ? "" : t), mm(x + 1.3), mm(y + (opts.topo || 3.6) + i * dy),
             { width: mm(w - 2.6), lineBreak: false });
    });
  }

  corte(y, x1, x2) {
    const d = this.d;
    d.lineWidth(0.5).strokeColor("#777").dash(3, { space: 3 })
      .moveTo(mm(x1), mm(y)).lineTo(mm(x2), mm(y)).stroke().undash();
  }

  // O 'V' do Sicoob (verde + amarelo) e a palavra. Vetorial, sem arquivo de imagem.
  logo(x, y, alt) {
    alt = alt || 8.5;
    const d = this.d;
    d.save();
    d.fillColor("#00ae9d")
      .moveTo(mm(x), mm(y)).lineTo(mm(x + alt * 0.66), mm(y))
      .lineTo(mm(x + alt * 0.33), mm(y + alt)).fill();
    d.fillColor("#ffc72c")
      .moveTo(mm(x + alt * 0.33), mm(y)).lineTo(mm(x + alt * 0.66), mm(y))
      .lineTo(mm(x + alt * 0.495), mm(y + alt * 0.5)).fill();
    d.font("Helvetica-Bold").fontSize(alt * 1.5).fillColor("#00766a")
      .text("SICOOB", mm(x + alt * 0.74), mm(y + alt * 0.14), { lineBreak: false });
    d.restore();
    d.fillColor("#000");
  }

  barras(codigo, x, y, altura, fina) {
    altura = altura || 13.0;
    fina = fina || 0.32;
    if (!codigo || codigo.length !== 44) return x;
    let fluxo = "0000";                                   // start
    for (let i = 0; i < codigo.length; i += 2) {
      const a = I25[codigo[i]], b = I25[codigo[i + 1]];
      if (!a || !b) return x;
      for (let j = 0; j < 5; j++) fluxo += a[j] + b[j];   // barra + espaço
    }
    fluxo += "100";                                       // stop
    const d = this.d;
    let pos = x;
    for (let i = 0; i < fluxo.length; i++) {
      const larg = fina * (fluxo[i] === "1" ? 3 : 1);
      if (i % 2 === 0) d.rect(mm(pos), mm(y), mm(larg), mm(altura)).fill("#000");
      pos += larg;
    }
    return pos;
  }
}

/**
 * Monta o PDF e devolve um Buffer.
 * @param b     resposta da API do Sicoob (objeto `resultado`)
 * @param conta linha de oct_sicoob_contas
 * @param emp   linha de oct_empresas
 */
function gerarBoletoPdf(b, conta, emp) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const pedacos = [];
    doc.on("data", (c) => pedacos.push(c));
    doc.on("end", () => resolve(Buffer.concat(pedacos)));
    doc.on("error", reject);

    const g = new Desenho(doc);
    const pag = b.pagador || {};
    const coop = String(conta.agencia || "4208");
    const coopBen = `${coop}/${conta.numero_cliente || ""}`;
    const nn = nossoNumeroDoCodigo(b.codigoBarras, b.nossoNumero);
    const venc = dataBr(b.dataVencimento);
    const emiss = dataBr(b.dataEmissao);
    const val = moeda(b.valor);
    const instr = (b.mensagensInstrucao && b.mensagensInstrucao.length)
      ? b.mensagensInstrucao
      : ["Não cobrar encargos por atraso.", "Não conceder desconto."];
    const docnum = String(b.seuNumero || "").trim();

    const L = 12.5, R = 198.0, W = R - L;
    const cE = L + 118.0, cM = cE + 33.5;
    let y = 12.0;

    // ============ RECIBO DO PAGADOR ============
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
      .text("RECIBO DO PAGADOR", mm(L), mm(y - 4.5), { width: mm(W), align: "right" });
    g.logo(L, y);
    y += 12.5;

    let alt = 27.0;
    g.caixa(L, y, cE - L, alt, "Beneficiário");
    g.linhas(L, y, cE - L, [`${emp.nome || ""}          ${emp.cnpj || ""}`,
                            emp.endereco || "",
                            `${emp.cidade || ""} - ${emp.uf || ""}          ${emp.cep || ""}`],
             { dy: 5.6, topo: 4.4 });
    g.caixa(cE, y, cM - cE, 7.0, "Vencimento", venc, { tam: 8 });
    g.caixa(cM, y, R - cM, 7.0, "Valor do Documento", val, { tam: 8 });
    g.caixa(cE, y + 7.0, cM - cE, 6.7, "(+) Outros acréscimos");
    g.caixa(cM, y + 7.0, R - cM, 6.7, "(+) Mora / Multa");
    g.caixa(cE, y + 13.7, cM - cE, 6.7, "(-) Desconto / Abatimento");
    g.caixa(cM, y + 13.7, R - cM, 6.7, "(-) Outras deduções");
    g.caixa(cE, y + 20.4, cM - cE, 6.6, "Data de Emissão", emiss, { tam: 8 });
    g.caixa(cM, y + 20.4, R - cM, 6.6, "(=) Valor cobrado");
    y += alt;

    alt = 13.6;
    g.caixa(L, y, cE - L, alt, "Instruções (texto de responsabilidade do beneficiário)");
    g.linhas(L, y, cE - L, instr.slice(0, 2), { tam: 7.2, dy: 4.2, topo: 4.4 });
    g.caixa(cE, y, R - cE, 6.8, "Coop Contr/Cód. Beneficiário", coopBen, { tam: 8 });
    g.caixa(cE, y + 6.8, R - cE, 6.8, "Nosso Número", nn, { tam: 8 });
    y += alt + 6.0;

    // ---- Dados do Pagador ----
    doc.font("Helvetica").fontSize(6.2).fillColor("#000")
      .text("Dados do Pagador", mm(L), mm(y - 3.6), { lineBreak: false });
    const cN = R - 46;
    g.caixa(L, y, cN - L, 7.4, "Nome do pagador", pag.nome || "", { tam: 8, alinha: "left" });
    g.caixa(cN, y, R - cN, 7.4, "Número do Documento", docnum, { tam: 8 });
    y += 7.4;
    g.caixa(L, y, W, 7.0, "Endereço", pag.endereco || "", { tam: 8, alinha: "left" });
    y += 7.0;
    g.caixa(L, y, W, 7.0, "Bairro / Distrito", pag.bairro || "", { tam: 8, alinha: "left" });
    y += 7.0;
    const cU = L + 128, cC = L + 148;
    g.caixa(L, y, cU - L, 7.0, "Munícipio", pag.cidade || "", { tam: 8, alinha: "left" });
    g.caixa(cU, y, cC - cU, 7.0, "UF", pag.uf || "", { tam: 8, alinha: "center" });
    g.caixa(cC, y, R - cC, 7.0, "CEP", pag.cep || "", { tam: 8 });
    y += 7.0;
    g.caixa(L, y, W, 11.0, "Mensagem Pagador");
    y += 11.0 + 4.5;

    // rodapé do recibo
    doc.rect(mm(L), mm(y), mm(108), mm(13.5)).fill("#e9e9e9");
    doc.font("Helvetica").fontSize(6.2).fillColor("#000");
    ["Este recibo somente terá validade com a autenticação mecânica ou",
     "acompanhado do recibo de pagamento emitido pelo Banco. Recebimento",
     "através do cheque n.________ do banco________  Esta quitação só terá",
     "validade após o pagamento do cheque pelo banco pagador."].forEach((t, i) => {
      doc.text(t, mm(L + 1.5), mm(y + 1.4 + i * 3.0), { width: mm(106), lineBreak: false });
    });
    doc.font("Helvetica").fontSize(7)
      .text("Autenticação mecânica    -", mm(L + 122), mm(y + 0.8), { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7)
      .text("Recibo do pagador", mm(L + 160), mm(y + 0.8), { lineBreak: false });
    doc.lineWidth(0.6).strokeColor("#5a5a5a")
      .moveTo(mm(L + 120), mm(y + 1)).lineTo(mm(L + 120), mm(y + 12)).stroke()
      .moveTo(mm(R), mm(y + 1)).lineTo(mm(R), mm(y + 12)).stroke();
    y += 16.0;

    // ============ corte ============
    g.corte(y, L, R);
    y += 5.0;

    // ============ FICHA DE COMPENSAÇÃO ============
    g.logo(L, y);
    doc.lineWidth(1).strokeColor("#000")
      .moveTo(mm(L + 50), mm(y)).lineTo(mm(L + 50), mm(y + 9)).stroke()
      .moveTo(mm(L + 70), mm(y)).lineTo(mm(L + 70), mm(y + 9)).stroke();
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#000")
      .text("756", mm(L + 51), mm(y + 1.6), { width: mm(18), align: "center", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10.5)
      .text(formatarLd(b.linhaDigitavel), mm(L + 72), mm(y + 2.4),
            { width: mm(R - L - 72), align: "right", lineBreak: false });
    y += 10.0;

    const cD = L + 130.0;
    g.caixa(L, y, cD - L, 8.2, "Local de pagamento", "PAGAVEL PREFERENCIALMENTE NO SICOOB",
            { tam: 8, alinha: "left" });
    g.caixa(cD, y, R - cD, 8.2, "Vencimento", venc, { tam: 8.5, cinza: true });
    y += 8.2;
    g.caixa(L, y, cD - L, 8.2, "Beneficiário", `${emp.nome || ""}     ${emp.cnpj || ""}`,
            { tam: 7.6, alinha: "left" });
    g.caixa(cD, y, R - cD, 8.2, "Cooperativa contratante/Cód. Beneficiário", coopBen, { tam: 8 });
    y += 8.2;

    const xs = [L, L + 30, L + 60, L + 84, L + 100, cD];
    const rot5 = ["Data do documento", "N. documento", "Espécie", "Aceite", "Data processamento"];
    const val5 = [emiss, docnum, b.codigoEspecieDocumento || "DM", "N", emiss];
    for (let i = 0; i < 5; i++) {
      g.caixa(xs[i], y, xs[i + 1] - xs[i], 8.2, rot5[i], val5[i], { tam: 7.6, alinha: "center" });
    }
    g.caixa(cD, y, R - cD, 8.2, "Nosso número", nn, { tam: 8.5 });
    y += 8.2;

    g.caixa(L, y, 30, 8.2, "Uso do Banco", "", { cinza: true });
    const xs2 = [L + 30, L + 52, L + 84, cD];
    const rotB = ["Carteira", "Espécie", "Quantidade"];
    const valB = [String(conta.cobranca_modalidade || 1), "R$", ""];
    for (let i = 0; i < 3; i++) {
      g.caixa(xs2[i], y, xs2[i + 1] - xs2[i], 8.2, rotB[i], valB[i], { tam: 7.6, alinha: "center" });
    }
    g.caixa(cD, y, R - cD, 8.2, "Valor documento", val, { tam: 8.5 });
    y += 8.2;

    alt = 30.0;
    g.caixa(L, y, cD - L, alt, "Instruções (texto de responsabilidade do beneficiário)");
    g.linhas(L, y, cD - L, instr.slice(0, 2), { tam: 7.2, dy: 4.2, topo: 4.4 });
    doc.font("Helvetica").fontSize(5.2).fillColor("#000")
      .text("EMITIDO PELA COOPERATIVA CONTRATANTE SEM RESPONSABILIDADE DO BANCOOB",
            mm(L + 1.5), mm(y + alt - 7.6), { lineBreak: false })
      .text(`COOPERATIVA CONTRATANTE ${coop} SICOOB UFVCREDI`,
            mm(L + 1.5), mm(y + alt - 4.8), { lineBreak: false });
    ["(-) Desconto / Abatimento", "(-) Outras deduções", "(+) Mora / Multa",
     "(+) Outros acréscimos", "(=) Valor cobrado"].forEach((rot, i) => {
      g.caixa(cD, y + i * (alt / 5), R - cD, alt / 5, rot);
    });
    y += alt;

    g.caixa(L, y, cD - L, 19.0, "Pagador");
    g.linhas(L + 2, y, cD - L, [
      `${pag.nome || ""}          ${pag.numeroCpfCnpj || ""}`,
      pag.endereco || "", pag.bairro || "",
      `${pag.cidade || ""} - ${pag.uf || ""}          ${pag.cep || ""}`],
      { tam: 7.4, dy: 4.0, topo: 3.8 });
    g.caixa(cD, y, R - cD, 19.0, "");
    y += 19.0;
    g.caixa(L, y, W, 6.0, "Beneficiário final");
    y += 6.0 + 3.5;

    // o código de barras tem largura fixa (~113 mm): a autenticação vai DEPOIS
    // dele, senão o texto cai por cima das barras e o leitor erra.
    const fim = g.barras(b.codigoBarras, L, y);
    const xAut = Math.max(fim + 4, R - 62);
    doc.font("Helvetica").fontSize(7).fillColor("#000")
      .text("Autenticação mecânica    -", mm(xAut), mm(y + 3), { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7)
      .text("Ficha de compensação", mm(xAut + 32), mm(y + 3), { lineBreak: false });

    doc.end();
  });
}

module.exports = { gerarBoletoPdf, nossoNumeroDoCodigo, formatarLd, moeda, dataBr };
