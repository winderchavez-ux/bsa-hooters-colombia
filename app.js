// ============================================================
//  BSA HOOTERS COLOMBIA — app.js
//  Auditoria de Estandares de Marca (BSA) para Salitre, Zona T y Medellin
// ============================================================
"use strict";

const STORES = [
  { key: 'salitre',  name: 'Hooters Salitre',  icon: '🦉' },
  { key: 'zonat',    name: 'Hooters Zona T',    icon: '🦉' },
  { key: 'medellin', name: 'Hooters Medellín',  icon: '🦉' },
];
const STORE_MAP = Object.fromEntries(STORES.map(s => [s.key, s]));

// ── Sincronización con Google Sheets (Apps Script) ──
// Pega aquí la URL de la app web publicada desde Code.gs (Implementar > Nueva implementación).
// Mientras esté vacío, la app funciona 100% local como antes (sin compartir entre dispositivos).
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbwFZ7vQ8vh0jY2QoJTNj7t0i1WbASduxlmEVflMqMUW_Bn1Crjrjfd2Lg14dS0XTPwZQQ/exec';

function syncConfigured() { return !!SYNC_URL; }

async function apiPost(action, payload) {
  if (!syncConfigured()) return null;
  try {
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    return await res.json();
  } catch (e) { return null; }
}

async function apiListAudits() {
  if (!syncConfigured()) return null;
  try {
    const res = await fetch(SYNC_URL + '?action=listAudits');
    const data = await res.json();
    return data.audits || [];
  } catch (e) { return null; }
}

function auditSortKey(a) {
  const m = /(\d{10,})$/.exec(a.id || '');
  if (m) return Number(m[1]);
  return Date.parse(a.fecha || '') || 0;
}

function mergeRemoteAudits(remoteAudits) {
  if (!remoteAudits) return;
  const byStore = {};
  remoteAudits.forEach(a => { (byStore[a.store] = byStore[a.store] || []).push({ ...a, synced: true }); });
  STORES.forEach(s => {
    const local = getAudits(s.key);
    const remote = byStore[s.key] || [];
    const remoteIds = new Set(remote.map(a => a.id));
    const localPending = local.filter(a => a.synced !== true && !remoteIds.has(a.id));
    const merged = remote.concat(localPending);
    merged.sort((a, b) => auditSortKey(a) - auditSortKey(b));
    saveAudits(s.key, merged);
  });
}

function markAuditSynced(storeKey, auditId) {
  const audits = getAudits(storeKey);
  const idx = audits.findIndex(a => a.id === auditId);
  if (idx >= 0) { audits[idx].synced = true; saveAudits(storeKey, audits); }
}

async function syncPushPending() {
  if (!syncConfigured()) return;
  for (const s of STORES) {
    const audits = getAudits(s.key);
    let changed = false;
    for (const a of audits) {
      if (a.synced !== true) {
        const res = await apiPost('saveAudit', { audit: a });
        if (res && res.ok) { a.synced = true; changed = true; }
      }
    }
    if (changed) saveAudits(s.key, audits);
  }
}

async function uploadPhotoToServer(storeKey, auditId, itemId, photoKey, dataUrl, responseObj) {
  const res = await apiPost('uploadPhoto', { key: photoKey, dataUrl });
  if (!res || !res.url) return;
  responseObj.photoUrl = res.url;
  // Si la auditoría ya se había guardado antes, actualiza también la copia guardada y el servidor.
  const audits = getAudits(storeKey);
  const idx = audits.findIndex(a => a.id === auditId);
  if (idx >= 0 && audits[idx].responses[itemId]) {
    audits[idx].responses[itemId].photoUrl = res.url;
    saveAudits(storeKey, audits);
    if (audits[idx].synced) await apiPost('saveAudit', { audit: audits[idx] });
  }
}

