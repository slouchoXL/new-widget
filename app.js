// --- tiny helpers -------------------------------------------------------
const qs = new URLSearchParams(location.search);
const API = qs.get('api') || ''; // e.g. ?api=https://backend-xxxx.onrender.com

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => Object.assign(document.createElement(tag), cls ? {className:cls} : {});

function uuid4(){
  if (crypto?.randomUUID) return crypto.randomUUID();
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
}

async function jfetch(path, opts = {}){
  const r = await fetch(API + path, { headers:{'Content-Type':'application/json'}, ...opts });
  if (!r.ok){
    let msg = `${opts.method||'GET'} ${path} ${r.status}`;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

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
