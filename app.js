// ===== Stable anon identity FIRST (so jfetch can safely read it) =====
const PLAYER_ID_KEY = 'packs:playerId';
let PLAYER_ID = localStorage.getItem(PLAYER_ID_KEY);
if (!PLAYER_ID) {
  PLAYER_ID = (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
  localStorage.setItem(PLAYER_ID_KEY, PLAYER_ID);
}

// ===== API base detection =====
let BASE = '';
if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
  BASE = window.__PACKS_API_BASE;
}
BASE = BASE.replace(/\/+$/, ''); // trim trailing slashes

async function jfetch(path, options = {}) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Player-Id': PLAYER_ID,
      ...(options.headers || {})
    },
    ...options,
  });
  if (!r.ok) {
    let msg = `${options.method || 'GET'} ${url} ${r.status}`;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ===== tiny DOM helpers =====
const $  = (sel, root=document) => root.querySelector(sel);
const el = (tag, className) => { const n = document.createElement(tag); if (className) n.className = className; return n; };
function uuid4(){
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

// ===== state / refs =====
let packs   = [];
let inv     = { balance:{ COIN: 999 }, items: [] };  // normalized shape
let opening = null; // { openingId, results:[...] }

const balanceEl = $('#balance');
const priceEl   = $('#price');
const cta       = $('#cta');
const anchor    = $('.anchor');
const packImg   = $('.pack-img');
const trayEl    = $('#tray');
const overlay   = $('#overlay');
const overlayImg= $('#overlay-img');
const errorEl   = $('#error');

// Ensure we have a #stack layer inside anchor
let stackEl = $('#stack');
if (!stackEl) {
  stackEl = el('div'); stackEl.id = 'stack'; stackEl.hidden = true;
  anchor.appendChild(stackEl);
}

// ===== helpers =====
function rarityClass(r){ return String(r || 'common').toLowerCase(); }
function prettyRarity(r){ r = rarityClass(r); return r.charAt(0).toUpperCase() + r.slice(1); }

function showError(msg){
  errorEl.textContent = msg;
  errorEl.hidden = false;
  setTimeout(()=> errorEl.hidden = true, 3000);
}

function padToFive(results = []){
  if (results.length >= 5) return results.slice(0, 5);
  const out = results.slice();
  const need = 5 - out.length;
  for (let i=0;i<need;i++){
    out.push({
      itemId: `placeholder-${i+1}`,
      name: 'Card',
      rarity: 'common',
      imageUrl: '/assets/card-front.png',
      isDupe: false
    });
  }
  return out;
}

// Always use your PNG, never API art (for this phase)
function cardFrontSrc(_item){
  return '/assets/card-front.png';
}

// Normalize any inventory response shape to {balance, items}
function normalizeInventory(x){
  // /api/collection/add returns { inventory: { balance, items } }
  if (x && x.inventory) return x.inventory;
  // /api/inventory currently returns { balance, items, inv }
  if (x && x.inv) return x.inv;
  return x || { balance:{COIN:0}, items:[] };
}

// ===== render meta =====
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

// ===== STACK render =====
function showStack(items){
  // hide pack while stack shows
  packImg.hidden = true;
  trayEl.hidden  = true;
  stackEl.hidden = false;
  stackEl.replaceChildren();

  // append in order; the last appended sits on top visually
  items.forEach((it) => {
    const btn = el('button', 'stack-card');
    const img = el('img', 'card-img');
    img.src = cardFrontSrc(it);
    img.alt = it.name || 'Card';

    const tag = el('div', `tag ${rarityClass(it.rarity)}`);
    tag.textContent = prettyRarity(it.rarity);

    btn.appendChild(img);
    btn.appendChild(tag);
    btn.addEventListener('click', () => onRevealTop(btn));

    stackEl.appendChild(btn);
  });
}

function onRevealTop(btn){
  // Only the top-most card (last child) can be revealed
  if (btn !== stackEl.lastElementChild) return;

  stackEl.removeChild(btn);

  if (!stackEl.children.length) {
    showTray(opening.results);
  }
}

// ===== TRAY render =====
function showTray(items){
  stackEl.hidden = true;
  trayEl.hidden  = false;
  trayEl.classList.remove('has-preview');
  trayEl.replaceChildren();

  items.forEach((it, idx) => {
    const pos = idx + 1;
    const btn = el('button', 'tray-card');
    btn.setAttribute('data-pos', String(pos));

    const img = el('img');
    img.src = cardFrontSrc(it);
    img.alt = it.name || 'Card';

    btn.appendChild(img);
    btn.addEventListener('click', () => openOverlay(btn, img.src));
    trayEl.appendChild(btn);
  });

  // bring back CTA as "Add to collection"
  cta.textContent = 'Add to collection';
  cta.hidden = false;
  cta.disabled = false;
  cta.onclick = onCollectClick;
}

async function onCollectClick(){
  if (!overlay.hidden) return;   // ignore while preview is open
  cta.disabled = true;
  cta.textContent = 'Adding…';
  try{
    // Send the 5 item ids we just revealed
    const itemIds = (opening?.results || []).map(it => it.itemId);
    const res = await jfetch('/api/collection/add', {
      method: 'POST',
      body: JSON.stringify({ itemIds }),
    });

    // Normalize + update local balances/items
    if (res) {
      inv = normalizeInventory(res);
      renderMeta();
    }

    // reset UI back to idle
    opening = null;
    stackEl.hidden = true;
    trayEl.hidden  = true;
    packImg.hidden = false;

    cta.textContent = 'Open Pack';
    cta.disabled = false;
    cta.onclick = null;
    cta.addEventListener('click', onOpenClick, { once:true });
  } catch(e){
    showError(String(e.message || e));
    cta.textContent = 'Open Pack';
    cta.disabled = false;
    cta.onclick = null;
    cta.addEventListener('click', onOpenClick, { once:true });
  }
}

// ===== OVERLAY =====
function openOverlay(cardBtn, src){
  overlayImg.src = src;
  overlay.hidden = false;
  trayEl.classList.add('has-preview');
  cardBtn.classList.add('is-active');
}
function closeOverlay(){
  overlay.hidden = true;
  trayEl.classList.remove('has-preview');
  const active = trayEl.querySelector('.tray-card.is-active');
  if (active) active.classList.remove('is-active');
}
overlay.addEventListener('click', closeOverlay);

// ===== flow =====
async function init(){
  try{
    const [p, i] = await Promise.all([
      jfetch('/api/packs'),
      jfetch('/api/inventory')
    ]);

    packs = p.packs || [];
    inv   = normalizeInventory(i);
    renderMeta();

    cta.addEventListener('click', onOpenClick, { once:true });
  } catch(e){
    showError(String(e.message || e));
  }
}

async function onOpenClick(){
  try{
    const pack = packs[0];
    if (!pack) return;

    // Hide CTA while revealing
    cta.hidden = true;
    cta.disabled = true;

    // Hide pack + tray before showing stack
    packImg.hidden = true;
    trayEl.hidden  = true;

    const res = await jfetch('/api/packs/open', {
      method: 'POST',
      body: JSON.stringify({ packId: pack.id, idempotencyKey: uuid4() })
    });

    // keep openingId if you want later; pad to 5 to be safe
    opening = { ...res, results: padToFive(res.results || []) };

    // refresh visible balance (server may have charged pack + dupe credit)
    try {
      const fresh = await jfetch('/api/inventory');
      inv = normalizeInventory(fresh);
      renderMeta();
    } catch {}

    // show stack; CTA stays hidden until we show tray
    showStack(opening.results);

  } catch(e){
    showError(String(e.message || e));
    cta.hidden = false;
    cta.disabled = false;
    cta.textContent = 'Open Pack';
    cta.addEventListener('click', onOpenClick, { once:true });
  }
}

init();