// ── Exportar / Importar respaldo en JSON (para mover datos entre dispositivos) ──
function exportDataJson() {
  const audits = [];
  STORES.forEach(s => getAudits(s.key).forEach(a => audits.push(a)));
  const blob = new Blob([JSON.stringify({ audits }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `BSA_respaldo_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('⬇️ Respaldo descargado');
}

async function importDataJson(file, onDone) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const importedAudits = Array.isArray(data.audits) ? data.audits : [];
    if (!importedAudits.length) { toast('⚠️ El archivo no tiene auditorías'); return; }
    let count = 0;
    STORES.forEach(s => {
      const local = getAudits(s.key);
      importedAudits.filter(a => a.store === s.key).forEach(a => {
        const idx = local.findIndex(x => x.id === a.id);
        const toSave = { ...a, synced: false };
        if (idx >= 0) local[idx] = toSave; else local.push(toSave);
        count++;
      });
      saveAudits(s.key, local);
    });
    toast(`⬆️ ${count} auditoría(s) importada(s), sincronizando...`);
    await syncPushPending();
    if (onDone) onDone();
  } catch (e) {
    toast('❌ Archivo inválido');
  }
}

async function syncPullAll() {
  if (!syncConfigured()) return;
  await syncPushPending();
  const remote = await apiListAudits();
  mergeRemoteAudits(remote);
}

// ── Accesos (login) ──
const AREAS = [
  { key: 'salitre',  name: 'Hooters Salitre',  icon: '🦉' },
  { key: 'zonat',    name: 'Hooters Zona T',    icon: '🦉' },
  { key: 'medellin', name: 'Hooters Medellín',  icon: '🦉' },
  { key: 'gerencia', name: 'DO Operación',      icon: '👔' },
];
const DEFAULT_PASSWORDS = {
  salitre: 'salitre2026',
  zonat: 'zonat2026',
  medellin: 'medellin2026',
  gerencia: 'gerencia2026',
};
function getPasswords() {
  try { return { ...DEFAULT_PASSWORDS, ...JSON.parse(localStorage.getItem('bsa_passwords') || '{}') }; }
  catch (e) { return { ...DEFAULT_PASSWORDS }; }
}
function savePasswords(pw) { localStorage.setItem('bsa_passwords', JSON.stringify(pw)); }

let currentRole = null;
let selectedArea = null;

// ── DOM helpers ──
const $ = id => document.getElementById(id);
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(id).classList.add('active'); window.scrollTo(0,0); }
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('toast-container').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function scoreClass(pct) {
  if (pct === null || pct === undefined) return 'score-none';
  if (pct >= 90) return 'score-good';
  if (pct >= 75) return 'score-warn';
  return 'score-bad';
}

// ── IndexedDB (fotos) ──
const DB_NAME = 'bsa_photos_db', STORE_NAME = 'photos';
function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function photoSave(key, dataUrl) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function photoGet(key) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function photoDelete(key) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Audit storage (localStorage) ──
function auditsKey(storeKey) { return `bsa_audits_${storeKey}`; }
function getAudits(storeKey) {
  try { return JSON.parse(localStorage.getItem(auditsKey(storeKey)) || '[]'); }
  catch (e) { return []; }
}
function saveAudits(storeKey, audits) {
  localStorage.setItem(auditsKey(storeKey), JSON.stringify(audits));
}
function getLatestAudit(storeKey) {
  const audits = getAudits(storeKey);
  return audits.length ? audits[audits.length - 1] : null;
}

// ── Score calculation ──
// responses: { itemId: { state: 'ok'|'bad'|'na'|null, obs: '', hasPhoto: bool } }
function computeScores(responses) {
  const sections = {};
  let weightedSum = 0, weightUsed = 0;

  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = BSA_TEMPLATE.sections[skey];
    let actual = 0, max = 0, answered = 0, total = 0;
    Object.values(sec.subsections).forEach(sub => {
      Object.values(sub.groups).forEach(items => {
        items.forEach(it => {
          total++;
          const r = responses[it.id];
          if (!r || !r.state || r.state === 'na') return;
          answered++;
          max += it.max;
          if (r.state === 'ok') actual += it.max;
          // 'bad' contributes 0 to actual
        });
      });
    });
    const pct = max > 0 ? (actual / max * 100) : null;
    sections[skey] = { label: sec.label, weight: sec.weight, actual, max, pct, answered, total };
    if (pct !== null) { weightedSum += pct * sec.weight; weightUsed += sec.weight; }
  });

  const overall = weightUsed > 0 ? (weightedSum / weightUsed) : null;
  return { sections, overall };
}

function countAnswered(responses) {
  let answered = 0, total = 0, badCount = 0;
  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = BSA_TEMPLATE.sections[skey];
    Object.values(sec.subsections).forEach(sub => {
      Object.values(sub.groups).forEach(items => {
        items.forEach(it => {
          total++;
          const r = responses[it.id];
          if (r && r.state) { answered++; if (r.state === 'bad') badCount++; }
        });
      });
    });
  });
  return { answered, total, badCount };
}

// ============================================================
//  SCREEN: LOGIN
// ============================================================
(function initLogin() {
  const grid = $('area-grid');
  AREAS.forEach(a => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'area-btn';
    btn.dataset.area = a.key;
    btn.innerHTML = `<span class="area-icon">${a.icon}</span>${a.name.replace('Hooters ','')}`;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedArea = a.key;
      $('login-error').textContent = '';
    });
    grid.appendChild(btn);
  });

  $('toggle-pw').addEventListener('click', () => {
    const inp = $('login-password');
    const isText = inp.type === 'text';
    inp.type = isText ? 'password' : 'text';
    $('toggle-pw').textContent = isText ? '👁️' : '🙈';
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedArea) { $('login-error').textContent = '⚠️ Selecciona tu tienda o DO Operación.'; return; }
    const pw = $('login-password').value.trim();
    const passwords = getPasswords();
    if (pw !== passwords[selectedArea]) {
      $('login-error').textContent = '❌ Contraseña incorrecta.';
      $('login-password').value = '';
      $('login-password').focus();
      return;
    }
    currentRole = selectedArea;
    $('login-password').value = '';
    $('login-error').textContent = '';
    if (currentRole === 'gerencia') {
      show('screen-select');
      await renderStoreGrid();
    } else {
      openStoreHome(currentRole);
    }
  });
})();

function doLogout() {
  currentRole = null;
  selectedArea = null;
  document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('selected'));
  show('screen-login');
}
$('btn-logout-select').addEventListener('click', doLogout);

$('btn-save-pw').addEventListener('click', () => {
  const area = $('pw-area').value;
  const newPw = $('pw-new').value.trim();
  if (newPw.length < 6) { toast('⚠️ La contraseña debe tener al menos 6 caracteres'); return; }
  const pw = getPasswords();
  pw[area] = newPw;
  savePasswords(pw);
  $('pw-new').value = '';
  toast('✅ Contraseña actualizada');
});

// ============================================================
//  SCREEN: SELECCION DE TIENDA
// ============================================================
async function renderStoreGrid() {
  if (syncConfigured()) { toast('🔄 Sincronizando...'); await syncPullAll(); }
  const grid = $('store-grid');
  grid.innerHTML = '';
  STORES.forEach(s => {
    const latest = getLatestAudit(s.key);
    const scores = latest ? computeScores(latest.responses) : null;
    const pct = scores ? scores.overall : null;

    const card = document.createElement('div');
    card.className = 'store-card';
    card.innerHTML = `
      <div class="store-icon">${s.icon}</div>
      <div class="store-info">
        <div class="store-name">${s.name}</div>
        <div class="store-meta">${latest ? 'Última auditoría: ' + fmtDate(latest.fecha) : 'Sin auditorías registradas'}</div>
      </div>
      <div class="store-score ${scoreClass(pct)}">${pct !== null ? pct.toFixed(1) + '%' : '—'}</div>
    `;
    card.addEventListener('click', () => openStoreHome(s.key));
    grid.appendChild(card);
  });
}
$('btn-consolidado').addEventListener('click', () => renderConsolidado());
$('btn-export-data-select').addEventListener('click', () => exportDataJson());
$('btn-import-data-select').addEventListener('click', () => $('input-import-select').click());
$('input-import-select').addEventListener('change', () => {
  importDataJson($('input-import-select').files[0], () => renderStoreGrid());
});

$('btn-reset-data').addEventListener('click', async () => {
  if (!confirm('¿Borrar TODAS las auditorías y fotos guardadas de las 3 tiendas? Esta acción no se puede deshacer.')) return;
  STORES.forEach(s => localStorage.removeItem(auditsKey(s.key)));
  try {
    const db = await dbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* IndexedDB puede no tener datos aun */ }
  await apiPost('resetAll', {});
  await renderStoreGrid();
  toast('🗑️ Todos los datos fueron borrados');
});

// ============================================================
//  SCREEN: PANEL DE TIENDA
// ============================================================
let currentStore = null;

async function openStoreHome(storeKey) {
  currentStore = storeKey;
  if (syncConfigured()) await syncPullAll();
  const s = STORE_MAP[storeKey];
  $('home-store-name').textContent = s.name;
  const latest = getLatestAudit(storeKey);
  const scores = latest ? computeScores(latest.responses) : null;
  const audits = getAudits(storeKey).slice().reverse();

  const body = $('home-body');
  body.innerHTML = '';

  const hero = document.createElement('div');
  hero.className = 'home-hero';
  hero.innerHTML = `
    <div class="hero-label">Puntaje más reciente</div>
    <div class="hero-score ${scoreClass(scores ? scores.overall : null)}">${scores && scores.overall !== null ? scores.overall.toFixed(1) + '%' : 'Sin datos'}</div>
    <div class="hero-date">${latest ? 'Auditado el ' + fmtDate(latest.fecha) + ' por ' + (latest.auditor || '—') : 'Realiza la primera auditoría de esta tienda'}</div>
    <div class="section-bars" id="home-section-bars"></div>
  `;
  body.appendChild(hero);

  if (scores) {
    const barsWrap = hero.querySelector('#home-section-bars');
    BSA_TEMPLATE.sectionOrder.forEach(skey => {
      const sec = scores.sections[skey];
      const pct = sec.pct !== null ? sec.pct : 0;
      const row = document.createElement('div');
      row.className = 'section-bar-row';
      row.innerHTML = `
        <div class="sb-label">${sec.label}</div>
        <div class="section-bar-track"><div class="section-bar-fill" style="width:${pct}%"></div></div>
        <div class="sb-pct">${sec.pct !== null ? sec.pct.toFixed(0) + '%' : '—'}</div>
      `;
      barsWrap.appendChild(row);
    });
  }

  const btnNew = document.createElement('button');
  btnNew.className = 'btn-primary btn-block';
  btnNew.textContent = '📋 Nueva Auditoría BSA';
  btnNew.addEventListener('click', () => startNewAudit(storeKey));
  body.appendChild(btnNew);

  const btnDemo = document.createElement('button');
  btnDemo.className = 'btn-ghost';
  btnDemo.style.marginTop = '10px';
  btnDemo.textContent = '🧪 Generar auditoría de ejemplo (para ver cómo se exporta)';
  btnDemo.addEventListener('click', () => generateDemoAudit(storeKey));
  body.appendChild(btnDemo);

  const btnExport = document.createElement('button');
  btnExport.className = 'btn-ghost';
  btnExport.style.marginTop = '10px';
  btnExport.textContent = '⬇️ Exportar datos (respaldo)';
  btnExport.addEventListener('click', () => exportDataJson());
  body.appendChild(btnExport);

  const btnImport = document.createElement('button');
  btnImport.className = 'btn-ghost';
  btnImport.style.marginTop = '10px';
  btnImport.textContent = '⬆️ Importar datos';
  const importInput = document.createElement('input');
  importInput.type = 'file'; importInput.accept = 'application/json'; importInput.style.display = 'none';
  btnImport.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => importDataJson(importInput.files[0], () => openStoreHome(storeKey)));
  body.appendChild(btnImport);
  body.appendChild(importInput);

  const histTitle = document.createElement('div');
  histTitle.className = 'history-title';
  histTitle.textContent = `Historial (${audits.length})`;
  body.appendChild(histTitle);

  if (!audits.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = 'Aún no hay auditorías guardadas para esta tienda.';
    body.appendChild(empty);
  } else {
    audits.forEach(a => {
      const sc = computeScores(a.responses);
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div>
          <div class="hi-date">${fmtDate(a.fecha)}</div>
          <div class="hi-meta">Auditor: ${a.auditor || '—'}</div>
        </div>
        <div class="hi-score ${scoreClass(sc.overall)}">${sc.overall !== null ? sc.overall.toFixed(1) + '%' : '—'}</div>
      `;
      item.addEventListener('click', () => viewAuditSummary(storeKey, a.id));
      body.appendChild(item);
    });
  }

  show('screen-home');
}
$('btn-home-back').addEventListener('click', () => {
  if (currentRole === 'gerencia') { show('screen-select'); renderStoreGrid(); }
  else { doLogout(); }
});

