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

function buildSheetXml(rows, colWidths) {
  let cols = '<cols>';
  (colWidths || []).forEach((w, i) => { cols += `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`; });
  cols += '</cols>';

  let sheetData = '<sheetData>';
  rows.forEach((row, ri) => {
    sheetData += `<row r="${ri+1}">`;
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
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols}
${sheetData}
</worksheet>`;
}

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

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

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

function buildXlsxBytes(sheetName, rows, colWidths) {
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', content: enc.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', content: enc.encode(RELS_XML) },
    { name: 'xl/workbook.xml', content: enc.encode(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', content: enc.encode(WORKBOOK_RELS_XML) },
    { name: 'xl/styles.xml', content: enc.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', content: enc.encode(buildSheetXml(rows, colWidths)) },
  ];
  return buildZip(files);
}

function downloadXlsx(sheetName, rows, colWidths, filename) {
  const bytes = buildXlsxBytes(sheetName, rows, colWidths);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
