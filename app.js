// --- API BASE -----------------------------------------------------------
let BASE = '';
if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
  BASE = window.__PACKS_API_BASE;
}
BASE = BASE.replace(/\/+$/, ''); // trim trailing slashes

// --- tiny helpers -------------------------------------------------------
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const el = (tag, className) => { const n=document.createElement(tag); if(className) n.className=className; return n; };

function uuid4(){
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

// Map server item → image URL we can actually load
function resolveImage(it){
  const src = it.imageUrl || it.artUrl || './assets/card-front.png';
  // If your backend returns dev paths like /mock/art/..., fall back to local asset
  if (/^\/?mock\//i.test(src) || src.includes('/mock/')) return './assets/card-front.png';
  // If it's relative, leave it; if absolute http(s), also fine.
  return src;
}

// Pad to 5 if backend returns < 5
function padToFive(results = []){
  if (results.length >= 5) return results.slice(0,5);
  const out = results.slice();
  const need = 5 - out.length;
  const weights = [
    { r:'legendary', w:1 }, { r:'epic', w:4 }, { r:'rare', w:10 }, { r:'common', w:85 }
  ];
  const pick = () => {
    const sum = weights.reduce((s,x)=>s+x.w,0);
    let t = Math.random() * sum;
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

// --- API ---------------------------------------------------------------
async function jfetch(path, options = {}){
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    headers: { 'Content-Type':'application/json', ...(options.headers||{}) },
    ...options
  });
  if (!r.ok){
    let msg = `${options.method||'GET'} ${url} ${r.status}`;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function listPacks(){ return jfetch('/api/packs'); }
async function getInventory(){ return jfetch('/api/inventory'); }
async function openPack(packId, key){
  return jfetch('/api/packs/open', {
    method:'POST',
    body: JSON.stringify({ packId, idempotencyKey: key })
  });
}

// --- state --------------------------------------------------------------
let packs = [];
let inv   = { balance:{ COIN: 0 }, items: [] };
let last  = null;              // { results:[...] }
let phase = 'idle';            // 'idle'|'tearing'|'spilling'|'stack'|'tray'
let revealed = [];             // indexes revealed (0..4)
let preview  = null;           // { idx, item } or null

// --- dom refs -----------------------------------------------------------
const balanceEl = $('#balance');
const priceEl   = $('#price');
const cta       = $('#cta');

const anchor    = $('.anchor');
const packImg   = $('#packImg');
const stackEl   = $('#stack');
const trayEl    = $('#tray');

const overlay   = $('#overlay');
const overlayImg= $('#overlay-img');

const errorEl   = $('#error');

// --- init ---------------------------------------------------------------
(async function init(){
  try{
    const [p, i] = await Promise.all([ listPacks(), getInventory() ]);
    packs = p.packs || [];
    inv   = i || inv;
    renderMeta();
    wireCTA();
  } catch(e){
    showError(String(e.message || e));
  }
})();

// --- render: meta -------------------------------------------------------
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

// --- render: stack ------------------------------------------------------
function renderStack(){
  stackEl.replaceChildren();
  stackEl.hidden = false;
  trayEl.hidden  = true;
  packImg.hidden = true; // pack disappears while stack/tray is up

  const items = last?.results || [];
  // find first unrevealed
  let topIndex = -1;
  for (let i=0;i<items.length;i++){ if (!revealed.includes(i)) { topIndex = i; break; } }

  items.forEach((it, i) => {
    if (revealed.includes(i)) return; // gone from stack
    const card = el('div', 'card');
    card.style.zIndex = 100 + (i === topIndex ? 10 : 0);
    card.style.transform = `translate3d(0, ${Math.min(((items.length - i - 1) * 3), 18)}px, 0)`;

    const img = el('img');
    img.src = resolveImage(it);
    img.alt = it.name || 'Card';
    card.appendChild(img);

    if (i === topIndex){
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        // reveal this one
        revealed = revealed.concat(i);
        // if all revealed, go to tray; else re-render stack
        if (revealed.length === items.length){
          phase = 'tray';
          renderTrayFromRevealed();
        } else {
          renderStack();
        }
      });
    } else {
      card.style.pointerEvents = 'none';
    }

    stackEl.appendChild(card);
  });
}

// --- render: tray (3+2 layout) -----------------------------------------
function renderTrayFromRevealed(){
  stackEl.hidden = true;
  trayEl.hidden  = false;
  trayEl.replaceChildren();

  const grid = el('div', 'tray-grid');
  // revealed contains original indexes in reveal order; map to items
  const items = revealed.map(idx => ({ idx, it: last.results[idx] }));

  items.forEach((entry, pos) => {
    const { idx, it } = entry;
    const btn = el('button', 'card');
    btn.dataset.pos = String(pos + 1); // 1..5 for layout
    const img = el('img');
    img.src = resolveImage(it);
    img.alt = it.name || 'Card';
    btn.appendChild(img);

    btn.addEventListener('click', () => openPreview(idx, it, btn));

    grid.appendChild(btn);
  });

  trayEl.appendChild(grid);
}

// --- preview overlay (in-stage) ----------------------------------------
function openPreview(idx, it, btn){
  preview = { idx, item: it };
  // dim inactive cards
  trayEl.classList.add('has-preview');
  $$('.tray .card').forEach(c => c.classList.remove('is-active'));
  btn.classList.add('is-active');

  overlayImg.src = resolveImage(it);
  overlay.hidden = false;
}
function closePreview(){
  preview = null;
  overlay.hidden = true;
  trayEl.classList.remove('has-preview');
}
overlay.addEventListener('click', closePreview);

// --- CTA flow -----------------------------------------------------------
function wireCTA(){
  // Start = Open Pack
  cta.textContent = 'Open Pack';
  cta.disabled = false;
  cta.onclick = async () => {
    try{
      const pack = packs[0];
      if (!pack) return;
      cta.disabled = true;
      cta.textContent = 'Opening…';

      // Begin phases
      phase    = 'tearing';
      revealed = [];
      preview  = null;

      const res  = await openPack(pack.id, uuid4());
      const five = padToFive(res.results || []);
      last = { ...res, results: five };

      // lightweight animation phases
      setTimeout(()=> { phase = 'spilling'; }, 250);
      setTimeout(()=> {
        phase = 'stack';
        renderStack();           // show the stack
        cta.disabled = false;
        cta.textContent = 'Click top card';
      }, 500);

      // refresh balance in background
      getInventory().then(i => { inv = i || inv; renderMeta(); }).catch(()=>{});

      // Switch CTA handler to collect once we reach tray
      cta.onclick = async () => {
        if (phase !== 'tray' || preview) return; // don’t collect while preview open
        cta.disabled = true;
        cta.textContent = 'Adding…';
        try{
          await getInventory().then(i => { inv = i || inv; renderMeta(); });
          // reset loop
          setTimeout(()=>{
            last = null; revealed = []; preview = null; phase = 'idle';
            trayEl.hidden = true; stackEl.hidden = true; packImg.hidden = false;
            cta.textContent = 'Open Pack';
            cta.disabled = false;
            wireCTA();
          }, 350);
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
      wireCTA();
    }
  };
}

// --- errors -------------------------------------------------------------
function showError(msg){
  errorEl.textContent = msg;
  errorEl.hidden = false;
  setTimeout(()=> errorEl.hidden = true, 4000);
}