// ── Generador de auditoría de ejemplo (para previsualizar exportación) ──
const DEMO_OBS = [
  'Pendiente por mantenimiento', 'No cumple según lo observado en el recorrido',
  'Se solicitó corrección al gerente de turno', 'Falta reposición / dotación',
  'Se evidencia deterioro, requiere reparación', 'No se encontró disponible al momento de la visita',
];
function generateDemoAudit(storeKey) {
  const s = STORE_MAP[storeKey];
  const audit = {
    id: storeKey + '_demo_' + Date.now(),
    store: storeKey,
    fecha: new Date().toISOString().slice(0, 10),
    auditor: 'Auditor Demo',
    gerente: 'Gerente Demo',
    responses: {},
    synced: false,
  };
  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = BSA_TEMPLATE.sections[skey];
    Object.values(sec.subsections).forEach(sub => {
      Object.values(sub.groups).forEach(items => {
        items.forEach(it => {
          const roll = Math.random();
          let state, obs = '';
          if (roll < 0.72) { state = 'ok'; }
          else if (roll < 0.92) { state = 'bad'; obs = DEMO_OBS[Math.floor(Math.random() * DEMO_OBS.length)]; }
          else { state = 'na'; }
          audit.responses[it.id] = { state, obs, hasPhoto: false };
        });
      });
    });
  });
  const audits = getAudits(storeKey);
  audits.push(audit);
  saveAudits(storeKey, audits);
  toast('🧪 Auditoría de ejemplo generada para ' + s.name);
  viewAuditSummary(storeKey, audit.id);
  apiPost('saveAudit', { audit }).then(res => { if (res && res.ok) markAuditSynced(storeKey, audit.id); });
}

