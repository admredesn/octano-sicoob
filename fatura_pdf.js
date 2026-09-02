// ============================================================
// fatura_pdf.js — a FATURA que o cliente recebe, com o detalhamento.
// ------------------------------------------------------------
// Não é o boleto (esse é a cobrança bancária) nem a NF-e (essa é o documento
// fiscal). A fatura é o EXTRATO: mostra abastecimento por abastecimento o que
// formou o total, com placa, odômetro, cupom e hora — é por ela que o cliente
// frota confere se aquele diesel foi mesmo do trator dele.
//
// Layout do modelo do posto (fatura 247.419 do TecnoX): cabeçalho com origem e
// cliente, o valor por extenso, uma linha por abastecimento, os totalizadores
// e o resumo por produto no pé.
// ============================================================
const PDFDocument = require("pdfkit");

const MM = 2.834645669;
const mm = (v) => v * MM;

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2,
                                                  maximumFractionDigits: 2 });
}
function num(v, casas) {
  return Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas,
                                                  maximumFractionDigits: casas });
}
function dataBr(s) {
  s = String(s || "").slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s;
}

// O que se cobra e' o LIQUIDO. A coluna valor_liquido e' gerada pelo banco; a
// conta local aqui e' so' a rede de seguranca para fatura antiga sem a coluna.
function liquidoDe(fat) {
  if (fat && fat.valor_liquido != null) return Number(fat.valor_liquido);
  return Number((Number(fat.valor || 0) - Number(fat.desconto || 0) + Number(fat.acrescimo || 0)).toFixed(2));
}

// ---------- valor por extenso ----------
// O modelo do posto traz "(QUATROCENTOS E SESSENTA E SETE REAIS E OITENTA E
// NOVE CENTAVOS)". É o que dá à fatura peso de documento de cobrança.
const UNI = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
             "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis",
             "dezessete", "dezoito", "dezenove"];
const DEZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta",
             "setenta", "oitenta", "noventa"];
const CEM = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
             "seiscentos", "setecentos", "oitocentos", "novecentos"];

function _ate999(n) {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const c = Math.floor(n / 100), d = Math.floor((n % 100) / 10), u = n % 10;
  const p = [];
  if (c) p.push(CEM[c]);
  if (n % 100 < 20 && n % 100 > 0) p.push(UNI[n % 100]);
  else {
    if (d) p.push(DEZ[d]);
    if (u) p.push(UNI[u]);
  }
  return p.join(" e ");
}

function porExtenso(valor) {
  const inteiro = Math.floor(Number(valor || 0));
  const cent = Math.round((Number(valor || 0) - inteiro) * 100);
  const partes = [];
  const mi = Math.floor(inteiro / 1000000);
  const mil = Math.floor((inteiro % 1000000) / 1000);
  const res = inteiro % 1000;
  if (mi) partes.push(`${_ate999(mi)} ${mi === 1 ? "milhão" : "milhões"}`);
  if (mil) partes.push(mil === 1 ? "mil" : `${_ate999(mil)} mil`);
  if (res) partes.push(_ate999(res));
  let txt = partes.join(" e ") || "zero";
  txt += inteiro === 1 ? " real" : " reais";
  if (cent) txt += ` e ${_ate999(cent)} ${cent === 1 ? "centavo" : "centavos"}`;
  return txt.toUpperCase();
}

/**
 * @param fat    linha de oct_faturas (numero, emissao, vencimento, valor)
 * @param cli    linha de oct_pessoas (o pagador)
 * @param emp    linha de oct_empresas (a origem)
 * @param linhas [{data, produto, placa, odometro, veiculo, hora, cupom, qtd, unit, total}]
 */
