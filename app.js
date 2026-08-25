/* =========================================================
   Klantdossier — client-side dossierbeheer voor aanvragen
   Geen backend: IndexedDB voor opslag, eigen Anthropic API-key
   (localStorage) voor AI-extractie uit screenshots.
   ========================================================= */

const DB_NAME = 'klantdossierDB';
const DB_VERSION = 1;
let db = null;

const ROLLEN = ['handelaar', 'klant', 'eindgebruiker', 'machineleverancier'];
const BRON_TYPES = [
  { v: 'whatsapp', l: 'WhatsApp', ico: '💬' },
  { v: 'email', l: 'E-mail', ico: '✉️' },
  { v: 'chat', l: 'Chat/anders', ico: '💭' },
  { v: 'telefoon', l: 'Telefoon', ico: '📞' },
];
const STATUSSEN = [
  { v: 'nieuw', l: 'Nieuw, nog niet beantwoord', c: 'warn' },
  { v: 'aangeboden', l: 'Aanbieding verstuurd', c: 'ok' },
  { v: 'reactie_ontvangen', l: 'Reactie ontvangen', c: 'ok' },
  { v: 'gewonnen', l: 'Gewonnen', c: 'ok' },
  { v: 'verloren', l: 'Verloren', c: 'bad' },
  { v: 'afgehandeld', l: 'Afgehandeld', c: 'gray' },
];
// Statussen die nog "open" zijn (niet afgesloten) en dus kunnen opduiken bij Aandacht nodig
const OPEN_STATUSSEN = ['nieuw', 'aangeboden', 'reactie_ontvangen'];

function statusInfo(v) { return STATUSSEN.find(s => s.v === v) || STATUSSEN[0]; }
function bronInfo(v) { return BRON_TYPES.find(b => b.v === v) || BRON_TYPES[2]; }

/* ---------------- Settings (localStorage) ---------------- */
const Settings = {
  get apiKey() { return localStorage.getItem('kd-anthropic-key') || ''; },
  set apiKey(v) { localStorage.setItem('kd-anthropic-key', v || ''); },
  get reminderDays() { return parseInt(localStorage.getItem('kd-reminder-days') || '5', 10); },
  set reminderDays(v) { localStorage.setItem('kd-reminder-days', String(v)); },
  get bedrijfsnaam() { return localStorage.getItem('kd-bedrijfsnaam') || ''; },
  set bedrijfsnaam(v) { localStorage.setItem('kd-bedrijfsnaam', v || ''); },
  get afzenderNaam() { return localStorage.getItem('kd-afzendernaam') || ''; },
  set afzenderNaam(v) { localStorage.setItem('kd-afzendernaam', v || ''); },
};

/* ---------------- IndexedDB ---------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('dossiers')) {
        const s = d.createObjectStore('dossiers', { keyPath: 'id' });
        s.createIndex('naam', 'naam', { unique: false });
        s.createIndex('email', 'email', { unique: false });
        s.createIndex('telefoon', 'telefoon', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!d.objectStoreNames.contains('aanvragen')) {
        const s = d.createObjectStore('aanvragen', { keyPath: 'id' });
        s.createIndex('dossierId', 'dossierId', { unique: false });
        s.createIndex('status', 'status', { unique: false });
        s.createIndex('laatsteContact', 'laatsteContact', { unique: false });
      }
      if (!d.objectStoreNames.contains('contactmomenten')) {
        const s = d.createObjectStore('contactmomenten', { keyPath: 'id' });
        s.createIndex('dossierId', 'dossierId', { unique: false });
        s.createIndex('aanvraagId', 'aanvraagId', { unique: false });
        s.createIndex('datum', 'datum', { unique: false });
      }
      if (!d.objectStoreNames.contains('photos')) {
        d.createObjectStore('photos', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}
function storeReq(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const r = store[method](...args);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbPut(storeName, obj) {
  const t = tx([storeName], 'readwrite');
  await storeReq(t.objectStore(storeName), 'put', obj);
  return obj;
}
async function dbGet(storeName, id) {
  const t = tx([storeName]);
  return storeReq(t.objectStore(storeName), 'get', id);
}
async function dbDelete(storeName, id) {
  const t = tx([storeName], 'readwrite');
  return storeReq(t.objectStore(storeName), 'delete', id);
}
async function dbAll(storeName, indexName, query) {
  const t = tx([storeName]);
  const store = indexName ? t.objectStore(storeName).index(indexName) : t.objectStore(storeName);
  return storeReq(store, 'getAll', query);
}
async function dbAllByIndex(storeName, indexName, value) {
  return dbAll(storeName, indexName, value);
}

/* ---------------- Utilities ---------------- */
function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}
function daysSince(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}
function toast(msg, ms = 2600) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function openModal(html) {
  const host = document.getElementById('modalHost');
  host.innerHTML = `<div class="modal-bg" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal() { document.getElementById('modalHost').innerHTML = ''; }

/* ---------------- Beeldverwerking ---------------- */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// Resize + comprimeer naar JPEG, max lange zijde en max bytes (voor AI-call en opslag)
async function compressImage(file, maxDim = 1568, maxBytes = 3_500_000) {
  const img = await fileToImage(file);
  let { width, height } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.88;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length * 0.75 > maxBytes && quality > 0.35) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  return { dataUrl, mimeType: 'image/jpeg', width, height };
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.split(',')[1];
}

/* ---------------- AI-extractie (Claude) ---------------- */
const KD_MODEL_DEFAULT = 'claude-sonnet-4-5';
function getModelId() { return localStorage.getItem('kd-model') || KD_MODEL_DEFAULT; }

const EXTRACT_SYSTEM_PROMPT = `Je bent een assistent die screenshots van zakelijke gesprekken (WhatsApp, e-mail, chat) over machine- of onderdelenaanvragen analyseert voor een dossierbeheersysteem bij een machinehandel.

Lees de afbeelding zorgvuldig en haal er gestructureerde gegevens uit. Antwoord ALLEEN met geldige JSON, geen uitleg, geen markdown-codeblok, exact dit schema:

{
  "bedrijf": string of null,        // naam van het bedrijf/de persoon waarmee dit gesprek is (de handelaar of klant met wie contact is)
  "contactpersoon": string of null, // naam van de individuele contactpersoon indien anders dan bedrijfsnaam
  "rol": "handelaar" | "klant" | "onbekend",
  "land": string of null,
  "telefoon": string of null,
  "email": string of null,
  "eindgebruiker": string of null,  // naam van de uiteindelijke eindgebruiker/klant van de machine, indien genoemd (kan afwijken van bedrijf/contactpersoon)
  "bronType": "whatsapp" | "email" | "chat" | "telefoon" | "anders",
  "datumInGesprek": string of null, // ISO-datum (YYYY-MM-DD) zichtbaar in de screenshot, anders null
  "regels": [ { "machineModel": string, "machineType": string of null, "aantal": number } ],
  "samenvatting": string,           // korte Nederlandse samenvatting (1-3 zinnen) van waar het gesprek over gaat / wat er gevraagd wordt
  "statusHint": "nieuw_aanvraag" | "reactie_op_eerdere_aanvraag" | "algemeen_contact"
}

Als iets niet duidelijk is, gebruik null of een lege array. Verzin geen gegevens die niet in de afbeelding staan. "regels" mag leeg zijn als er geen concrete machine/aantal genoemd wordt.`;

async function extractWithClaude(dataUrl, mimeType) {
  const apiKey = Settings.apiKey;
  if (!apiKey) throw new Error('Geen API key ingesteld');
  const base64 = dataUrlToBase64(dataUrl);
  const body = {
    model: getModelId(),
    max_tokens: 1024,
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Analyseer deze screenshot en geef de JSON terug volgens het schema.' },
      ],
    }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API-fout (${res.status}): ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map(b => b.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Kon AI-respons niet parsen:', text);
    throw new Error('Kon AI-respons niet als JSON lezen. Probeer opnieuw of vul handmatig in.');
  }
}

/* Tesseract.js fallback: alleen ruwe OCR-tekst, geen structuur */
let tesseractLoaded = false;
function loadTesseract() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Kon Tesseract.js niet laden (geen internet?)'));
    document.head.appendChild(s);
  });
}
async function extractWithTesseract(dataUrl, onProgress) {
  await loadTesseract();
  const { data } = await window.Tesseract.recognize(dataUrl, 'nld+eng', {
    logger: (m) => { if (onProgress) onProgress(m); },
  });
  return {
    bedrijf: null, contactpersoon: null, rol: 'onbekend', land: null, telefoon: null, email: null,
    eindgebruiker: null, bronType: 'anders', datumInGesprek: null, regels: [],
    samenvatting: '', statusHint: 'algemeen_contact', ruweTekst: data.text || '',
  };
}

/* ---------------- Dossier matching ---------------- */
function normName(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
async function findMatchingDossiers({ bedrijf, email, telefoon }) {
  const all = await dbAll('dossiers');
  const nBedrijf = normName(bedrijf);
  const nEmail = (email || '').toLowerCase().trim();
  const nTel = (telefoon || '').replace(/[^0-9]/g, '');
  const scored = [];
  for (const d of all) {
    let score = 0;
    if (nEmail && d.email && d.email.toLowerCase().trim() === nEmail) score += 100;
    if (nTel && d.telefoon && d.telefoon.replace(/[^0-9]/g, '').slice(-8) === nTel.slice(-8) && nTel.length >= 6) score += 90;
    const dNaam = normName(d.naam);
    if (nBedrijf && dNaam) {
      if (dNaam === nBedrijf) score += 80;
      else if (dNaam.includes(nBedrijf) || nBedrijf.includes(dNaam)) score += 40;
    }
    if (score > 0) scored.push({ dossier: d, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

async function getAanvraagCountForDossier(dossierId, excludeId) {
  const all = await dbAllByIndex('aanvragen', 'dossierId', dossierId);
  return all.filter(a => a.id !== excludeId).length;
}

/* ---------------- Navigation ---------------- */
let currentDetailDossierId = null;

async function showView(name, opts = {}) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');
  const tabBtn = document.querySelector(`.tabbar button[data-tab="${name}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  else {
    // detail view: highlight dossiers tab
    if (name === 'detail') document.querySelector('.tabbar button[data-tab="dossiers"]')?.classList.add('active');
  }

  if (name === 'nieuw') await renderNieuw();
  if (name === 'dossiers') await renderDossiers();
  if (name === 'detail') await renderDetail(opts.dossierId || currentDetailDossierId);
  if (name === 'aandacht') await renderAandacht();
  if (name === 'instellingen') await renderInstellingen();

  window.scrollTo(0, 0);
}

