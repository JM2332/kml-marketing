/* KML Foodservice - Marketing Tool
   "Find Restaurants" scans OpenStreetMap (via Overpass) for food/drink venues near a postcode,
   then looks up a contact email from each venue's website via a Cloud Function proxy (server-side
   fetch avoids CORS restrictions on arbitrary third-party sites). Results can be added to Contacts,
   which also accepts manual entries and CSV imports (e.g. from the canvassing-tool export). */

const firebaseConfig = {
  apiKey: "AIzaSyAN4kjjeFwrh4iXUfYEyLb7FIyHAiKLQm0",
  authDomain: "kml-marketing.firebaseapp.com",
  projectId: "kml-marketing",
  storageBucket: "kml-marketing.firebasestorage.app",
  messagingSenderId: "864057678129",
  appId: "1:864057678129:web:c524c3259b1858e2683810"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  console.warn('Offline persistence not enabled:', err.code);
});
const SHARED_LOGIN_EMAIL = 'jacob@kmlfoodservice.internal';

// Cloud Function endpoint for the email-scan proxy (region defaults to us-central1).
const SCAN_EMAIL_URL = 'https://us-central1-kml-marketing.cloudfunctions.net/scanEmail';

const CATEGORIES = {
  restaurant: { label: 'Restaurant', tags: [['amenity', 'restaurant']] },
  fast_food:  { label: 'Fast Food',  tags: [['amenity', 'fast_food']] },
  cafe:       { label: 'Cafe',       tags: [['amenity', 'cafe']] },
  bar_pub:    { label: 'Bar / Pub',  tags: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'nightclub']] },
  hotel:      { label: 'Hotel / B&B', tags: [['tourism', 'hotel'], ['tourism', 'guest_house'], ['tourism', 'motel']] },
};

let scanResults = []; // current "Find Restaurants" result set
let contacts = [];    // live Firestore-synced contacts
let contactsUnsub = null;

// ---------- utils ----------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function milesToMeters(mi) { return mi * 1609.34; }

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function rowsToCsv(rows) {
  return rows.map(r => r.map(cell => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`).join(',')).join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// ---------- geocoding + Overpass ----------

async function geocodePostcode(query) {
  const clean = query.trim().replace(/\s+/g, '');
  const res = await fetchWithTimeout(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`, {}, 15000);
  if (res.ok) {
    const data = await res.json();
    if (data.result) return { lat: data.result.latitude, lon: data.result.longitude, label: data.result.postcode };
  }
  const nomRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, {}, 15000);
  const nomData = await nomRes.json();
  if (nomData && nomData[0]) return { lat: parseFloat(nomData[0].lat), lon: parseFloat(nomData[0].lon), label: nomData[0].display_name };
  throw new Error('Could not find that postcode/place');
}