function gerarFaturaPdf(fat, cli, emp, linhas) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const pedacos = [];
    doc.on("data", (c) => pedacos.push(c));
    doc.on("end", () => resolve(Buffer.concat(pedacos)));
    doc.on("error", reject);

    const L = 12.0, R = 198.0, W = R - L;
    let y = 12.0;

    const txt = (t, x, yy, opts) => {
      doc.text(String(t == null ? "" : t), mm(x), mm(yy),
               Object.assign({ lineBreak: false }, opts || {}));
    };
    const rot = (t, x, yy, w) => {
      doc.font("Helvetica").fontSize(6).fillColor("#555");
      txt(t, x, yy, { width: mm(w || 40) });
      doc.fillColor("#000");
    };
    const val = (t, x, yy, w, tam, alinha) => {
      doc.font("Helvetica-Bold").fontSize(tam || 8.5).fillColor("#000");
      txt(t, x, yy, { width: mm(w || 40), align: alinha || "left" });
    };
    const linha = (yy, x1, x2, esp) => {
      doc.lineWidth(esp || 0.5).strokeColor("#000")
        .moveTo(mm(x1 == null ? L : x1), mm(yy)).lineTo(mm(x2 == null ? R : x2), mm(yy)).stroke();
    };

    // ---------------- cabeçalho ----------------
    doc.font("Helvetica-Bold").fontSize(16);
    txt("FATURA", L, y, { width: mm(W), align: "center" });
    y += 8;
    doc.rect(mm(L), mm(y), mm(W), mm(16)).lineWidth(0.5).stroke();
    rot("Origem", L + 1.5, y + 1);
    val(emp.nome || "", L + 1.5, y + 4, 110, 8.5);
    val(emp.cnpj || "", L + 1.5, y + 8.5, 110, 8);
    val(`${emp.endereco || ""}  ${emp.cidade || ""} - ${emp.uf || ""}`, L + 1.5, y + 12.5, 110, 7.5);
    const cx = R - 62;
    doc.lineWidth(0.5).moveTo(mm(cx), mm(y)).lineTo(mm(cx), mm(y + 16)).stroke();
    rot("Número", cx + 1.5, y + 1);
    val(String(fat.numero || "—"), cx + 1.5, y + 4, 28, 11);
    rot("Emissão", cx + 32, y + 1);
    val(dataBr(fat.emissao || fat.criado_em), cx + 32, y + 4.5, 28, 8.5);
    rot("Vencimento", cx + 1.5, y + 9);
    val(dataBr(fat.vencimento), cx + 1.5, y + 12, 28, 8.5);
    rot("Valor R$", cx + 32, y + 9);
    val(moeda(liquidoDe(fat)), cx + 32, y + 12, 28, 10, "right");
    y += 16;

    // por extenso
    doc.rect(mm(L), mm(y), mm(W), mm(6)).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor("#000");
    txt(`(${porExtenso(liquidoDe(fat))})`, L + 1.5, y + 1.8, { width: mm(W - 3) });
    y += 6;

    // ---------------- cliente ----------------
    doc.rect(mm(L), mm(y), mm(W), mm(18)).stroke();
    rot("Cliente", L + 1.5, y + 1);
    val(cli.nome || fat.cliente_nome || "", L + 1.5, y + 4, 120, 9);
    rot("CNPJ/CPF", cx + 1.5, y + 1);
    val(cli.documento || "", cx + 1.5, y + 4, 58, 8.5);
    rot("Endereço", L + 1.5, y + 8.5);
    val(`${cli.endereco || ""}${cli.num_endereco ? ", " + cli.num_endereco : ""}`,
        L + 1.5, y + 11.2, 110, 8);
    rot("Bairro", cx + 1.5, y + 8.5);
    val(cli.bairro || "", cx + 1.5, y + 11.2, 58, 8);
    rot("Cidade / UF / CEP", L + 1.5, y + 14.4, 60);
    doc.font("Helvetica-Bold").fontSize(7.5);
    txt(`${cli.cidade || ""} - ${cli.uf || ""}   ${cli.cep || ""}   ${cli.telefone || cli.whatsapp || ""}`,
        L + 40, y + 14.4, { width: mm(W - 42) });
    y += 18 + 3;

    // ---------------- detalhamento ----------------
    // colunas: data | produto | placa | odômetro | hora | cupom | qtd | unit | valor
    const col = [L, L + 20, L + 62, L + 80, L + 94, L + 108, L + 128, L + 150, L + 170, R];
    const cab = ["Emissão", "Produto", "Placa", "Odômetro", "Hora", "Nota Fiscal",
                 "Quantidade", "Val. Unitário", "Valor"];
    doc.rect(mm(L), mm(y), mm(W), mm(5.5)).fill("#e9e9e9");
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(6.5);
    cab.forEach((c, i) => {
      txt(c, col[i] + 1, y + 1.8, { width: mm(col[i + 1] - col[i] - 2),
                                    align: i >= 6 ? "right" : "left" });
    });
    y += 5.5;
    linha(y);

    doc.font("Helvetica").fontSize(7.2);
    linhas.forEach((it) => {
      const v = [dataBr(it.data), String(it.produto || "").slice(0, 26),
                 it.placa || (it.veiculo ? String(it.veiculo).slice(0, 14) : "—"),
                 it.odometro ? String(it.odometro) : "—",
                 String(it.hora || "").slice(0, 8),
                 it.cupom ? `CUPOM ${it.cupom}` : "—",
                 num(it.qtd, 4), num(it.unit, 3), moeda(it.total)];
      v.forEach((t, i) => {
        doc.fillColor("#000");
        txt(t, col[i] + 1, y + 1.4, { width: mm(col[i + 1] - col[i] - 2),
                                      align: i >= 6 ? "right" : "left" });
      });
      y += 4.6;
      doc.lineWidth(0.2).strokeColor("#ccc")
        .moveTo(mm(L), mm(y)).lineTo(mm(R), mm(y)).stroke();
      if (y > 250) {                       // fatura longa: continua na página seguinte
        doc.addPage();
        y = 14;
      }
    });
    linha(y);
    y += 2;

    // ---------------- totalizadores ----------------
    const cT = R - 70;
    const desc = Number(fat.desconto || 0), acr = Number(fat.acrescimo || 0);
    const tot = [["Total produtos", fat.valor], ["Multa + juros + acréscimos", acr],
                 ["Descontos Notas", 0], ["Sub Total", Number(fat.valor || 0) + acr],
                 ["Despesa Acessória", 0], ["Desconto Manual", desc]];
    tot.forEach(([r, v], i) => {
      doc.font("Helvetica").fontSize(7.5).fillColor("#000");
      txt(r + ":", cT, y + i * 4.4, { width: mm(44), align: "right" });
      doc.font("Helvetica-Bold");
      txt(moeda(v), cT + 46, y + i * 4.4, { width: mm(22), align: "right" });
    });
    const yTot = y + tot.length * 4.4;
    linha(yTot, cT, R);
    doc.font("Helvetica-Bold").fontSize(10);
    txt("Total:", cT, yTot + 1.5, { width: mm(44), align: "right" });
    txt(moeda(liquidoDe(fat)), cT + 46, yTot + 1.5, { width: mm(22), align: "right" });

    // ---------------- resumo por produto ----------------
    const porProd = {};
    linhas.forEach((it) => {
      const k = it.produto || "—";
      if (!porProd[k]) porProd[k] = { qtd: 0, total: 0, cod: it.cod || "" };
      porProd[k].qtd += Number(it.qtd || 0);
      porProd[k].total += Number(it.total || 0);
    });
    let yp = y;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#000");
    txt("Totais de produtos", L, yp);
    yp += 4.5;
    doc.rect(mm(L), mm(yp), mm(112), mm(5)).fill("#e9e9e9");
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(6.5);
    [["Produto", L + 1, 46, "left"], ["Quantidade", L + 48, 22, "right"],
     ["Custo Unitário Média", L + 71, 24, "right"], ["Total", L + 96, 15, "right"]]
      .forEach(([t, x, w, a]) => txt(t, x, yp + 1.6, { width: mm(w), align: a }));
    yp += 5;
    doc.font("Helvetica").fontSize(7.2);
    Object.entries(porProd).forEach(([nome, p]) => {
      const media = p.qtd ? p.total / p.qtd : 0;
      txt(nome.slice(0, 30), L + 1, yp + 1.2, { width: mm(46) });
      txt(num(p.qtd, 4), L + 48, yp + 1.2, { width: mm(22), align: "right" });
      txt(num(media, 4), L + 71, yp + 1.2, { width: mm(24), align: "right" });
      txt(moeda(p.total), L + 96, yp + 1.2, { width: mm(15), align: "right" });
      yp += 4.4;
      doc.lineWidth(0.2).strokeColor("#ccc")
        .moveTo(mm(L), mm(yp)).lineTo(mm(L + 112), mm(yp)).stroke();
    });

    // ---------------- assinatura ----------------
    const yA = Math.max(yTot + 12, yp + 14);
    doc.lineWidth(0.5).strokeColor("#000")
      .moveTo(mm(L + 20), mm(yA)).lineTo(mm(L + 100), mm(yA)).stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#000");
    txt(cli.nome || fat.cliente_nome || "", L + 20, yA + 1.5, { width: mm(80), align: "center" });
    txt("Em  _____/_____/_____", L + 120, yA + 1.5, { width: mm(60) });
    doc.fontSize(6).fillColor("#666");
    txt("Documento gerado pelo Octano Sistemas", L, 287, { width: mm(W), align: "center" });

    doc.end();
  });
}

module.exports = { gerarFaturaPdf, porExtenso };