async function refreshHeader() {
  const dossiers = await dbAll('dossiers');
  document.getElementById('headerSub').textContent = `${dossiers.length} dossier${dossiers.length === 1 ? '' : 's'}`;
  await refreshAandachtBadge();
}

async function refreshAandachtBadge() {
  const items = await getAandachtItems();
  const badge = document.getElementById('aandachtBadge');
  if (items.length > 0) {
    badge.style.display = 'flex';
    badge.textContent = items.length > 99 ? '99+' : items.length;
  } else {
    badge.style.display = 'none';
  }
}

/* =========================================================
   VIEW: NIEUW  (screenshot uploaden → AI-extractie → review → opslaan)
   ========================================================= */
let nieuwState = null;
function resetNieuwState() {
  nieuwState = {
    stage: 'upload', // upload | busy | review
    busyMsg: '',
    forceDossierId: null,
    dataUrl: null, mimeType: null,
    extracted: null,
    matches: [],
    selectedDossierId: null, // null = nieuw dossier aanmaken
    existingAanvragen: [],
    selectedAanvraagId: null, // null = nieuwe aanvraag aanmaken
    form: null, // editable velden
  };
}
resetNieuwState();

async function renderNieuw() {
  const el = document.getElementById('view-nieuw');
  if (nieuwState.stage === 'upload') {
    el.innerHTML = `
      <div class="card">
        <h2>Nieuwe screenshot toevoegen</h2>
        <div class="dropzone" id="dropzone" onclick="document.getElementById('fileInputGallery').click()">
          <div style="font-size:30px;margin-bottom:6px;">📥</div>
          <div><strong>Sleep of tik om een screenshot te kiezen</strong></div>
          <div class="field-hint">Of plak een screenshot (Ctrl/Cmd+V) ergens op deze pagina</div>
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="btn secondary" onclick="document.getElementById('fileInputCamera').click()">📷 Foto maken</button>
          <button class="btn secondary" onclick="document.getElementById('fileInputGallery').click()">🖼️ Kies bestand</button>
        </div>
        <input type="file" id="fileInputCamera" accept="image/*" capture="environment" style="display:none" onchange="onFileInput(event)">
        <input type="file" id="fileInputGallery" accept="image/*" style="display:none" onchange="onFileInput(event)">
        ${!Settings.apiKey ? `<div class="field-hint" style="margin-top:10px;">Geen API key ingesteld — er wordt gratis OCR (Tesseract) gebruikt, dan vul je de velden zelf in. Stel in <a href="#" onclick="showView('instellingen');return false;">Instellingen</a> je Anthropic API key in voor automatische, slimme extractie.</div>` : ''}
      </div>
      <div class="card">
        <h3>Snel handmatig dossier aanmaken</h3>
        <button class="btn secondary block" onclick="startManualEntry()">✏️ Zonder screenshot invoeren</button>
      </div>
    `;
    setupDropzone();
  } else if (nieuwState.stage === 'busy') {
    el.innerHTML = `
      <div class="card" style="text-align:center; padding:40px 16px;">
        ${nieuwState.dataUrl ? `<img src="${nieuwState.dataUrl}" class="thumb" style="max-height:180px;">` : ''}
        <div style="margin:14px 0;"><span class="spin" style="border-color:rgba(37,99,235,.25); border-top-color:var(--accent);"></span></div>
        <div style="color:var(--ink-dim); font-size:13.5px;">${escapeHtml(nieuwState.busyMsg || 'Bezig...')}</div>
      </div>
    `;
  } else if (nieuwState.stage === 'review') {
    el.innerHTML = renderReviewForm();
    await renderMatchSuggestions();
  }
}