function bboxFromCenter(lat, lon, radiusMiles) {
  const radiusM = milesToMeters(radiusMiles);
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

function buildOverpassQuery(bbox, activeCategories) {
  const lines = [];
  for (const key of activeCategories) {
    for (const [k, v] of CATEGORIES[key].tags) {
      lines.push(`  node["${k}"="${v}"];`);
      lines.push(`  way["${k}"="${v}"];`);
    }
  }
  return `[out:json][timeout:90][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];\n(\n${lines.join('\n')}\n);\nout center tags;`;
}

function categoryFor(tags, activeCategories) {
  for (const key of activeCategories) {
    for (const [k, v] of CATEGORIES[key].tags) {
      if (tags[k] === v) return key;
    }
  }
  return null;
}

function normalizeWebsite(url) {
  if (!url) return '';
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function elementToResult(el, center, activeCategories) {
  const tags = el.tags || {};
  const category = categoryFor(tags, activeCategories);
  if (!category) return null;
  const lat = el.type === 'node' ? el.lat : (el.center && el.center.lat);
  const lon = el.type === 'node' ? el.lon : (el.center && el.center.lon);
  if (lat == null || lon == null) return null;
  const addrParts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:town'],
    tags['addr:postcode'],
  ].filter(Boolean);

  return {
    id: `${el.type}/${el.id}`,
    name: tags.name || tags.brand || 'Unnamed venue',
    category,
    lat, lon,
    address: addrParts.join(', '),
    phone: tags.phone || tags['contact:phone'] || '',
    website: normalizeWebsite(tags.website || tags['contact:website'] || ''),
    email: tags.email || tags['contact:email'] || '',
    emailSource: (tags.email || tags['contact:email']) ? 'osm' : '',
    distance: haversineMiles(center.lat, center.lon, lat, lon),
    addedToContacts: false,
  };
}

async function fetchVenues(center, radiusMiles, activeCategories) {
  const bbox = bboxFromCenter(center.lat, center.lon, radiusMiles);
  const query = buildOverpassQuery(bbox, activeCategories);
  // Called directly from the browser (not proxied) — Overpass's public API blocks
  // non-browser clients and, separately, browser requests from Firebase's *.web.app
  // hosting domain specifically. A real browser on a github.io origin is unaffected,
  // which is why this app is served from GitHub Pages rather than Firebase Hosting.
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter'];
  let lastErr;
  for (const url of endpoints) {
    try {
      setScanStatus(`Querying ${new URL(url).hostname}… (can take up to a minute)`);
      const res = await fetchWithTimeout(url, { method: 'POST', body: 'data=' + encodeURIComponent(query) }, 60000);
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
      const data = await res.json();
      const out = []; const seen = new Set();
      for (const el of data.elements || []) {
        const v = elementToResult(el, center, activeCategories);
        if (!v || v.distance > radiusMiles || seen.has(v.id)) continue;
        seen.add(v.id); out.push(v);
      }
      out.sort((a, b) => a.distance - b.distance);
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not reach Overpass API');
}

function setScanStatus(msg) { document.getElementById('scan-status').textContent = msg || ''; }

async function callFunction(url, body, timeoutMs) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const idToken = await user.getIdToken();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify(body),
  }, timeoutMs || 20000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- scan view ----------

document.getElementById('scan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('scan-load-btn');
  const activeCategories = Array.from(document.querySelectorAll('#category-checks input:checked')).map(c => c.value);
  if (!activeCategories.length) { setScanStatus('Pick at least one category.'); return; }
  btn.disabled = true;
  try {
    setScanStatus('Locating postcode…');
    const center = await geocodePostcode(document.getElementById('scan-postcode').value);
    const radius = parseFloat(document.getElementById('scan-radius').value) || 10;
    const venues = await fetchVenues(center, radius, activeCategories);
    scanResults = venues;
    setScanStatus(`Found ${venues.length} venue(s) near ${center.label}.`);
    renderResults();
  } catch (err) {
    setScanStatus('Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

function pillForResult(r) {
  if (!r.email) return '<span class="pill pill-none">Not found</span>';
  const label = { osm: 'OSM listing', mailto: 'Website', 'contact-page': 'Contact page', text: 'Website' }[r.emailSource] || 'Found';
  return `<span class="pill pill-${r.emailSource}">${label}</span>`;
}

function renderResults() {
  const panel = document.getElementById('results-panel');
  panel.style.display = scanResults.length ? 'block' : 'none';
  document.getElementById('results-count').textContent = `${scanResults.length} venue(s)`;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = scanResults.map((r, i) => `
    <tr data-idx="${i}">
      <td class="cell-name">${escapeHtml(r.name)}</td>
      <td>${CATEGORIES[r.category].label}</td>
      <td class="cell-addr">${escapeHtml(r.address)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${r.website ? `<a href="${escapeAttr(r.website)}" target="_blank" rel="noopener">site</a>` : ''}</td>
      <td>${r.email ? `<span class="email-found">${escapeHtml(r.email)}</span>` : '<span class="email-none">—</span>'} ${pillForResult(r)}</td>
      <td class="row-actions">
        ${r.addedToContacts ? '<span class="added-badge">Added ✓</span>' : `<button class="btn-outline row-btn add-one-btn" data-idx="${i}">Add</button>`}
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.add-one-btn').forEach(btn => {
    btn.onclick = () => addResultToContacts(parseInt(btn.dataset.idx, 10));
  });
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

document.getElementById('scan-emails-btn').onclick = async () => {
  const btn = document.getElementById('scan-emails-btn');
  const targets = scanResults.filter(r => !r.email && r.website);
  if (!targets.length) { setScanStatus('No listed websites without an email to check.'); return; }
  btn.disabled = true;
  let done = 0;
  for (const r of targets) {
    setScanStatus(`Checking websites for an email… (${done + 1}/${targets.length})`);
    try {
      const found = await scanEmailForWebsite(r.website);
      if (found) { r.email = found.email; r.emailSource = found.source; }
    } catch (e) {
      console.warn('scanEmail failed for', r.website, e.message);
    }
    done++;
    renderResults();
  }
  setScanStatus(`Done — checked ${targets.length} website(s).`);
  btn.disabled = false;
};

async function scanEmailForWebsite(url) {
  const data = await callFunction(SCAN_EMAIL_URL, { url }, 20000);
  return data.email ? data : null;
}

document.getElementById('add-all-btn').onclick = async () => {
  for (let i = 0; i < scanResults.length; i++) {
    if (!scanResults[i].addedToContacts) await addResultToContacts(i, true);
  }
  renderResults();
};

async function addResultToContacts(idx, skipRender) {
  const r = scanResults[idx];
  if (!r || r.addedToContacts) return;
  await db.collection('contacts').add({
    name: r.name,
    address: r.address,
    email: r.email || '',
    phone: r.phone || '',
    website: r.website || '',
    notes: '',
    source: 'scan',
    sourceId: r.id,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  r.addedToContacts = true;
  if (!skipRender) renderResults();
}

document.getElementById('export-results-csv').onclick = () => {
  const rows = [['Name', 'Category', 'Address', 'Phone', 'Website', 'Email', 'Email source', 'Distance (mi)']];
  scanResults.forEach(r => rows.push([r.name, CATEGORIES[r.category].label, r.address, r.phone, r.website, r.email, r.emailSource, r.distance.toFixed(2)]));
  downloadBlob(rowsToCsv(rows), 'restaurant-contacts.csv', 'text/csv');
};

// ---------- contacts view ----------

function subscribeContacts() {
  if (contactsUnsub) return;
  contactsUnsub = db.collection('contacts').orderBy('createdAt', 'desc').onSnapshot(snap => {
    contacts = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    renderContacts();
  }, err => console.error('contacts listener error', err));
}

function renderContacts() {
  const q = document.getElementById('contacts-search').value.trim().toLowerCase();
  const filtered = q
    ? contacts.filter(c => [c.name, c.address, c.email].some(f => (f || '').toLowerCase().includes(q)))
    : contacts;
  document.getElementById('contacts-count').textContent = `${filtered.length} of ${contacts.length} contact(s)`;
  document.getElementById('contacts-empty').style.display = contacts.length ? 'none' : 'block';
  const tbody = document.getElementById('contacts-tbody');
  tbody.innerHTML = filtered.map(c => `
    <tr data-id="${c.id}">
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td class="cell-addr">${escapeHtml(c.address)}</td>
      <td>${escapeHtml(c.email)}</td>
      <td>${escapeHtml(c.phone)}</td>
      <td><span class="pill source-${c.source || 'manual'}">${(c.source || 'manual')}</span></td>
      <td class="row-actions">
        <button class="btn-outline row-btn edit-contact-btn" data-id="${c.id}">Edit</button>
        <button class="btn-outline row-btn danger delete-contact-btn" data-id="${c.id}">Delete</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.edit-contact-btn').forEach(b => b.onclick = () => openContactForm(b.dataset.id));
  tbody.querySelectorAll('.delete-contact-btn').forEach(b => b.onclick = () => deleteContact(b.dataset.id));
}

document.getElementById('contacts-search').oninput = renderContacts;

function openContactForm(id) {
  const c = id ? contacts.find(x => x.id === id) : null;
  document.getElementById('contact-form-title').textContent = c ? 'Edit Contact' : 'Add Contact';
  document.getElementById('contact-id').value = id || '';
  document.getElementById('contact-name').value = c ? c.name : '';
  document.getElementById('contact-address').value = c ? c.address : '';
  document.getElementById('contact-email').value = c ? c.email : '';
  document.getElementById('contact-phone').value = c ? c.phone : '';
  document.getElementById('contact-website').value = c ? c.website : '';
  document.getElementById('contact-notes').value = c ? c.notes : '';
  document.getElementById('contact-overlay').classList.remove('hidden');
}

document.getElementById('add-contact-btn').onclick = () => openContactForm(null);
document.getElementById('contact-close').onclick = () => document.getElementById('contact-overlay').classList.add('hidden');

document.getElementById('contact-save').onclick = async () => {
  const id = document.getElementById('contact-id').value;
  const payload = {
    name: document.getElementById('contact-name').value.trim(),
    address: document.getElementById('contact-address').value.trim(),
    email: document.getElementById('contact-email').value.trim(),
    phone: document.getElementById('contact-phone').value.trim(),
    website: document.getElementById('contact-website').value.trim(),
    notes: document.getElementById('contact-notes').value.trim(),
  };
  if (!payload.name) return;
  if (id) {
    await db.collection('contacts').doc(id).update(payload);
  } else {
    payload.source = 'manual';
    payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('contacts').add(payload);
  }
  document.getElementById('contact-overlay').classList.add('hidden');
};

async function deleteContact(id) {
  if (!confirm('Delete this contact?')) return;
  await db.collection('contacts').doc(id).delete();
}

document.getElementById('export-contacts-csv').onclick = () => {
  const rows = [['Name', 'Address', 'Email', 'Phone', 'Website', 'Source', 'Notes']];
  contacts.forEach(c => rows.push([c.name, c.address, c.email, c.phone, c.website, c.source || 'manual', c.notes]));
  downloadBlob(rowsToCsv(rows), 'kml-contacts.csv', 'text/csv');
};

document.getElementById('import-csv-btn').onclick = () => document.getElementById('import-csv-input').click();
document.getElementById('import-csv-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) return;
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const nameIdx = idx('name'), addrIdx = idx('address'), phoneIdx = idx('phone'), webIdx = idx('website'), emailIdx = idx('email');
  let added = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = nameIdx >= 0 ? row[nameIdx] : '';
    if (!name) continue;
    await db.collection('contacts').add({
      name,
      address: addrIdx >= 0 ? row[addrIdx] : '',
      phone: phoneIdx >= 0 ? row[phoneIdx] : '',
      website: webIdx >= 0 ? row[webIdx] : '',
      email: emailIdx >= 0 ? row[emailIdx] : '',
      notes: '',
      source: 'canvassing',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    added++;
  }
  alert(`Imported ${added} contact(s).`);
  e.target.value = '';
};

// ---------- nav ----------

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.view).classList.add('active');
  };
});

// ---------- login ----------

const loginForm = document.getElementById('login-form');
const loginPasscode = document.getElementById('login-passcode');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  try {
    await auth.signInWithEmailAndPassword(SHARED_LOGIN_EMAIL, loginPasscode.value);
  } catch (err) {
    loginError.textContent = err.code === 'auth/network-request-failed'
      ? "Can't reach the server — check your connection."
      : 'Incorrect passcode.';
  }
});

document.getElementById('sign-out-top').onclick = () => {
  if (confirm('Sign out of this device?')) auth.signOut();
};

auth.onAuthStateChanged(user => {
  if (user) {
    document.getElementById('login-overlay').classList.add('hidden');
    subscribeContacts();
  } else {
    document.getElementById('login-overlay').classList.remove('hidden');
  }
});
