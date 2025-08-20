// api.js
const BASE = import.meta.env.VITE_API_BASE || '';
export const listPacks = () => fetch(`${BASE}/api/packs`).then(r=>r.json());
// ...same pattern for the other calls
// Small helper: normalize rarity -> css class (common, rare, epic, legendary)
export function rarityClass(r) {
  return String(r || 'common').toLowerCase();
}

// Optional: simple fetch with consistent errors
async function jfetch(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!r.ok) {
    // Try to read a JSON error shape { error: "..."} first; fallback to status text
    let msg = `${options.method || 'GET'} ${path} ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export async function listPacks() {
  return jfetch('/api/packs');
}

export async function getInventory() {
  return jfetch('/api/inventory');
}

export async function openPack(packId, idempotencyKey) {
  return jfetch('/api/packs/open', {
    method: 'POST',
    body: JSON.stringify({ packId, idempotencyKey }),
  });
}

// Mockable endpoint for adding revealed items to collection.
// If your backend doesn't have it yet, you can keep this as a no-op that
// returns the current inventory to keep the UI happy.
export async function addToCollection(itemIds = []) {
  try {
    // If you later implement it in the backend, keep the same shape:
    // return jfetch('/api/collection/add', { method:'POST', body: JSON.stringify({ itemIds }) });
    // For now: no-op and just refetch inventory so balances stay fresh.
    const inv = await getInventory();
    return { ok: true, inventory: inv };
  } catch (e) {
    // Still avoid blowing up the UI during local testing.
    return { ok: false, error: String(e) };
  }
}
