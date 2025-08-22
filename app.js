// ===== API base detection =====
let BASE = '';
if (typeof window !== 'undefined' && window.__PACKS_API_BASE) {
  BASE = window.__PACKS_API_BASE;
}
BASE = BASE.replace(/\/+$/, ''); // trim trailing slashes

// ===== Supabase client (REUSE the one created in index.html) ===========
const supa = window.supa || null; // do NOT create another client here

// ===== player id (anon fallback preserved for testing) =================
const PLAYER_ID_KEY = 'packs:playerId';
function makeUuid(){
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

let PLAYER_ID = localStorage.getItem(PLAYER_ID_KEY);
if (!PLAYER_ID) {
  PLAYER_ID = makeUuid();
  localStorage.setItem(PLAYER_ID_KEY, PLAYER_ID);
}

// If signed in, prefer a stable namespaced supabase id
async function maybeUpgradePlayerIdToUser(){
  if (!supa) return;
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session?.user?.id) {
      const uid = 'u_' + session.user.id;
      if (PLAYER_ID !== uid) {
        PLAYER_ID = uid;
        localStorage.setItem(PLAYER_ID_KEY, uid);
      }
    }
  } catch {}
}
await maybeUpgradePlayerIdToUser();

// ---- Auth header helper (Supabase if signed-in, else X-Player-Id) ----
async function getAuthHeader() {
  try {
    if (supa?.auth) {
      const { data: { session } } = await supa.auth.getSession();
      if (session?.access_token) {
        return { Authorization: `Bearer ${session.access_token}` };
      }
    }
  } catch {}
  return { 'X-Player-Id': PLAYER_ID };
}

// Core fetch with correct headers
async function jfetch(path, options = {}) {
  const url = `${BASE}${path}`;
  const authHeader = await getAuthHeader();
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...authHeader,
    ...(options.headers || {})
  };
  const r = await fetch(url, { headers, ...options });
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
function uuid4(){ return makeUuid(); }

// ===== state / refs =====
let packs   = [];
let inv     = { balance:{ COIN: 999 }, items: [] };
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

// Normalize any inventory response to {balance, items}
function normalizeInventory(x){
  if (x && x.inventory) return x.inventory; // /collection/add
  if (x && (x.balance || x.items)) return x; // /inventory
  return { balance:{COIN:0}, items:[] };
}

// ===== render meta =====
function renderMeta(){
  const pack = packs[0];
  balanceEl.textContent = `Balance: ${inv?.balance?.COIN ?? 0}`;
  priceEl.textContent   = pack ? `Price: ${pack.price.amount} ${pack.price.currency}` : 'Price: —';
}

// ===== STACK render =====
function showStack(items){
  packImg.hidden = true;
  trayEl.hidden  = true;
  stackEl.hidden = false;
  stackEl.replaceChildren();

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

  cta.textContent = 'Add to collection';
  cta.hidden = false;
  cta.disabled = false;
  cta.onclick = onCollectClick;
}

async function onCollectClick(){
  if (!overlay.hidden) return;
  cta.disabled = true;
  cta.textContent = 'Adding…';
  try{
    const itemIds = (opening?.results || []).map(it => it.itemId);
    const res = await jfetch('/api/collection/add', {
      method: 'POST',
      body: JSON.stringify({ itemIds }),
    });

    if (res) {
      inv = normalizeInventory(res);
      renderMeta();
    }

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

// ===== init / flow =====

// (Optional) require sign-in to open packs:
// async function requireSignedInOrPrompt() {
//   if (!supa) return false;
//   const { data: { session } } = await supa.auth.getSession();
//   if (session?.user) return true;
//   cta.textContent = 'Sign in to open packs';
//   cta.hidden = false;
//   cta.disabled = false;
//   cta.onclick = async () => {
//     const email = prompt('Enter your email to sign in');
//     if (!email) return;
//     const { error } = await supa.auth.signInWithOtp({ email, options:{ emailRedirectTo: `${location.origin}${location.pathname}` } });
//     if (error) return showError(error.message || 'Sign-in failed');
//     alert('Check your email for the magic link, then return here.');
//   };
//   return false;
// }

// Live-reload balance/meta on auth changes without creating loops
if (supa?.auth) {
  supa.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      await maybeUpgradePlayerIdToUser();
      try {
        const fresh = await jfetch('/api/inventory');
        inv = normalizeInventory(fresh);
        renderMeta();
      } catch {}
    } else if (event === 'SIGNED_OUT') {
      let anon = localStorage.getItem(PLAYER_ID_KEY);
      if (!anon) {
        anon = makeUuid();
        localStorage.setItem(PLAYER_ID_KEY, anon);
      }
      PLAYER_ID = anon;
      try {
        const fresh = await jfetch('/api/inventory');
        inv = normalizeInventory(fresh);
        renderMeta();
      } catch {}
    }
  });
}

async function init(){
  try{
    const packsResp = await jfetch('/api/packs'); // public
    packs = packsResp.packs || [];

    // If you want to *require* sign-in, uncomment:
    // const ok = await requireSignedInOrPrompt();
    // if (!ok) return;

    const invResp = await jfetch('/api/inventory'); // works signed or anon (header differs)
    inv   = normalizeInventory(invResp);
    renderMeta();

    cta.textContent = 'Open Pack';
    cta.hidden = false;
    cta.disabled = false;
    cta.addEventListener('click', onOpenClick, { once:true });
  } catch(e){
    showError(String(e.message || e));
  }
}

async function onOpenClick(){
  try{
    const pack = packs[0];
    if (!pack) return;

    cta.hidden = true;
    cta.disabled = true;

    packImg.hidden = true;
    trayEl.hidden  = true;

    const res = await jfetch('/api/packs/open', {
      method: 'POST',
      body: JSON.stringify({ packId: pack.id, idempotencyKey: uuid4() })
    });

    opening = { ...res, results: padToFive(res.results || []) };

    try {
      const fresh = await jfetch('/api/inventory');
      inv = normalizeInventory(fresh);
      renderMeta();
    } catch {}

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
