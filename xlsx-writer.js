// ============================================================
//  xlsx-writer.js — generador minimo de archivos .xlsx reales
//  (sin librerias externas). Construye el ZIP (metodo STORE,
//  sin compresion) y el XML OOXML minimo que Excel requiere.
// ============================================================
"use strict";

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- ZIP (metodo STORE) ----
function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]; }
function dosDateTime() {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(files) {
  // files: [{ name, content: Uint8Array }]
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const data = f.content;
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array([
      0x50,0x4B,0x03,0x04, 20,0, 0,0, 0,0,
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ]);
    localParts.push(local, nameBytes, data);

    const central = new Uint8Array([
      0x50,0x4B,0x01,0x02, 20,0, 20,0, 0,0, 0,0,
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  });

  const centralStart = offset;
  let centralSize = 0;
  centralParts.forEach(p => centralSize += p.length);

  const eocd = new Uint8Array([
    0x50,0x4B,0x05,0x06, 0,0, 0,0,
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralStart),
    ...u16(0),
  ]);

  const totalLen = localParts.reduce((s,p)=>s+p.length,0) + centralSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  [...localParts, ...centralParts, eocd].forEach(part => { out.set(part, pos); pos += part.length; });
  return out;
}

// ---- XML helpers ----
function xesc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---- Hoja: rows = [ [ {v, s}, ... ], ... ]  s = indice de estilo (ver STYLE_* abajo) ----
const STYLE_DEFAULT = 0, STYLE_TITLE = 1, STYLE_SUBTOTAL = 2, STYLE_OK = 3, STYLE_BAD = 4, STYLE_HEAD = 5;

function buildSheetXml(rows, colWidths, rowHeights, hasDrawing) {
  let cols = '<cols>';
  (colWidths || []).forEach((w, i) => { cols += `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`; });
  cols += '</cols>';

  let sheetData = '<sheetData>';
  rows.forEach((row, ri) => {
    const h = rowHeights && rowHeights[ri];
    const attrs = h ? ` ht="${h}" customHeight="1"` : '';
    sheetData += `<row r="${ri+1}"${attrs}>`;
    row.forEach((cell, ci) => {
      if (cell == null) return;
      const ref = colLetter(ci+1) + (ri+1);
      const s = cell.s || 0;
      const val = cell.v;
      if (typeof val === 'number' && isFinite(val)) {
        sheetData += `<c r="${ref}" s="${s}"><v>${val}</v></c>`;
      } else {
        sheetData += `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xesc(val)}</t></is></c>`;
      }
    });
    sheetData += '</row>';
  });
  sheetData += '</sheetData>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${cols}
${sheetData}
${hasDrawing ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`;
}

// ---- Imagenes incrustadas (fotos de hallazgos) ----
function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function loadImageDims(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 120, h: img.naturalHeight || 120 });
    img.onerror = () => resolve({ w: 120, h: 120 });
    img.src = dataUrl;
  });
}

function fitSize(w, h, maxDim) {
  if (!w || !h) return { w: maxDim, h: maxDim };
  if (w >= h) return { w: maxDim, h: Math.round(h * maxDim / w) };
  return { w: Math.round(w * maxDim / h), h: maxDim };
}

function buildDrawingXml(images) {
  const anchors = images.map((img, i) => {
    const cx = Math.round(img.dispW * 9525);
    const cy = Math.round(img.dispH * 9525);
    return `<xdr:oneCellAnchor>
<xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
<xdr:ext cx="${cx}" cy="${cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Foto${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`;
}

function buildDrawingRelsXml(images) {
  const rels = images.map((img, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.jpeg"/>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>`;
}

const SHEET_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFF6000"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE6F6E8"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE2E1"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFCCCCCC"/></left><right style="thin"><color rgb="FFCCCCCC"/></right><top style="thin"><color rgb="FFCCCCCC"/></top><bottom style="thin"><color rgb="FFCCCCCC"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`;

function buildContentTypesXml(hasImages) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasImages ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${hasImages ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}
</Types>`;
}

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xesc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}
const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// images: [{ row, col, dataUrl }] (0-based row/col) — opcional
async function buildXlsxBytes(sheetName, rows, colWidths, images) {
  const enc = new TextEncoder();
  const hasImages = !!(images && images.length);
  const rowHeights = {};
  const sizedImages = [];
  if (hasImages) {
    for (const img of images) {
      const dims = await loadImageDims(img.dataUrl);
      const disp = fitSize(dims.w, dims.h, 90);
      sizedImages.push({ ...img, dispW: disp.w, dispH: disp.h });
      rowHeights[img.row] = Math.max(rowHeights[img.row] || 0, disp.h * 0.75 + 6);
    }
  }

  const files = [
    { name: '[Content_Types].xml', content: enc.encode(buildContentTypesXml(hasImages)) },
    { name: '_rels/.rels', content: enc.encode(RELS_XML) },
    { name: 'xl/workbook.xml', content: enc.encode(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', content: enc.encode(WORKBOOK_RELS_XML) },
    { name: 'xl/styles.xml', content: enc.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', content: enc.encode(buildSheetXml(rows, colWidths, rowHeights, hasImages)) },
  ];
  if (hasImages) {
    files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', content: enc.encode(SHEET_RELS_XML) });
    files.push({ name: 'xl/drawings/drawing1.xml', content: enc.encode(buildDrawingXml(sizedImages)) });
    files.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', content: enc.encode(buildDrawingRelsXml(sizedImages)) });
    sizedImages.forEach((img, i) => {
      files.push({ name: `xl/media/image${i + 1}.jpeg`, content: dataUrlToBytes(img.dataUrl) });
    });
  }
  return buildZip(files);
}

async function downloadXlsx(sheetName, rows, colWidths, filename, images) {
  const bytes = await buildXlsxBytes(sheetName, rows, colWidths, images);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