function setupDropzone() {
  const dz = document.getElementById('dropzone');
  if (!dz) return;
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) handleImageFile(f);
  });
}

window.addEventListener('paste', (e) => {
  const activeTab = document.querySelector('.tabbar button.active')?.dataset.tab;
  if (activeTab !== 'nieuw' || !nieuwState || nieuwState.stage !== 'upload') return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) handleImageFile(f);
      break;
    }
  }
});

function onFileInput(e) {
  const f = e.target.files?.[0];
  if (f) handleImageFile(f);
  e.target.value = '';
}

async function handleImageFile(file) {
  nieuwState.stage = 'busy';
  nieuwState.busyMsg = 'Afbeelding verwerken...';
  await renderNieuw();
  try {
    const { dataUrl, mimeType } = await compressImage(file);
    nieuwState.dataUrl = dataUrl;
    nieuwState.mimeType = mimeType;

    if (Settings.apiKey) {
      nieuwState.busyMsg = 'AI leest de screenshot...';
      await renderNieuw();
      const extracted = await extractWithClaude(dataUrl, mimeType);
      nieuwState.extracted = extracted;
    } else {
      nieuwState.busyMsg = 'Gratis OCR uitvoeren (kan even duren)...';
      await renderNieuw();
      const extracted = await extractWithTesseract(dataUrl, (m) => {
        if (m.status === 'recognizing text') {
          nieuwState.busyMsg = `Tekst herkennen... ${Math.round((m.progress || 0) * 100)}%`;
        }
      });
      nieuwState.extracted = extracted;
    }
    await prepareReviewForm();
    nieuwState.stage = 'review';
    await renderNieuw();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Er ging iets mis bij het verwerken.');
    // Val terug op handmatige invoer met de foto erbij
    nieuwState.extracted = {
      bedrijf: null, contactpersoon: null, rol: 'onbekend', land: null, telefoon: null, email: null,
      eindgebruiker: null, bronType: 'anders', datumInGesprek: null, regels: [], samenvatting: '', statusHint: 'algemeen_contact',
    };
    await prepareReviewForm();
    nieuwState.stage = 'review';
    await renderNieuw();
  }
}

async function startManualEntry() {
  nieuwState.dataUrl = null; nieuwState.mimeType = null;
  nieuwState.extracted = {
    bedrijf: null, contactpersoon: null, rol: 'onbekend', land: null, telefoon: null, email: null,
    eindgebruiker: null, bronType: 'anders', datumInGesprek: null, regels: [], samenvatting: '', statusHint: 'algemeen_contact',
  };
  await prepareReviewForm();
  nieuwState.stage = 'review';
  await renderNieuw();
}

async function prepareReviewForm() {
  const ex = nieuwState.extracted;
  let forced = null;
  if (nieuwState.forceDossierId) {
    forced = await dbGet('dossiers', nieuwState.forceDossierId);
    if (forced) nieuwState.selectedDossierId = forced.id;
  }
  nieuwState.form = {
    bedrijf: (forced && forced.naam) || ex.bedrijf || '',
    contactpersoon: (forced && forced.contactpersoon) || ex.contactpersoon || '',
    rol: (forced && forced.rol) || (ROLLEN.includes(ex.rol) ? ex.rol : 'handelaar'),
    land: (forced && forced.land) || ex.land || '',
    telefoon: (forced && forced.telefoon) || ex.telefoon || '',
    email: (forced && forced.email) || ex.email || '',
    eindgebruiker: ex.eindgebruiker || '',
    bronType: BRON_TYPES.some(b => b.v === ex.bronType) ? ex.bronType : 'chat',
    datum: ex.datumInGesprek || todayISO(),
    samenvatting: ex.samenvatting || '',
    ruweTekst: ex.ruweTekst || '',
    status: ex.statusHint === 'reactie_op_eerdere_aanvraag' ? 'reactie_ontvangen' : 'nieuw',
  };
  nieuwState.regels = (ex.regels && ex.regels.length ? ex.regels : [{ machineModel: '', machineType: '', aantal: 1 }])
    .map(r => ({ machineModel: r.machineModel || '', machineType: r.machineType || '', aantal: r.aantal || 1 }));
}

