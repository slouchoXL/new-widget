// ----- API base detection (unchanged) -----
let BASE = '';
if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
  BASE = window.__PACKS_API_BASE;
}
BASE = BASE.replace(/\/+$/, ''); // trim trailing slashes

async function jfetch(path, options = {}) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!r.ok) {
    let msg = `${options.method || 'GET'} ${url} ${r.status}`;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

const $  = (sel, root=document) => root.querySelector(sel);
const el = (tag, className) => { const n = document.createElement(tag); if (className) n.className = className; return n; };
function uuid4(){
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

// ----- state / refs -----
let packs = [];
let inv   = { balance:{ COIN: 0 }, items: [] };
let opening = null; // { results:[...] }

const balanceEl = $('#balance');
const priceEl   = $('#price');
const cta       = $('#cta');
const anchor    = $('.anchor');
const packImg   = $('.pack-img');
const trayEl    = $('#tray');
const overlay   = $('#overlay');
const overlayImg= $('#overlay-img');
const errorEl   = $('#error');

// ensure we have a #stack layer inside anchor
let stackEl = $('#stack');
if (!stackEl) {
  stackEl = el('div'); stackEl.id = 'stack'; stackEl.hidden = true;
  anchor.appendChild(stackEl);
}

// ----- helpers -----
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

// Always use your PNG, never API art
function cardFrontSrc(_item){
  return '/assets/card-front.png';
}

// ----- render meta -----
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

// ----- STACK render -----
function showStack(items){
  // hide pack while stack shows
  packImg.hidden = true;
  trayEl.hidden  = true;
  stackEl.hidden = false;
  stackEl.replaceChildren();

  // top-most card should be the last we append (so it sits on top visually)
  items.forEach((it, i) => {
    const btn = el('button', 'stack-card');
    const img = el('img', 'card-img');
    img.src = cardFrontSrc(it);
    img.alt = it.name || 'Card';
    btn.appendChild(img);
    btn.addEventListener('click', () => onRevealTop(btn));
    stackEl.appendChild(btn);
  });
}

function onRevealTop(btn){
  // Only remove if it's the top-most (last child)
  if (btn !== stackEl.lastElementChild) return;
  stackEl.removeChild(btn);

  // When no cards left, switch to tray
  if (!stackEl.children.length) {
    showTray(opening.results);
  }
}

// ----- TRAY render -----
function showTray(items){
  stackEl.hidden = true;
  trayEl.hidden  = false;
  trayEl.classList.remove('has-preview');
  trayEl.replaceChildren();

  items.forEach((it, idx) => {
    const pos = idx + 1; // 1..5 layout mapping with CSS
    const btn = el('button', 'tray-card');
    btn.setAttribute('data-pos', String(pos));
    const img = el('img');
    img.src = cardFrontSrc(it);
    img.alt = it.name || 'Card';
    btn.appendChild(img);

    btn.addEventListener('click', () => openOverlay(btn, img.src));
    trayEl.appendChild(btn);
  });
}

// ----- OVERLAY -----
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

// ----- flow -----
async function init(){
  try{
    const [p, i] = await Promise.all([ jfetch('/api/packs'), jfetch('/api/inventory') ]);
    packs = p.packs || [];
    inv   = i || inv;
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

    // phase: open → disable CTA and hide pack immediately
    cta.disabled = true;
    cta.textContent = 'Opening…';
    packImg.hidden = true;
    trayEl.hidden  = true;     // ensure hidden if previous run

    const res = await jfetch('/api/packs/open', {
      method: 'POST',
      body: JSON.stringify({ packId: pack.id, idempotencyKey: uuid4() })
    });

    opening = { ...res, results: padToFive(res.results || []) };

    // update balance in background (not blocking)
    try{ inv = (await jfetch('/api/inventory')) || inv; renderMeta(); }catch{}

    // show the stack in place of the pack
    showStack(opening.results);

    // switch CTA to “Click top card” while revealing
    cta.textContent = 'Click top card';
    cta.disabled = false;

    // once tray is visible, flip CTA to “Add to collection”
    const observer = new MutationObserver(() => {
      if (!stackEl.hidden && stackEl.children.length) return; // still revealing
      if (!trayEl.hidden) {
        cta.textContent = 'Add to collection';
        observer.disconnect();
      }
    });
    observer.observe(anchor, { childList:true, subtree:true, attributes:true });

    // wire collection once we reach tray
    cta.onclick = async ()=>{
      if (!trayEl.hidden && overlay.hidden){ // no preview open
        cta.disabled = true;
        cta.textContent = 'Adding…';
        try{
          // in your current mock, nothing to do server-side; just reset UI
          opening = null;
          stackEl.hidden = true;
          trayEl.hidden  = true;
          packImg.hidden = false;  // bring pack back
          cta.textContent = 'Open Pack';
          cta.disabled = false;
          cta.addEventListener('click', onOpenClick, { once:true });
        } catch(e){
          showError(String(e.message || e));
          cta.textContent = 'Open Pack';
          cta.disabled = false;
          cta.addEventListener('click', onOpenClick, { once:true });
        }
      }
    };

  } catch(e){
    showError(String(e.message || e));
    cta.textContent = 'Open Pack';
    cta.disabled = false;
    cta.addEventListener('click', onOpenClick, { once:true });
  }
}

init();