// ============================================================
//  SCREEN: AUDITORIA EN CURSO
// ============================================================
let draftAudit = null; // { id, store, fecha, auditor, gerente, responses }

function startNewAudit(storeKey) {
  draftAudit = {
    id: storeKey + '_' + Date.now(),
    store: storeKey,
    fecha: new Date().toISOString().slice(0,10),
    auditor: '',
    gerente: '',
    responses: {},
    synced: false,
  };
  openAuditScreen();
}

function editExistingAudit(storeKey, auditId) {
  const audits = getAudits(storeKey);
  const a = audits.find(x => x.id === auditId);
  if (!a) { toast('Auditoría no encontrada'); return; }
  draftAudit = JSON.parse(JSON.stringify(a));
  openAuditScreen();
}

function openAuditScreen() {
  const s = STORE_MAP[draftAudit.store];
  $('audit-store-name').textContent = s.name;
  renderAuditBody();
  updateAuditHeaderStrip();
  show('screen-audit');
}

function renderAuditBody() {
  const body = $('audit-body');
  body.innerHTML = '';

  const meta = document.createElement('div');
  meta.className = 'home-hero';
  meta.style.marginBottom = '14px';
  meta.innerHTML = `
    <div class="hero-label">Datos de la auditoría</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      <input type="date" id="inp-fecha" class="item-obs" value="${draftAudit.fecha}">
      <input type="text" id="inp-auditor" class="item-obs" placeholder="Nombre del auditor" value="${draftAudit.auditor || ''}">
      <input type="text" id="inp-gerente" class="item-obs" placeholder="Gerente del restaurante" value="${draftAudit.gerente || ''}">
    </div>
  `;
  body.appendChild(meta);
  meta.querySelector('#inp-fecha').addEventListener('change', e => draftAudit.fecha = e.target.value);
  meta.querySelector('#inp-auditor').addEventListener('input', e => draftAudit.auditor = e.target.value);
  meta.querySelector('#inp-gerente').addEventListener('input', e => draftAudit.gerente = e.target.value);

  BSA_TEMPLATE.sectionOrder.forEach((skey, si) => {
    const sec = BSA_TEMPLATE.sections[skey];
    const secEl = document.createElement('div');
    secEl.className = 'acc-section' + (si === 0 ? ' open' : '');
    secEl.dataset.section = skey;

    const head = document.createElement('div');
    head.className = 'acc-section-head';
    head.innerHTML = `
      <div class="as-title">${sec.label}</div>
      <div class="as-meta"><span class="as-pct" data-secpct="${skey}">—</span><span class="acc-chevron"></span></div>
    `;
    head.addEventListener('click', () => secEl.classList.toggle('open'));
    secEl.appendChild(head);

    const secBody = document.createElement('div');
    secBody.className = 'acc-section-body';

    const subKeys = Object.keys(sec.subsections);
    subKeys.forEach(subKey => {
      const sub = sec.subsections[subKey];
      if (subKey !== '_default') {
        const subTitle = document.createElement('div');
        subTitle.className = 'acc-sub-title';
        subTitle.textContent = subKey;
        secBody.appendChild(subTitle);
      }
      Object.keys(sub.groups).forEach(gKey => {
        const items = sub.groups[gKey];
        const groupEl = document.createElement('div');
        groupEl.className = 'acc-group';
        const gHead = document.createElement('div');
        gHead.className = 'acc-group-head';
        gHead.innerHTML = `<div class="ag-title">${gKey}</div><div class="ag-badge" data-gbadge="${skey}|${subKey}|${gKey}">0/${items.length}</div>`;
        gHead.addEventListener('click', () => groupEl.classList.toggle('open'));
        groupEl.appendChild(gHead);

        const gBody = document.createElement('div');
        gBody.className = 'acc-group-body';
        items.forEach(it => gBody.appendChild(renderItemRow(it, skey)));
        groupEl.appendChild(gBody);

        secBody.appendChild(groupEl);
      });
    });

    secEl.appendChild(secBody);
    body.appendChild(secEl);
  });

  refreshAllBadges();
}

