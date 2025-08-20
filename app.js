// ====================== API BASE ======================
let BASE = '';
if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
  BASE = window.__PACKS_API_BASE;
}
BASE = (BASE || '').replace(/\/+$/, ''); // trim trailing slashes

// ====================== FETCH HELPERS =================
async function jfetch(path, options = {}) {
  const url = `${BASE}${path}`;
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
async function listPacks()           { return jfetch('/api/packs'); }
async function getInventory()        { return jfetch('/api/inventory'); }
async function openPack(packId, key) {
  return jfetch('/api/packs/open', {
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

function resolveImage(it){
  return it?.imageUrl || it?.artUrl || './assets/card-front.png';
}

// ====================== TINY DOM HELPERS ==============
const $  = (sel, root = document) => root.querySelector(sel);
const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

// ====================== STATE =========================
let packs = [];
let inv   = { balance:{ COIN: 0 }, items: [] };
let last  = null;               // { results: [...] }
let revealed = [];              // [indexes] revealed into tray
let phase    = 'idle';          // 'idle' | 'stack' | 'tray'
let preview  = null;            // { idx, item } when enlarged

// ====================== DOM REFS ======================
const balanceEl  = $('#balance');
const priceEl    = $('#price');
const cta        = $('#cta');

const packImg    = $('#packImg');  // <img id="packImg" ...>
const stackEl    = $('#stack');    // <div id="stack">
const trayEl     = $('#tray');     // <div id="tray">

const overlay    = $('#overlay');
const overlayImg = $('#overlay-img');
const errorEl    = $('#error');

// ====================== INIT ==========================
(async function init(){
  try{
    const [p, i] = await Promise.all([ listPacks(), getInventory() ]);
    packs = p.packs || [];
    inv   = i || inv;
    renderMeta();
    syncUI(); // show idle UI
  } catch(e){
    showError(String(e.message || e));
  }
})();

// ====================== RENDER: META ==================
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

// ====================== RENDER: STACK =================
// Creates a centered 5-card stack. Only the top card is clickable.
// Aspect ratio is controlled by CSS (see snippet below).
function renderStack(){
  stackEl.replaceChildren();
  if (!last || !last.results || !last.results.length) {
    stackEl.hidden = true;
    return;
  }

  stackEl.hidden = false;
  trayEl.hidden  = true;

  const items = last.results;
  // Render bottom → top so top card sits last
  for (let i = 0; i < items.length; i++){
    if (revealed.includes(i)) continue; // already gone to tray
    const it  = items[i];

    const card = el('div', 'stack-card'); // absolutely centered via CSS
    card.style.zIndex = String(100 + i);
    card.style.transform = `translate(-50%, -50%) translateY(${Math.min((items.length - i - 1) * 6, 24)}px)`;

    const img = el('img', 'card-img');
    img.src   = resolveImage(it);
    img.alt   = it.name || 'Card';
    card.appendChild(img);

    // Only the top-most unrevealed card is clickable
    const isTop = (i === nextUnrevealedIndex());
    card.style.pointerEvents = isTop ? 'auto' : 'none';
    if (isTop) {
      card.classList.add('is-top');
      card.addEventListener('click', onClickTopCard, { once:true });
    }

    stackEl.appendChild(card);
  }
}

function nextUnrevealedIndex(){
  const arr = last?.results || [];
  for (let i = 0; i < arr.length; i++){
    if (!revealed.includes(i)) return i;
  }
  return -1;
}

function onClickTopCard(){
  const idx = nextUnrevealedIndex();
  if (idx < 0) return;

  revealed.push(idx);

  // If all revealed, move to tray
  if (revealed.length === (last?.results?.length || 0)){
    phase = 'tray';
    renderTray();
    syncUI();
    return;
  }

  // Otherwise, re-render the remaining stack (top card disappears)
  renderStack();
}

// ====================== RENDER: TRAY ==================
// Shows the 5 revealed cards in a 3+2 layout, in the same anchor.
function renderTray(){
  stackEl.hidden = true;
  trayEl.hidden  = false;
  trayEl.replaceChildren();

  const ordered = revealed.map(i => last.results[i]);

  ordered.forEach((it, pos) => {
    const btn = el('button', 'tray-card');
    btn.dataset.pos = String(pos + 1); // 1..5 for CSS grid (3+2)
    const img = el('img');
    img.src = resolveImage(it);
    img.alt = it.name || 'Card';
    btn.appendChild(img);

    btn.addEventListener('click', () => {
      openOverlay(it);
      syncUI(); // disables CTA while enlarged
    });

    trayEl.appendChild(btn);
  });
}

// ====================== OVERLAY (ENLARGE) =============
function openOverlay(item){
  preview = { item };
  overlayImg.src = resolveImage(item);
  overlay.hidden = false;
}
function closeOverlay(){
  preview = null;
  overlay.hidden = true;
  syncUI();
}
overlay.addEventListener('click', closeOverlay);

// ====================== CTA FLOW ======================
function syncUI(){
  if (phase === 'idle') {
    cta.hidden = false;
    cta.disabled = false;
    cta.textContent = 'Open Pack';
    cta.onclick = onOpenPack;
    packImg.hidden = false;
    stackEl.hidden = true;
    trayEl.hidden  = true;
    return;
  }

  if (phase === 'stack') {
    cta.hidden = true;            // CTA disappears during stack
    cta.onclick = null;
    packImg.hidden = true;        // pack hidden while stack/tray are visible
    return;
  }

  if (phase === 'tray') {
    cta.hidden   = false;
    cta.textContent = 'Add to collection';
    cta.disabled = !!preview;     // disabled while an image is enlarged
    cta.onclick  = onAddToCollection;
    packImg.hidden = true;
    return;
  }
}

async function onOpenPack(){
  try{
    const pack = packs[0];
    if (!pack) return;

    // CTA disappears
    cta.hidden   = true;
    cta.disabled = true;

    // Request 1 opening
    const res  = await openPack(pack.id, uuid4());
    const five = padToFive(res.results || []);
    last = { ...res, results: five };

    // Hide pack, enter stack phase
    revealed = [];
    phase = 'stack';
    packImg.hidden = true;
    renderStack();
    syncUI();

    // Refresh balance (fire and forget)
    getInventory().then(i => { inv = i || inv; renderMeta(); }).catch(()=>{});

  } catch(e){
    showError(String(e.message || e));
    phase = 'idle';
    syncUI();
  }
}

function onAddToCollection(){
  // close any preview and reset loop
  closeOverlay();
  // (If you later add a real /collection endpoint, call it here.)
  last = null;
  revealed = [];
  phase = 'idle';
  // Show pack again
  packImg.hidden = false;
  stackEl.hidden = true;
  trayEl.hidden  = true;
  syncUI();
}

// ====================== UTIL: PAD TO 5 ================
function padToFive(results = []){
  if (results.length >= 5) return results.slice(0, 5);
  const out = results.slice();
  const need = 5 - out.length;

  const weights = [
    { r:'legendary', w: 1 },
    { r:'epic',      w: 4 },
    { r:'rare',      w:10 },
    { r:'common',    w:85 },
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

// ====================== ERRORS ========================
function showError(msg){
  errorEl.textContent = msg;
  errorEl.hidden = false;
  setTimeout(()=> errorEl.hidden = true, 4000);
}