function renderReviewForm() {
  const f = nieuwState.form;
  return `
    <div class="card">
      <h2>Controleer &amp; vul aan</h2>
      ${nieuwState.dataUrl ? `<img src="${nieuwState.dataUrl}" class="thumb">` : ''}
      ${nieuwState.extracted?.ruweTekst ? `
        <details style="margin-bottom:10px;">
          <summary style="font-size:12.5px; color:var(--ink-dim); cursor:pointer;">Ruwe OCR-tekst bekijken</summary>
          <textarea readonly style="margin-top:6px;">${escapeHtml(nieuwState.extracted.ruweTekst)}</textarea>
        </details>` : ''}

      <div id="matchSuggestions"></div>

      <h3 style="margin-top:16px;">Dossier</h3>
      <label>Bedrijf / naam</label>
      <input type="text" id="f_bedrijf" value="${escapeHtml(f.bedrijf)}" oninput="onFormFieldInput('bedrijf', this.value)" placeholder="Bijv. Handel BV">
      <div class="row">
        <div>
          <label>Rol</label>
          <select id="f_rol" onchange="onFormFieldInput('rol', this.value)">
            ${ROLLEN.map(r => `<option value="${r}" ${f.rol === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Land</label>
          <input type="text" value="${escapeHtml(f.land)}" oninput="onFormFieldInput('land', this.value)">
        </div>
      </div>
      <label>Contactpersoon</label>
      <input type="text" value="${escapeHtml(f.contactpersoon)}" oninput="onFormFieldInput('contactpersoon', this.value)">
      <div class="row">
        <div>
          <label>Telefoon</label>
          <input type="tel" value="${escapeHtml(f.telefoon)}" oninput="onFormFieldInput('telefoon', this.value)">
        </div>
        <div>
          <label>E-mail</label>
          <input type="email" value="${escapeHtml(f.email)}" oninput="onFormFieldInput('email', this.value)">
        </div>
      </div>

      <hr class="sep">
      <h3>Aanvraag</h3>
      <label>Eindgebruiker (indien anders dan bovenstaand)</label>
      <input type="text" value="${escapeHtml(f.eindgebruiker)}" oninput="onFormFieldInput('eindgebruiker', this.value)" placeholder="Naam eindklant">

      <label>Machines / onderdelen</label>
      <div id="regelsHost">${renderRegels()}</div>
      <button class="btn ghost small" onclick="addRegel()">+ regel toevoegen</button>

      <div class="row" style="margin-top:10px;">
        <div>
          <label>Bron</label>
          <select onchange="onFormFieldInput('bronType', this.value)">
            ${BRON_TYPES.map(b => `<option value="${b.v}" ${f.bronType === b.v ? 'selected' : ''}>${b.ico} ${b.l}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Datum contact</label>
          <input type="date" value="${escapeHtml(f.datum)}" oninput="onFormFieldInput('datum', this.value)">
        </div>
      </div>

      <label>Samenvatting</label>
      <textarea oninput="onFormFieldInput('samenvatting', this.value)">${escapeHtml(f.samenvatting)}</textarea>

      <label>Status</label>
      <select onchange="onFormFieldInput('status', this.value)">
        ${STATUSSEN.map(s => `<option value="${s.v}" ${f.status === s.v ? 'selected' : ''}>${s.l}</option>`).join('')}
      </select>

      <div id="aanvraagKoppelHost"></div>

      <div class="row" style="margin-top:16px;">
        <button class="btn secondary" onclick="cancelReview()">Annuleren</button>
        <button class="btn" id="saveBtn" onclick="saveAanvraag()">Opslaan in dossier</button>
      </div>
    </div>
  `;
}

function renderRegels() {
  return nieuwState.regels.map((r, i) => `
    <div class="linegrid">
      <div><input type="text" placeholder="Model" value="${escapeHtml(r.machineModel)}" oninput="updateRegel(${i},'machineModel',this.value)"></div>
      <div><input type="text" placeholder="Type" value="${escapeHtml(r.machineType)}" oninput="updateRegel(${i},'machineType',this.value)"></div>
      <div><input type="number" min="1" placeholder="Aantal" value="${r.aantal}" oninput="updateRegel(${i},'aantal',this.value)"></div>
      <div><button class="btn danger small" style="padding:9px;" onclick="removeRegel(${i})" title="Verwijderen">✕</button></div>
    </div>
  `).join('');
}
function addRegel() {
  nieuwState.regels.push({ machineModel: '', machineType: '', aantal: 1 });
  document.getElementById('regelsHost').innerHTML = renderRegels();
}
function removeRegel(i) {
  nieuwState.regels.splice(i, 1);
  document.getElementById('regelsHost').innerHTML = renderRegels();
}
function updateRegel(i, key, val) {
  nieuwState.regels[i][key] = key === 'aantal' ? (parseInt(val, 10) || 1) : val;
}
function onFormFieldInput(key, val) {
  nieuwState.form[key] = val;
  if (key === 'bedrijf' || key === 'email' || key === 'telefoon') {
    clearTimeout(window._matchDebounce);
    window._matchDebounce = setTimeout(renderMatchSuggestions, 350);
  }
}

async function renderMatchSuggestions() {
  const host = document.getElementById('matchSuggestions');
  if (!host) return;
  const f = nieuwState.form;
  if (nieuwState.forceDossierId) {
    host.innerHTML = `<div class="card" style="background:var(--chip); border:1px solid #c7d7fb; margin-bottom:12px;">
      <div style="font-size:13.5px;">📁 Wordt toegevoegd aan dossier <strong>${escapeHtml(f.bedrijf)}</strong></div>
    </div>`;
    await renderAanvraagKoppelOpties();
    return;
  }
  if (!f.bedrijf && !f.email && !f.telefoon) { host.innerHTML = ''; nieuwState.selectedDossierId = null; return; }
  const matches = await findMatchingDossiers({ bedrijf: f.bedrijf, email: f.email, telefoon: f.telefoon });
  nieuwState.matches = matches;
  if (matches.length === 0) {
    nieuwState.selectedDossierId = null;
    host.innerHTML = `<div class="field-hint" style="margin-bottom:8px;">Geen bestaand dossier gevonden — er wordt een nieuw dossier aangemaakt.</div>`;
    return;
  }
  const top = matches[0];
  if (!nieuwState.selectedDossierId) nieuwState.selectedDossierId = top.score >= 60 ? top.dossier.id : null;
  host.innerHTML = `
    <div class="card" style="background:var(--chip); border:1px solid #c7d7fb; margin-bottom:12px;">
      <h3 style="color:var(--accent);">Mogelijk bestaand dossier</h3>
      ${matches.map(m => `
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13.5px; margin:6px 0; cursor:pointer;">
          <input type="radio" name="dossierMatch" value="${m.dossier.id}" ${nieuwState.selectedDossierId === m.dossier.id ? 'checked' : ''} onchange="selectDossierMatch('${m.dossier.id}')">
          <span><strong>${escapeHtml(m.dossier.naam)}</strong> <span class="field-hint">(${m.dossier.rol || '—'}${m.dossier.land ? ', ' + escapeHtml(m.dossier.land) : ''})</span></span>
        </label>
      `).join('')}
      <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13.5px; margin:6px 0; cursor:pointer;">
        <input type="radio" name="dossierMatch" value="" ${!nieuwState.selectedDossierId ? 'checked' : ''} onchange="selectDossierMatch(null)">
        <span>Nieuw dossier aanmaken</span>
      </label>
    </div>
  `;
  await renderAanvraagKoppelOpties();
}

async function selectDossierMatch(id) {
  nieuwState.selectedDossierId = id || null;
  await renderAanvraagKoppelOpties();
}

async function renderAanvraagKoppelOpties() {
  const host = document.getElementById('aanvraagKoppelHost');
  if (!host) return;
  if (!nieuwState.selectedDossierId) { host.innerHTML = ''; nieuwState.selectedAanvraagId = null; nieuwState.existingAanvragen = []; return; }
  const all = await dbAllByIndex('aanvragen', 'dossierId', nieuwState.selectedDossierId);
  const open = all.filter(a => OPEN_STATUSSEN.includes(a.status)).sort((a, b) => (b.laatsteContact || '').localeCompare(a.laatsteContact || ''));
  nieuwState.existingAanvragen = open;
  const priorCount = all.length;
  if (open.length === 0) {
    nieuwState.selectedAanvraagId = null;
    host.innerHTML = priorCount > 0 ? `<div class="field-hint" style="margin-top:8px;">Dit dossier heeft al ${priorCount} eerdere aanvraag/aanvragen (allemaal afgehandeld). Dit wordt een nieuwe aanvraag.</div>` : '';
    return;
  }
  nieuwState.selectedAanvraagId = open[0].id;
  host.innerHTML = `
    <hr class="sep">
    <h3>Koppelen aan bestaande aanvraag?</h3>
    <div class="field-hint" style="margin-bottom:6px;">Dit dossier heeft nog ${open.length} openstaande aanvraag/aanvragen. Is dit een reactie daarop, of een nieuwe aanvraag?</div>
    ${open.map(a => `
      <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13.5px; margin:6px 0; cursor:pointer;">
        <input type="radio" name="aanvraagKoppel" value="${a.id}" ${nieuwState.selectedAanvraagId === a.id ? 'checked' : ''} onchange="nieuwState.selectedAanvraagId='${a.id}'">
        <span>${escapeHtml(regelsSummary(a.regels))} <span class="field-hint">— ${fmtDate(a.laatsteContact)}, ${statusInfo(a.status).l}</span></span>
      </label>
    `).join('')}
    <label style="display:flex; align-items:center; gap:8px; font-weight:400; font-size:13.5px; margin:6px 0; cursor:pointer;">
      <input type="radio" name="aanvraagKoppel" value="" onchange="nieuwState.selectedAanvraagId=null">
      <span>Dit is een nieuwe, aparte aanvraag</span>
    </label>
  `;
}

function regelsSummary(regels) {
  if (!regels || regels.length === 0) return 'Aanvraag (geen machine-details)';
  return regels.map(r => `${r.aantal || 1}× ${r.machineModel || '?'}${r.machineType ? ' (' + r.machineType + ')' : ''}`).join(', ');
}

function cancelReview() {
  resetNieuwState();
  renderNieuw();
}

async function saveAanvraag() {
  const btn = document.getElementById('saveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Opslaan...'; }
  try {
    const f = nieuwState.form;
    if (!f.bedrijf || !f.bedrijf.trim()) {
      toast('Vul minimaal een bedrijfs-/klantnaam in.');
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan in dossier'; }
      return;
    }
    const now = new Date().toISOString();

    // 1) Dossier resolven
    let dossierId = nieuwState.selectedDossierId;
    if (dossierId) {
      const existing = await dbGet('dossiers', dossierId);
      existing.naam = existing.naam || f.bedrijf;
      existing.rol = existing.rol || f.rol;
      existing.land = existing.land || f.land;
      existing.contactpersoon = existing.contactpersoon || f.contactpersoon;
      existing.telefoon = existing.telefoon || f.telefoon;
      existing.email = existing.email || f.email;
      existing.updatedAt = now;
      await dbPut('dossiers', existing);
    } else {
      dossierId = uid('d');
      await dbPut('dossiers', {
        id: dossierId, naam: f.bedrijf.trim(), rol: f.rol, land: f.land || '',
        contactpersoon: f.contactpersoon || '', telefoon: f.telefoon || '', email: f.email || '',
        notities: '', createdAt: now, updatedAt: now,
      });
    }

    // 2) Foto opslaan (indien aanwezig)
    let photoId = null;
    if (nieuwState.dataUrl) {
      photoId = uid('p');
      await dbPut('photos', { id: photoId, data: nieuwState.dataUrl, mimeType: nieuwState.mimeType, createdAt: now });
    }

    // 3) Aanvraag resolven (nieuw of koppelen aan bestaand)
    const regels = nieuwState.regels.filter(r => r.machineModel.trim() || r.machineType.trim());
    let aanvraagId = nieuwState.selectedAanvraagId;
    if (aanvraagId) {
      const existing = await dbGet('aanvragen', aanvraagId);
      if (regels.length) existing.regels = [...existing.regels, ...regels];
      existing.eindgebruiker = f.eindgebruiker || existing.eindgebruiker;
      existing.status = f.status;
      existing.laatsteContact = f.datum || todayISO();
      existing.samenvatting = f.samenvatting || existing.samenvatting;
      existing.updatedAt = now;
      await dbPut('aanvragen', existing);
    } else {
      aanvraagId = uid('a');
      await dbPut('aanvragen', {
        id: aanvraagId, dossierId, eindgebruiker: f.eindgebruiker || '', regels,
        status: f.status, bronType: f.bronType,
        datumAanvraag: f.datum || todayISO(), laatsteContact: f.datum || todayISO(),
        samenvatting: f.samenvatting || '', createdAt: now, updatedAt: now,
      });
    }

    // 4) Contactmoment loggen
    await dbPut('contactmomenten', {
      id: uid('c'), dossierId, aanvraagId, datum: f.datum || todayISO(), type: f.bronType,
      screenshotId: photoId, samenvatting: f.samenvatting || '', ruweTekst: nieuwState.extracted?.ruweTekst || '',
      createdAt: now,
    });

    toast('Opgeslagen in dossier ✓');
    resetNieuwState();
    await refreshHeader();
    currentDetailDossierId = dossierId;
    await showView('detail', { dossierId });
  } catch (err) {
    console.error(err);
    toast('Opslaan mislukt: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Opslaan in dossier'; }
  }
}

/* =========================================================
   VIEW: DOSSIERS  (lijst, zoeken, filteren)
   ========================================================= */
let dossierFilter = { q: '', rol: '' };

async function renderDossiers() {
  const el = document.getElementById('view-dossiers');
  el.innerHTML = `
    <div class="search">
      <span class="ico">🔍</span>
      <input type="text" placeholder="Zoek op naam, contactpersoon, e-mail..." value="${escapeHtml(dossierFilter.q)}" oninput="dossierFilter.q=this.value; renderDossierList();">
    </div>
    <div class="swatch-btns" style="margin-bottom:12px;">
      <button class="${dossierFilter.rol === '' ? 'sel' : ''}" onclick="dossierFilter.rol='';renderDossierList();">Alle</button>
      ${ROLLEN.map(r => `<button class="${dossierFilter.rol === r ? 'sel' : ''}" onclick="dossierFilter.rol='${r}';renderDossierList();">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
    </div>
    <div id="dossierListHost"></div>
  `;
  await renderDossierList();
}

async function renderDossierList() {
  const host = document.getElementById('dossierListHost');
  if (!host) return;
  let all = await dbAll('dossiers');
  const q = normName(dossierFilter.q);
  if (q) {
    all = all.filter(d => normName(d.naam).includes(q) || normName(d.contactpersoon).includes(q) || (d.email || '').toLowerCase().includes(dossierFilter.q.toLowerCase()));
  }
  if (dossierFilter.rol) all = all.filter(d => d.rol === dossierFilter.rol);
  all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  if (all.length === 0) {
    host.innerHTML = `<div class="empty"><div class="ico">📁</div>Nog geen dossiers${dossierFilter.q || dossierFilter.rol ? ' gevonden' : ''}.<br>${!dossierFilter.q && !dossierFilter.rol ? 'Voeg een screenshot toe via "Nieuw".' : ''}</div>`;
    return;
  }

  const rows = await Promise.all(all.map(async d => {
    const aanvragen = await dbAllByIndex('aanvragen', 'dossierId', d.id);
    const openCount = aanvragen.filter(a => OPEN_STATUSSEN.includes(a.status)).length;
    return { d, total: aanvragen.length, openCount };
  }));

  host.innerHTML = rows.map(({ d, total, openCount }) => `
    <div class="dossier-item" onclick="showView('detail',{dossierId:'${d.id}'})">
      <div class="avatar">${escapeHtml(initials(d.naam))}</div>
      <div class="info">
        <div class="name">${escapeHtml(d.naam)}</div>
        <div class="meta">
          <span class="chip gray">${d.rol || '—'}</span>
          ${d.land ? `<span>${escapeHtml(d.land)}</span>` : ''}
          <span>${total} aanvra${total === 1 ? 'ag' : 'gen'}</span>
          ${openCount > 0 ? `<span class="chip warn">${openCount} open</span>` : ''}
        </div>
      </div>
      <div class="arrow">›</div>
    </div>
  `).join('');
}

function startNewForDossier(dossierId) {
  resetNieuwState();
  nieuwState.forceDossierId = dossierId;
  showView('nieuw');
}

/* =========================================================
   VIEW: DOSSIER DETAIL
   ========================================================= */
async function renderDetail(dossierId) {
  currentDetailDossierId = dossierId;
  const el = document.getElementById('view-detail');
  const d = await dbGet('dossiers', dossierId);
  if (!d) { el.innerHTML = `<div class="empty">Dossier niet gevonden.</div>`; return; }

  const aanvragen = (await dbAllByIndex('aanvragen', 'dossierId', dossierId)).sort((a, b) => (b.laatsteContact || '').localeCompare(a.laatsteContact || ''));
  const contactmomenten = (await dbAllByIndex('contactmomenten', 'dossierId', dossierId)).sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || b.createdAt.localeCompare(a.createdAt));

  // Stats: hoe vaak is welk machinemodel aangevraagd door dit dossier
  const modelCounts = {};
  for (const a of aanvragen) {
    for (const r of (a.regels || [])) {
      const key = (r.machineModel || 'onbekend').trim() || 'onbekend';
      modelCounts[key] = (modelCounts[key] || 0) + (r.aantal || 1);
    }
  }
  const modelEntries = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]);

  el.innerHTML = `
    <button class="btn ghost" style="padding-left:0;" onclick="showView('dossiers')">‹ Terug naar dossiers</button>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h2 style="font-size:18px;">${escapeHtml(d.naam)}</h2>
          <div class="row" style="gap:6px; margin:6px 0 10px; flex-wrap:wrap;">
            <span class="chip gray">${d.rol || '—'}</span>
            ${d.land ? `<span class="chip gray">${escapeHtml(d.land)}</span>` : ''}
          </div>
        </div>
        <button class="btn ghost small" onclick="openEditDossierModal('${d.id}')">✏️ Bewerken</button>
      </div>
      <div style="font-size:13.5px; color:var(--ink-dim); line-height:1.7;">
        ${d.contactpersoon ? `👤 ${escapeHtml(d.contactpersoon)}<br>` : ''}
        ${d.telefoon ? `📞 <a href="tel:${escapeHtml(d.telefoon)}">${escapeHtml(d.telefoon)}</a><br>` : ''}
        ${d.email ? `✉️ <a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a><br>` : ''}
      </div>
      ${d.notities ? `<div class="field-hint" style="margin-top:8px; white-space:pre-wrap;">${escapeHtml(d.notities)}</div>` : ''}
      <div class="row" style="margin-top:12px;">
        <button class="btn small" onclick="startNewForDossier('${d.id}')">📷 Nieuw contact toevoegen</button>
        <button class="btn danger small" onclick="confirmDeleteDossier('${d.id}')">Verwijderen</button>
      </div>
    </div>

    ${modelEntries.length > 0 ? `
    <div class="card">
      <h3>Aanvraaghistorie per machine</h3>
      ${modelEntries.map(([model, count]) => `
        <div style="display:flex; justify-content:space-between; font-size:13.5px; padding:5px 0; border-bottom:1px solid var(--line);">
          <span>${escapeHtml(model)}</span>
          <strong>${count}×${count >= 2 ? ' — vaker aangevraagd' : ''}</strong>
        </div>
      `).join('')}
    </div>` : ''}

    <div class="card">
      <h3>Aanvragen (${aanvragen.length})</h3>
      ${aanvragen.length === 0 ? `<div class="field-hint">Nog geen aanvragen.</div>` : aanvragen.map(a => renderAanvraagRow(a)).join('')}
    </div>

    <div class="card">
      <h3>Tijdlijn</h3>
      ${contactmomenten.length === 0 ? `<div class="field-hint">Nog geen contactmomenten.</div>` : `
      <div class="timeline">
        ${contactmomenten.map(c => `
          <div class="tl-item">
            <div class="date">${fmtDate(c.datum)} · ${bronInfo(c.type).ico} ${bronInfo(c.type).l}</div>
            <div class="body">
              ${c.samenvatting ? `<div style="font-size:13.5px;">${escapeHtml(c.samenvatting)}</div>` : `<div class="field-hint">Geen samenvatting</div>`}
              ${c.screenshotId ? `<button class="btn ghost small" style="padding:4px 0; margin-top:4px;" onclick="viewPhoto('${c.screenshotId}')">🖼️ Screenshot bekijken</button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>`}
    </div>
  `;
}

function renderAanvraagRow(a) {
  const si = statusInfo(a.status);
  const days = daysSince(a.laatsteContact);
  return `
    <div style="border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div style="font-size:13.5px; font-weight:600;">${escapeHtml(regelsSummary(a.regels))}</div>
        <span class="chip ${si.c}">${si.l}</span>
      </div>
      ${a.eindgebruiker ? `<div class="field-hint">Eindgebruiker: ${escapeHtml(a.eindgebruiker)}</div>` : ''}
      <div class="field-hint">Laatste contact: ${fmtDate(a.laatsteContact)}${days != null ? ` (${days} dag${days === 1 ? '' : 'en'} geleden)` : ''}</div>
      ${a.samenvatting ? `<div style="font-size:12.5px; margin-top:4px; color:var(--ink-dim);">${escapeHtml(a.samenvatting)}</div>` : ''}
      <div class="row" style="margin-top:8px; gap:6px;">
        <select style="flex:1; padding:6px 8px; font-size:12.5px;" onchange="updateAanvraagStatus('${a.id}', this.value)">
          ${STATUSSEN.map(s => `<option value="${s.v}" ${a.status === s.v ? 'selected' : ''}>${s.l}</option>`).join('')}
        </select>
        <button class="btn danger small" onclick="confirmDeleteAanvraag('${a.id}')">✕</button>
      </div>
    </div>
  `;
}

async function updateAanvraagStatus(aanvraagId, status) {
  const a = await dbGet('aanvragen', aanvraagId);
  if (!a) return;
  a.status = status;
  a.updatedAt = new Date().toISOString();
  await dbPut('aanvragen', a);
  toast('Status bijgewerkt');
  await renderDetail(a.dossierId);
  await refreshHeader();
}

function confirmDeleteAanvraag(aanvraagId) {
  openModal(`
    <h3>Aanvraag verwijderen?</h3>
    <p style="font-size:13.5px; color:var(--ink-dim);">Dit verwijdert ook de bijbehorende contactmomenten. Dit kan niet ongedaan gemaakt worden.</p>
    <div class="row"><button class="btn secondary" onclick="closeModal()">Annuleren</button><button class="btn danger" onclick="deleteAanvraag('${aanvraagId}')">Verwijderen</button></div>
  `);
}
async function deleteAanvraag(aanvraagId) {
  const a = await dbGet('aanvragen', aanvraagId);
  if (!a) { closeModal(); return; }
  const moments = await dbAllByIndex('contactmomenten', 'aanvraagId', aanvraagId);
  for (const m of moments) {
    if (m.screenshotId) await dbDelete('photos', m.screenshotId);
    await dbDelete('contactmomenten', m.id);
  }
  await dbDelete('aanvragen', aanvraagId);
  closeModal();
  toast('Aanvraag verwijderd');
  await renderDetail(a.dossierId);
  await refreshHeader();
}

function confirmDeleteDossier(dossierId) {
  openModal(`
    <h3>Dossier verwijderen?</h3>
    <p style="font-size:13.5px; color:var(--ink-dim);">Dit verwijdert het volledige dossier inclusief alle aanvragen, contactmomenten en screenshots. Dit kan niet ongedaan gemaakt worden.</p>
    <div class="row"><button class="btn secondary" onclick="closeModal()">Annuleren</button><button class="btn danger" onclick="deleteDossier('${dossierId}')">Verwijderen</button></div>
  `);
}
async function deleteDossier(dossierId) {
  const aanvragen = await dbAllByIndex('aanvragen', 'dossierId', dossierId);
  for (const a of aanvragen) await dbDelete('aanvragen', a.id);
  const moments = await dbAllByIndex('contactmomenten', 'dossierId', dossierId);
  for (const m of moments) {
    if (m.screenshotId) await dbDelete('photos', m.screenshotId);
    await dbDelete('contactmomenten', m.id);
  }
  await dbDelete('dossiers', dossierId);
  closeModal();
  toast('Dossier verwijderd');
  await showView('dossiers');
  await refreshHeader();
}

function openEditDossierModal(dossierId) {
  dbGet('dossiers', dossierId).then(d => {
    openModal(`
      <button class="close" onclick="closeModal()">✕</button>
      <h3>Dossier bewerken</h3>
      <label>Naam</label><input type="text" id="ed_naam" value="${escapeHtml(d.naam)}">
      <label>Rol</label>
      <select id="ed_rol">${ROLLEN.map(r => `<option value="${r}" ${d.rol === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>
      <label>Land</label><input type="text" id="ed_land" value="${escapeHtml(d.land || '')}">
      <label>Contactpersoon</label><input type="text" id="ed_contact" value="${escapeHtml(d.contactpersoon || '')}">
      <div class="row">
        <div><label>Telefoon</label><input type="tel" id="ed_tel" value="${escapeHtml(d.telefoon || '')}"></div>
        <div><label>E-mail</label><input type="email" id="ed_email" value="${escapeHtml(d.email || '')}"></div>
      </div>
      <label>Notities</label><textarea id="ed_notities">${escapeHtml(d.notities || '')}</textarea>
      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" onclick="closeModal()">Annuleren</button>
        <button class="btn" onclick="saveEditDossier('${dossierId}')">Opslaan</button>
      </div>
    `);
  });
}
async function saveEditDossier(dossierId) {
  const d = await dbGet('dossiers', dossierId);
  d.naam = document.getElementById('ed_naam').value.trim() || d.naam;
  d.rol = document.getElementById('ed_rol').value;
  d.land = document.getElementById('ed_land').value;
  d.contactpersoon = document.getElementById('ed_contact').value;
  d.telefoon = document.getElementById('ed_tel').value;
  d.email = document.getElementById('ed_email').value;
  d.notities = document.getElementById('ed_notities').value;
  d.updatedAt = new Date().toISOString();
  await dbPut('dossiers', d);
  closeModal();
  toast('Dossier bijgewerkt');
  await renderDetail(dossierId);
  await refreshHeader();
}

function viewPhoto(photoId) {
  dbGet('photos', photoId).then(p => {
    if (!p) return;
    openModal(`<button class="close" onclick="closeModal()">✕</button><img src="${p.data}" style="width:100%; border-radius:10px; margin-top:8px;">`);
  });
}

/* =========================================================
   VIEW: AANDACHT NODIG  (open aanvragen zonder recente reactie)
   ========================================================= */
async function getAandachtItems() {
  if (!db) return [];
  const aanvragen = await dbAll('aanvragen');
  const threshold = Settings.reminderDays;
  const open = aanvragen.filter(a => OPEN_STATUSSEN.includes(a.status));
  const withDays = open.map(a => ({ a, days: daysSince(a.laatsteContact) ?? 0 })).filter(x => x.days >= threshold);
  withDays.sort((x, y) => y.days - x.days);
  const out = [];
  for (const { a, days } of withDays) {
    const d = await dbGet('dossiers', a.dossierId);
    if (d) out.push({ a, d, days });
  }
  return out;
}

async function renderAandacht() {
  const el = document.getElementById('view-aandacht');
  const items = await getAandachtItems();
  el.innerHTML = `
    <div class="card" style="background:var(--chip); border:1px solid #c7d7fb;">
      <div style="font-size:13px; color:var(--accent);">🔔 Aanvragen zonder reactie na <strong>${Settings.reminderDays} dagen</strong> verschijnen hier. Pas dit aan bij Instellingen.</div>
    </div>
    ${items.length === 0 ? `<div class="empty"><div class="ico">✅</div>Niets dat aandacht nodig heeft.</div>` : items.map(({ a, d, days }) => `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <div style="font-weight:700; font-size:14.5px;">${escapeHtml(d.naam)}</div>
            <div class="field-hint">${escapeHtml(regelsSummary(a.regels))}</div>
          </div>
          <span class="chip warn">${days}d stil</span>
        </div>
        <div class="field-hint" style="margin-top:6px;">Status: ${statusInfo(a.status).l} · Laatste contact: ${fmtDate(a.laatsteContact)}</div>
        <div class="row" style="margin-top:10px;">
          <button class="btn small" onclick="sendReminder('${a.id}')" ${!d.email ? 'disabled title="Geen e-mailadres bekend"' : ''}>✉️ Herinnering sturen</button>
          <button class="btn secondary small" onclick="showView('detail',{dossierId:'${d.id}'})">Dossier openen</button>
        </div>
        <button class="btn ghost small" style="padding-left:0; margin-top:2px;" onclick="markAanvraagAfgehandeld('${a.id}')">Markeer als afgehandeld</button>
      </div>
    `).join('')}
  `;
}

function buildReminderMail(dossier, aanvraag) {
  const afzender = Settings.afzenderNaam || '';
  const bedrijf = Settings.bedrijfsnaam || '';
  const items = regelsSummary(aanvraag.regels);
  const subject = `Even opvolgen: uw aanvraag${bedrijf ? ' bij ' + bedrijf : ''}`;
  const body = `Beste ${dossier.contactpersoon || dossier.naam},\n\n`
    + `Graag even opvolgen over de volgende aanvraag:\n${items}\n\n`
    + `Ons laatste contact hierover was op ${fmtDate(aanvraag.laatsteContact)}. Hebben jullie hier al een terugkoppeling over, of kunnen we ergens mee helpen?\n\n`
    + `Met vriendelijke groet,\n${afzender}${bedrijf ? '\n' + bedrijf : ''}`;
  return { subject, body };
}

function sendReminder(aanvraagId) {
  Promise.all([dbGet('aanvragen', aanvraagId)]).then(async ([a]) => {
    const d = await dbGet('dossiers', a.dossierId);
    if (!d.email) { toast('Geen e-mailadres bekend voor dit dossier.'); return; }
    const { subject, body } = buildReminderMail(d, a);
    const mailto = `mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    a.herinneringVerstuurdOp = new Date().toISOString();
    await dbPut('aanvragen', a);
    toast('E-mail geopend in je mailprogramma');
  });
}

async function markAanvraagAfgehandeld(aanvraagId) {
  const a = await dbGet('aanvragen', aanvraagId);
  a.status = 'afgehandeld';
  a.updatedAt = new Date().toISOString();
  await dbPut('aanvragen', a);
  toast('Gemarkeerd als afgehandeld');
  await renderAandacht();
  await refreshAandachtBadge();
}

/* =========================================================
   VIEW: INSTELLINGEN
   ========================================================= */
async function renderInstellingen() {
  const el = document.getElementById('view-instellingen');
  const dossiers = await dbAll('dossiers');
  const aanvragen = await dbAll('aanvragen');
  el.innerHTML = `
    <div class="card">
      <h2>AI &amp; API</h2>
      <label>Anthropic API key</label>
      <input type="text" id="s_apikey" value="${escapeHtml(Settings.apiKey)}" placeholder="sk-ant-...">
      <div class="field-hint">Wordt alleen lokaal in je browser bewaard en rechtstreeks naar Anthropic gestuurd. Zonder key wordt gratis OCR (Tesseract) gebruikt en vul je de velden zelf in. Een key maak je op <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a>.</div>
      <label>Model (geavanceerd, optioneel)</label>
      <input type="text" id="s_model" value="${escapeHtml(localStorage.getItem('kd-model') || '')}" placeholder="${KD_MODEL_DEFAULT}">
      <button class="btn block" style="margin-top:12px;" onclick="saveApiSettings()">Opslaan</button>
    </div>

    <div class="card">
      <h2>Herinneringen</h2>
      <label>Aandacht na hoeveel dagen zonder reactie?</label>
      <input type="number" min="1" id="s_reminderdays" value="${Settings.reminderDays}">
      <label>Jouw naam (voor e-mail ondertekening)</label>
      <input type="text" id="s_afzender" value="${escapeHtml(Settings.afzenderNaam)}">
      <label>Bedrijfsnaam</label>
      <input type="text" id="s_bedrijf" value="${escapeHtml(Settings.bedrijfsnaam)}">
      <button class="btn block" style="margin-top:12px;" onclick="saveReminderSettings()">Opslaan</button>
    </div>

    <div class="card">
      <h2>Gegevens</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="num">${dossiers.length}</div><div class="lbl">Dossiers</div></div>
        <div class="stat-box"><div class="num">${aanvragen.length}</div><div class="lbl">Aanvragen</div></div>
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" onclick="exportCSV()">⬇️ Export CSV</button>
        <button class="btn secondary" onclick="exportJSON()">⬇️ Volledige back-up</button>
      </div>
      <label style="margin-top:12px;">Back-up terugzetten (JSON)</label>
      <input type="file" accept="application/json" onchange="importJSON(event)">
      <button class="btn danger block" style="margin-top:16px;" onclick="confirmWipe()">Alle gegevens wissen</button>
    </div>

    <div class="card">
      <h3>Over</h3>
      <div class="field-hint">Klantdossier — alles blijft lokaal op dit apparaat (IndexedDB). Maak regelmatig een back-up.</div>
    </div>
  `;
}

function saveApiSettings() {
  Settings.apiKey = document.getElementById('s_apikey').value.trim();
  const model = document.getElementById('s_model').value.trim();
  if (model) localStorage.setItem('kd-model', model); else localStorage.removeItem('kd-model');
  toast('Instellingen opgeslagen');
}
function saveReminderSettings() {
  Settings.reminderDays = parseInt(document.getElementById('s_reminderdays').value, 10) || 5;
  Settings.afzenderNaam = document.getElementById('s_afzender').value.trim();
  Settings.bedrijfsnaam = document.getElementById('s_bedrijf').value.trim();
  toast('Instellingen opgeslagen');
  refreshAandachtBadge();
}

/* ---------------- Export / Import ---------------- */
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCSV() {
  const dossiers = await dbAll('dossiers');
  const byId = Object.fromEntries(dossiers.map(d => [d.id, d]));
  const aanvragen = await dbAll('aanvragen');
  const header = ['Dossier', 'Rol', 'Land', 'Contactpersoon', 'Telefoon', 'Email', 'Eindgebruiker', 'Machines', 'Status', 'Datum aanvraag', 'Laatste contact', 'Samenvatting'];
  const rows = aanvragen.map(a => {
    const d = byId[a.dossierId] || {};
    return [d.naam, d.rol, d.land, d.contactpersoon, d.telefoon, d.email, a.eindgebruiker, regelsSummary(a.regels), statusInfo(a.status).l, a.datumAanvraag, a.laatsteContact, a.samenvatting].map(csvEscape);
  });
  const csv = [header.join(';'), ...rows.map(r => r.join(';'))].join('\n');
  downloadBlob('﻿' + csv, `klantdossier-export-${todayISO()}.csv`, 'text/csv;charset=utf-8');
  toast('CSV gedownload');
}

async function exportJSON() {
  const data = {
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    dossiers: await dbAll('dossiers'),
    aanvragen: await dbAll('aanvragen'),
    contactmomenten: await dbAll('contactmomenten'),
    photos: await dbAll('photos'),
  };
  downloadBlob(JSON.stringify(data), `klantdossier-backup-${todayISO()}.json`, 'application/json');
  toast('Back-up gedownload');
}

function importJSON(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      for (const d of data.dossiers || []) await dbPut('dossiers', d);
      for (const a of data.aanvragen || []) await dbPut('aanvragen', a);
      for (const c of data.contactmomenten || []) await dbPut('contactmomenten', c);
      for (const p of data.photos || []) await dbPut('photos', p);
      toast(`Back-up ingeladen: ${(data.dossiers || []).length} dossiers`);
      await refreshHeader();
      await renderInstellingen();
    } catch (err) {
      toast('Kon back-up niet lezen: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function confirmWipe() {
  openModal(`
    <h3>Alle gegevens wissen?</h3>
    <p style="font-size:13.5px; color:var(--ink-dim);">Dit verwijdert alle dossiers, aanvragen, contactmomenten en screenshots permanent van dit apparaat. Maak eerst een back-up als je twijfelt.</p>
    <div class="row"><button class="btn secondary" onclick="closeModal()">Annuleren</button><button class="btn danger" onclick="wipeAll()">Alles wissen</button></div>
  `);
}
async function wipeAll() {
  for (const store of ['dossiers', 'aanvragen', 'contactmomenten', 'photos']) {
    const t = tx([store], 'readwrite');
    await storeReq(t.objectStore(store), 'clear');
  }
  closeModal();
  toast('Alle gegevens gewist');
  await refreshHeader();
  await showView('dossiers');
}

/* ---------------- Boot ---------------- */
window.addEventListener('DOMContentLoaded', async () => {
  await openDB();
  await refreshHeader();
  await showView('nieuw');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