function renderItemRow(it, sectionKey) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.dataset.itemId = it.id;

  const r = draftAudit.responses[it.id] || { state: null, obs: '', hasPhoto: false };
  draftAudit.responses[it.id] = r;

  row.innerHTML = `
    <div class="item-text">${it.text}<span class="item-max">(${it.max} pt${it.max>1?'s':''})</span></div>
    <div class="item-controls">
      <button class="state-btn sb-ok ${r.state==='ok'?'active':''}" data-state="ok">✔ Cumple</button>
      <button class="state-btn sb-bad ${r.state==='bad'?'active':''}" data-state="bad">✘ No cumple</button>
      <button class="state-btn sb-na ${r.state==='na'?'active':''}" data-state="na">— No aplica</button>
    </div>
    <div class="item-extra" style="display:${r.state==='bad' ? 'flex':'none'}">
      <textarea class="item-obs" placeholder="Observación (qué encontró el auditor)...">${r.obs || ''}</textarea>
      <div class="item-photo-row" data-photo-row></div>
    </div>
  `;

  const extra = row.querySelector('.item-extra');
  const obsInput = row.querySelector('.item-obs');
  obsInput.addEventListener('input', e => { r.obs = e.target.value; });

  row.querySelectorAll('.state-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newState = btn.dataset.state;
      r.state = (r.state === newState) ? null : newState;
      row.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('active', b.dataset.state === r.state));
      extra.style.display = r.state === 'bad' ? 'flex' : 'none';
      if (r.state === 'bad') renderPhotoRow(row, it);
      updateAuditHeaderStrip();
      refreshSectionBadge(sectionKey);
    });
  });

  if (r.state === 'bad') renderPhotoRow(row, it);
  return row;
}

async function renderPhotoRow(row, it) {
  const photoRow = row.querySelector('[data-photo-row]');
  const r = draftAudit.responses[it.id];
  photoRow.innerHTML = '';

  if (r.hasPhoto || r.photoUrl) {
    const key = draftAudit.id + '::' + it.id;
    const dataUrl = (await photoGet(key)) || r.photoUrl;
    if (dataUrl) {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      thumb.innerHTML = `<img src="${dataUrl}"><button class="pt-remove">✕</button>`;
      thumb.querySelector('img').addEventListener('click', () => openLightbox(dataUrl));
      thumb.querySelector('.pt-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await photoDelete(key);
        r.hasPhoto = false;
        r.photoUrl = null;
        renderPhotoRow(row, it);
      });
      photoRow.appendChild(thumb);
      return;
    }
  }

  const btn = document.createElement('button');
  btn.className = 'btn-photo';
  btn.type = 'button';
  btn.innerHTML = '📸 Tomar foto';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
  input.style.display = 'none';
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files || !input.files[0]) return;
    toast('Guardando foto...');
    const dataUrl = await compressImage(input.files[0], 1280, 0.6);
    const photoKey = draftAudit.id + '::' + it.id;
    await photoSave(photoKey, dataUrl);
    r.hasPhoto = true;
    renderPhotoRow(row, it);
    toast('Foto guardada');
    uploadPhotoToServer(draftAudit.store, draftAudit.id, it.id, photoKey, dataUrl, r);
  });
  photoRow.appendChild(btn);
  photoRow.appendChild(input);
}

