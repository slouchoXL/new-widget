// Prefer ?api=https://... or window.__PACKS_API_BASE set in index.html.
// Fall back to Vite env *when* the file is built by Vite (optional chaining).
// --- API base -----------------------------------------------------------
// Order of precedence: ?api= → window.__PACKS_API_BASE → VITE_API_BASE
let BASE = '';
try {
  const qs = new URLSearchParams(location.search);
  if (qs.get('api')) {
    BASE = qs.get('api');
  } else if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
    BASE = window.__PACKS_API_BASE;
  } else if (typeof import.meta !== 'undefined' &&
             import.meta.env && import.meta.env.VITE_API_BASE) {
    BASE = import.meta.env.VITE_API_BASE;
  }
} catch {}

BASE = String(BASE || '').trim();
// remove trailing slashes
BASE = BASE.replace(/\/+$/, '');
// if someone passed https://host.tld/api, strip the /api (we add it ourselves)
BASE = BASE.replace(/\/api$/i, '');

// Ensure the path starts with /api exactly once
function apiPath(p) {
  const clean = String(p || '');
  if (clean.startsWith('/api')) return clean;
  return '/api' + (clean.startsWith('/') ? clean : `/${clean}`);
}

// --- API helper ---------------------------------------------------------
async function jfetch(path, options = {}) {
  const url = BASE + apiPath(path);
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!r.ok) {
    let msg = `${options.method || 'GET'} ${url} ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// Convenience wrappers (unchanged usage)
async function listPacks()           { return jfetch('/packs'); }
async function getInventory()        { return jfetch('/inventory'); }
async function openPack(packId, key) {
  return jfetch('/packs/open', {
    method: 'POST',
    body: JSON.stringify({ packId, idempotencyKey: key }),
  });
}

function uuid4(){
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

// --- tiny DOM helpers (no jQuery needed) -------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

// --- state --------------------------------------------------------------
let packs = [];
let inv   = { balance:{ COIN: 0 }, items: [] };
let last  = null;             // last opening { results:[...] }

// --- dom refs -----------------------------------------------------------
const balanceEl = $('#balance');
const priceEl   = $('#price');
const cta       = $('#cta');
const trayEl    = $('#tray');
const overlay   = $('#overlay');
const overlayImg= $('#overlay-img');
const errorEl   = $('#error');

// --- init ---------------------------------------------------------------
(async function init(){
  try{
    const [p, i] = await Promise.all([ jfetch('/api/packs'), jfetch('/api/inventory') ]);
    packs = p.packs || [];
    inv   = i || inv;
    renderMeta();
    wireCTA();
  } catch(e){
    showError(String(e.message || e));
  }
})();

// --- rendering ----------------------------------------------------------
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

function renderTray(items){
  trayEl.replaceChildren();
  if (!items || !items.length){
    trayEl.hidden = true;
    return;
  }
  items.forEach((it, idx) => {
    const btn = el('button', 'card');
    const img = el('img');
    img.src = it.imageUrl || it.artUrl || './assets/card-front.png';
    img.alt = it.name || 'Card';
    btn.appendChild(img);
    btn.addEventListener('click', () => openOverlay(img.src));
    trayEl.appendChild(btn);
  });
  trayEl.hidden = false;
}

function openOverlay(src){
  overlayImg.src = src;
  overlay.hidden = false;
}
function closeOverlay(){ overlay.hidden = true; }

overlay.addEventListener('click', closeOverlay);

// --- flow ---------------------------------------------------------------
function wireCTA(){
  cta.addEventListener('click', async ()=>{
    try{
      const pack = packs[0];
      if (!pack) return;

      // phase: open
      cta.disabled = true;
      cta.textContent = 'Opening…';

      const res = await jfetch('/api/packs/open', {
        method: 'POST',
        body: JSON.stringify({ packId: pack.id, idempotencyKey: uuid4() })
      });

      // pad to five if server returns <5
      const five = padToFive(res.results || []);
      last = { ...res, results: five };

      // update balance
      try{ inv = (await jfetch('/api/inventory')) || inv; }catch{}

      // render
      renderMeta();
      renderTray(last.results);

      // switch CTA to "Add to collection"
      cta.textContent = 'Add to collection';
      cta.disabled = false;

      // swap handler once: collect then reset
      cta.onclick = async ()=>{
        if (overlay && !overlay.hidden) return; // ignore while enlarged
        cta.disabled = true;
        cta.textContent = 'Adding…';
        try{
          // If you later add a real backend endpoint, call it here.
          // For now we just refresh inventory so UI stays honest.
          await jfetch('/api/inventory');
          // reset flow
          last = null;
          renderTray([]);
          cta.textContent = 'Open Pack';
          cta.disabled = false;
          // restore click handler to open again
          wireCTA(); // reattach open handler
        } catch(e){
          showError(String(e.message || e));
          cta.textContent = 'Open Pack';
          cta.disabled = false;
          wireCTA();
        }
      };

    } catch(e){
      showError(String(e.message || e));
      cta.textContent = 'Open Pack';
      cta.disabled = false;
    }
  }, { once:true }); // ensure we don’t stack multiple open handlers
}

function showError(msg){
  errorEl.textContent = msg;
  errorEl.hidden = false;
  setTimeout(()=> errorEl.hidden = true, 4000);
}

function padToFive(results = []){
  if (results.length >= 5) return results.slice(0, 5);
  const out = results.slice();
  const need = 5 - out.length;

  // quick varied placeholders
  const weights = [
    { r:'legendary', w:1 }, { r:'epic', w:4 }, { r:'rare', w:10 }, { r:'common', w:85 }
  ];
  const pick = () => {
    const sum = weights.reduce((s,x)=>s+x.w,0);
    let t = Math.random()*sum;
    for (const x of weights){ if ((t -= x.w) <= 0) return x.r; }
    return 'common';
  };

  for (let i=0;i<need;i++){
    const rarity = pick();
    out.push({
      itemId: `placeholder-${i+1}`,
      name: rarity[0].toUpperCase()+rarity.slice(1),
      rarity,
      imageUrl: './assets/card-front.png',
      isDupe: false
    });
  }
  return out;
}