function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.add('show');
}
$('lightbox-close').addEventListener('click', () => $('lightbox').classList.remove('show'));
$('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('lightbox').classList.remove('show'); });

function refreshSectionBadge(sectionKey) {
  const scores = computeScores(draftAudit.responses);
  const sec = scores.sections[sectionKey];
  const pctEl = document.querySelector(`[data-secpct="${sectionKey}"]`);
  if (pctEl) pctEl.textContent = sec.pct !== null ? sec.pct.toFixed(0) + '%' : '—';
  refreshAllBadges();
}
function refreshAllBadges() {
  document.querySelectorAll('[data-gbadge]').forEach(el => {
    const [skey, subKey, gKey] = el.dataset.gbadge.split('|');
    const items = BSA_TEMPLATE.sections[skey].subsections[subKey].groups[gKey];
    const answered = items.filter(it => draftAudit.responses[it.id] && draftAudit.responses[it.id].state).length;
    el.textContent = `${answered}/${items.length}`;
  });
}

function updateAuditHeaderStrip() {
  const { answered, total, badCount } = countAnswered(draftAudit.responses);
  const scores = computeScores(draftAudit.responses);
  $('audit-progress-fill').style.width = (answered / total * 100) + '%';

  const strip = $('audit-score-strip');
  strip.innerHTML = '';
  const overallChip = document.createElement('div');
  overallChip.className = 'strip-chip';
  overallChip.innerHTML = `<div class="sc-label">General</div><div class="sc-value ${scoreClass(scores.overall)}">${scores.overall!==null?scores.overall.toFixed(1)+'%':'—'}</div>`;
  strip.appendChild(overallChip);

  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = scores.sections[skey];
    const chip = document.createElement('div');
    chip.className = 'strip-chip';
    chip.innerHTML = `<div class="sc-label">${sec.label.split(' ')[0]}</div><div class="sc-value">${sec.pct!==null?sec.pct.toFixed(0)+'%':'—'}</div>`;
    strip.appendChild(chip);
  });

  const progChip = document.createElement('div');
  progChip.className = 'strip-chip';
  progChip.innerHTML = `<div class="sc-label">Avance</div><div class="sc-value">${answered}/${total}</div>`;
  strip.appendChild(progChip);

  if (badCount > 0) {
    const badChip = document.createElement('div');
    badChip.className = 'strip-chip';
    badChip.innerHTML = `<div class="sc-label">No cumple</div><div class="sc-value score-bad">${badCount}</div>`;
    strip.appendChild(badChip);
  }
}

async function doSaveAudit() {
  if (!draftAudit.auditor || !draftAudit.auditor.trim()) {
    toast('⚠️ Ingresa el nombre del auditor antes de guardar');
    return;
  }
  const audits = getAudits(draftAudit.store);
  const idx = audits.findIndex(a => a.id === draftAudit.id);
  const toSave = JSON.parse(JSON.stringify(draftAudit));
  toSave.synced = false;
  if (idx >= 0) audits[idx] = toSave; else audits.push(toSave);
  saveAudits(draftAudit.store, audits);
  toast('✅ Auditoría guardada');
  viewAuditSummary(draftAudit.store, draftAudit.id);
  if (syncConfigured()) {
    const res = await apiPost('saveAudit', { audit: toSave });
    if (res && res.ok) markAuditSynced(draftAudit.store, draftAudit.id);
    else toast('⚠️ Sin conexión: se sincronizará más tarde');
  }
}
$('btn-audit-save').addEventListener('click', doSaveAudit);
$('btn-audit-save-top').addEventListener('click', doSaveAudit);
$('btn-audit-exit').addEventListener('click', () => {
  if (confirm('¿Salir sin guardar? Se perderán los cambios de esta sesión.')) openStoreHome(draftAudit.store);
});

// ============================================================
//  SCREEN: RESUMEN DE AUDITORIA
// ============================================================
let summaryCtx = null;

async function viewAuditSummary(storeKey, auditId) {
  const audits = getAudits(storeKey);
  const a = audits.find(x => x.id === auditId);
  if (!a) { toast('Auditoría no encontrada'); return; }
  summaryCtx = { storeKey, auditId };

  const scores = computeScores(a.responses);
  const s = STORE_MAP[storeKey];
  const body = $('summary-body');
  body.innerHTML = '';

  const hero = document.createElement('div');
  hero.className = 'summary-hero';
  hero.innerHTML = `
    <div class="sh-score ${scoreClass(scores.overall)}">${scores.overall!==null?scores.overall.toFixed(1)+'%':'—'}</div>
    <div class="sh-store">${s.name}</div>
    <div class="sh-meta">${fmtDate(a.fecha)} · Auditor: ${a.auditor||'—'} · Gerente: ${a.gerente||'—'}</div>
  `;
  body.appendChild(hero);

  const barsWrap = document.createElement('div');
  barsWrap.className = 'section-bars';
  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = scores.sections[skey];
    const pct = sec.pct !== null ? sec.pct : 0;
    const row = document.createElement('div');
    row.className = 'section-bar-row';
    row.innerHTML = `
      <div class="sb-label">${sec.label}</div>
      <div class="section-bar-track"><div class="section-bar-fill" style="width:${pct}%"></div></div>
      <div class="sb-pct">${sec.pct !== null ? sec.pct.toFixed(0) + '%' : '—'}</div>
    `;
    barsWrap.appendChild(row);
  });
  body.appendChild(barsWrap);

  const actions = document.createElement('div');
  actions.className = 'summary-actions';
  actions.style.marginTop = '18px';
  actions.innerHTML = `
    <button class="btn-secondary" id="btn-edit-audit">✏️ Editar</button>
    <button class="btn-secondary" id="btn-export-audit">⬇️ Exportar Excel</button>
  `;
  body.appendChild(actions);
  actions.querySelector('#btn-edit-audit').addEventListener('click', () => editExistingAudit(storeKey, auditId));
  actions.querySelector('#btn-export-audit').addEventListener('click', () => exportAuditExcel(storeKey, auditId));

  const issuesTitle = document.createElement('div');
  issuesTitle.className = 'history-title';
  const { badCount } = countAnswered(a.responses);
  issuesTitle.textContent = `Hallazgos — No cumple (${badCount})`;
  body.appendChild(issuesTitle);

  if (badCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '🎉 No se registraron incumplimientos en esta auditoría.';
    body.appendChild(empty);
  } else {
    for (const skey of BSA_TEMPLATE.sectionOrder) {
      const sec = BSA_TEMPLATE.sections[skey];
      for (const subKey of Object.keys(sec.subsections)) {
        const sub = sec.subsections[subKey];
        for (const gKey of Object.keys(sub.groups)) {
          for (const it of sub.groups[gKey]) {
            const r = a.responses[it.id];
            if (!r || r.state !== 'bad') continue;
            const card = document.createElement('div');
            card.className = 'issue-card';
            card.innerHTML = `
              <div class="ic-section">${sec.label} · ${gKey}</div>
              <div class="ic-text">${it.text}</div>
              ${r.obs ? `<div class="ic-obs">"${r.obs}"</div>` : ''}
              <div class="ic-photos" data-issue-photo="${a.id}::${it.id}"></div>
            `;
            body.appendChild(card);
            if (r.photoUrl) {
              const holder = card.querySelector('[data-issue-photo]');
              const img = document.createElement('img');
              img.src = r.photoUrl; img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer';
              img.addEventListener('click', () => openLightbox(r.photoUrl));
              holder.appendChild(img);
            } else if (r.hasPhoto) {
              photoGet(a.id + '::' + it.id).then(dataUrl => {
                if (!dataUrl) return;
                const holder = card.querySelector('[data-issue-photo]');
                const img = document.createElement('img');
                img.src = dataUrl; img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer';
                img.addEventListener('click', () => openLightbox(dataUrl));
                holder.appendChild(img);
              });
            }
          }
        }
      }
    }
  }

  show('screen-summary');
}
$('btn-summary-back').addEventListener('click', () => openStoreHome(summaryCtx.storeKey));

// ============================================================
//  EXPORTAR A EXCEL (.xlsx real, generado en el navegador)
// ============================================================
function cell(v, s) { return { v, s: s || STYLE_DEFAULT }; }

function auditToRows(storeName, a, scores) {
  const rows = [];
  rows.push([cell(`BSA — ${storeName}`, STYLE_TITLE), null, null, null, null]);
  rows.push([cell('Fecha', STYLE_SUBTOTAL), cell(fmtDate(a.fecha)), cell('Auditor', STYLE_SUBTOTAL), cell(a.auditor || '—'), null]);
  rows.push([cell('Gerente', STYLE_SUBTOTAL), cell(a.gerente || '—'), null, null, null]);
  rows.push([]);
  rows.push([cell('Sección', STYLE_HEAD), cell('Peso', STYLE_HEAD), cell('Puntaje', STYLE_HEAD), cell('%', STYLE_HEAD), null]);

  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = scores.sections[skey];
    rows.push([
      cell(sec.label, STYLE_SUBTOTAL),
      cell(sec.weight + '%', STYLE_SUBTOTAL),
      cell(sec.actual + '/' + sec.max, STYLE_SUBTOTAL),
      cell(sec.pct !== null ? sec.pct.toFixed(2) + '%' : '—', STYLE_SUBTOTAL),
      null,
    ]);
  });
  rows.push([
    cell('PUNTAJE GENERAL', STYLE_TITLE), null, null,
    cell(scores.overall !== null ? scores.overall.toFixed(2) + '%' : '—', STYLE_TITLE), null,
  ]);
  rows.push([]);

  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const sec = BSA_TEMPLATE.sections[skey];
    rows.push([cell(sec.label, STYLE_TITLE), null, null, null, null]);
    rows.push([cell('Grupo', STYLE_HEAD), cell('Ítem', STYLE_HEAD), cell('Estado / Puntos', STYLE_HEAD), cell('Observación', STYLE_HEAD), null]);
    Object.keys(sec.subsections).forEach(subKey => {
      const sub = sec.subsections[subKey];
      Object.keys(sub.groups).forEach(gKey => {
        sub.groups[gKey].forEach(it => {
          const r = a.responses[it.id] || {};
          let estado = 'Sin evaluar', style = STYLE_DEFAULT;
          if (r.state === 'ok') { estado = `Cumple (${it.max}/${it.max})`; style = STYLE_OK; }
          else if (r.state === 'bad') { estado = `No cumple (0/${it.max})`; style = STYLE_BAD; }
          else if (r.state === 'na') { estado = 'No aplica'; }
          const label = subKey !== '_default' ? `${subKey} — ${gKey}` : gKey;
          rows.push([cell(label, style), cell(it.text, style), cell(estado, style), cell(r.obs || '', style), null]);
        });
      });
    });
  });
  return rows;
}

function exportAuditExcel(storeKey, auditId) {
  const a = getAudits(storeKey).find(x => x.id === auditId);
  if (!a) return;
  const scores = computeScores(a.responses);
  const s = STORE_MAP[storeKey];
  const rows = auditToRows(s.name, a, scores);
  downloadXlsx('BSA', rows, [26, 55, 20, 30, 30], `BSA_${s.name.replace(/\s+/g,'_')}_${a.fecha}.xlsx`);
  toast('Descargando Excel...');
}

// ============================================================
//  SCREEN: CONSOLIDADO
// ============================================================
async function renderConsolidado() {
  if (syncConfigured()) { toast('🔄 Sincronizando...'); await syncPullAll(); }
  const body = $('consolidado-body');
  body.innerHTML = '';

  const rows = STORES.map(s => {
    const latest = getLatestAudit(s.key);
    const scores = latest ? computeScores(latest.responses) : null;
    return { store: s, latest, scores };
  });

  const note = document.createElement('div');
  note.className = 'empty-note';
  note.style.padding = '4px 0 16px';
  note.textContent = 'Comparativo con la auditoría más reciente guardada de cada tienda.';
  body.appendChild(note);

  const table = document.createElement('table');
  table.className = 'cons-table';
  let thead = `<tr><th>Sección</th>${STORES.map(s=>`<th>${s.name.replace('Hooters ','')}</th>`).join('')}</tr>`;
  let trows = '';
  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const label = BSA_TEMPLATE.sections[skey].label;
    trows += `<tr><td>${label}</td>${rows.map(r => {
      const pct = r.scores ? r.scores.sections[skey].pct : null;
      return `<td>${pct!==null?pct.toFixed(1)+'%':'—'}</td>`;
    }).join('')}</tr>`;
  });
  trows += `<tr class="total-row"><td>GENERAL</td>${rows.map(r => {
    const pct = r.scores ? r.scores.overall : null;
    return `<td>${pct!==null?pct.toFixed(1)+'%':'—'}</td>`;
  }).join('')}</tr>`;
  trows += `<tr><td>Fecha auditoría</td>${rows.map(r => `<td>${r.latest?fmtDate(r.latest.fecha):'—'}</td>`).join('')}</tr>`;
  table.innerHTML = thead + trows;
  body.appendChild(table);

  const btn = document.createElement('button');
  btn.className = 'btn-primary btn-block';
  btn.style.marginTop = '22px';
  btn.textContent = '⬇️ Exportar consolidado a Excel';
  btn.addEventListener('click', () => exportConsolidadoExcel(rows));
  body.appendChild(btn);

  show('screen-consolidado');
}
$('btn-consolidado-back').addEventListener('click', () => { renderStoreGrid(); show('screen-select'); });

function exportConsolidadoExcel(rows) {
  const wide = STORES.length + 1;
  const out = [];
  out.push([cell('BSA HOOTERS COLOMBIA — CONSOLIDADO', STYLE_TITLE), ...Array(STORES.length).fill(null)]);
  out.push([cell('Sección', STYLE_HEAD), ...rows.map(r => cell(r.store.name, STYLE_HEAD))]);
  out.push([cell('Fecha auditoría', STYLE_SUBTOTAL), ...rows.map(r => cell(r.latest ? fmtDate(r.latest.fecha) : '—'))]);
  out.push([cell('Auditor', STYLE_SUBTOTAL), ...rows.map(r => cell(r.latest ? (r.latest.auditor || '—') : '—'))]);
  out.push([]);
  BSA_TEMPLATE.sectionOrder.forEach(skey => {
    const label = BSA_TEMPLATE.sections[skey].label;
    out.push([cell(label), ...rows.map(r => {
      const pct = r.scores ? r.scores.sections[skey].pct : null;
      return cell(pct !== null ? pct.toFixed(2) + '%' : '—');
    })]);
  });
  out.push([cell('PUNTAJE GENERAL', STYLE_TITLE), ...rows.map(r => {
    const pct = r.scores ? r.scores.overall : null;
    return cell(pct !== null ? pct.toFixed(2) + '%' : '—', STYLE_TITLE);
  })]);

  downloadXlsx('Consolidado', out, [28, ...Array(STORES.length).fill(22)], `BSA_Consolidado_Colombia_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Descargando consolidado...');
}

// ============================================================
//  INIT — la pantalla de login ya queda activa por defecto en el HTML
// ============================================================
