'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'relay-state.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const BOOTSTRAP_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const JSON_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_WAKE_THROTTLE_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizeP8(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > JSON_LIMIT_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function defaultState() {
  return {
    createdAt: nowIso(),
    updatedAt: nowIso(),
    admin: {
      username: ADMIN_USER,
      passwordHash: sha256(BOOTSTRAP_ADMIN_PASSWORD),
    },
    apns: {
      teamId: '',
      keyId: '',
      bundleId: 'DNAngelX.IoBrokerApp',
      environment: 'sandbox',
      privateKey: '',
    },
    instances: {},
    devices: {},
    pushLogs: [],
  };
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = defaultState();
    saveState(initial);
    return initial;
  }
  const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state.admin ||= defaultState().admin;
  state.apns ||= defaultState().apns;
  state.instances ||= {};
  state.devices ||= {};
  state.pushLogs ||= [];
  return state;
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updatedAt = nowIso();
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

let state = loadState();

function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="ioBroker iOS Relay"' });
    res.end('Authentication required');
    return false;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  if (username !== state.admin.username || !timingSafeEqual(sha256(password), state.admin.passwordHash)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="ioBroker iOS Relay"' });
    res.end('Invalid credentials');
    return false;
  }
  return true;
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function authenticateInstance(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  return Object.values(state.instances).find(instance => instance.enabled !== false && instance.apiKeyHash === tokenHash) || null;
}

function signApnsJwt() {
  const { teamId, keyId, privateKey } = state.apns;
  if (!teamId || !keyId || !privateKey) {
    throw Object.assign(new Error('APNs credentials incomplete'), { statusCode: 400 });
  }
  const header = { alg: 'ES256', kid: keyId };
  const claims = { iss: teamId, iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), normalizeP8(privateKey)).toString('base64url');
  return `${signingInput}.${signature}`;
}

function apnsHost() {
  return state.apns.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
}

function sendApns(device, reason, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const token = signApnsJwt();
    const host = apnsHost();
    const isAlertPush = options.pushType === 'alert' || Boolean(payload.aps && (payload.aps.alert || payload.aps.sound || payload.aps.badge));
    const body = JSON.stringify(isAlertPush
      ? {
          ...payload,
          reason: reason || 'notification',
        }
      : {
          aps: { 'content-available': 1 },
          command: 'command_update_sensors',
          reason: reason || 'stale',
          ...payload,
        });

    const client = http2.connect(`https://${host}`);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.apnsToken}`,
      authorization: `bearer ${token}`,
      'apns-topic': state.apns.bundleId,
      'apns-push-type': isAlertPush ? 'alert' : 'background',
      'apns-priority': isAlertPush ? '10' : '5',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });

    let responseBody = '';
    let statusCode = 0;
    let apnsId = '';

    request.setEncoding('utf8');
    request.on('response', headers => {
      statusCode = Number(headers[':status'] || 0);
      apnsId = headers['apns-id'] || '';
    });
    request.on('data', chunk => {
      responseBody += chunk;
    });
    request.on('end', () => {
      client.close();
      const result = {
        success: statusCode >= 200 && statusCode < 300,
        statusCode,
        apnsId,
        response: responseBody ? safeJson(responseBody) : null,
      };
      if (result.success) resolve(result);
      else reject(Object.assign(new Error(`APNs rejected push with ${statusCode}`), { statusCode: 502, result }));
    });
    request.on('error', error => {
      client.close();
      reject(error);
    });
    client.on('error', reject);
    request.end(body);
  });
}

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return value; }
}

function deviceKey(instanceId, appDeviceId) {
  return `${instanceId}:${appDeviceId}`;
}

function addPushLog(entry) {
  state.pushLogs.unshift({ id: crypto.randomUUID(), createdAt: nowIso(), ...entry });
  state.pushLogs = state.pushLogs.slice(0, 250);
}

function publicState() {
  return {
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    apns: {
      teamId: state.apns.teamId,
      keyId: state.apns.keyId,
      bundleId: state.apns.bundleId,
      environment: state.apns.environment,
      privateKeyConfigured: Boolean(state.apns.privateKey),
    },
    instances: Object.values(state.instances).map(instance => ({
      id: instance.id,
      name: instance.name,
      enabled: instance.enabled !== false,
      createdAt: instance.createdAt,
      lastSeenAt: instance.lastSeenAt,
      deviceCount: Object.values(state.devices).filter(device => device.instanceId === instance.id).length,
    })),
    devices: Object.values(state.devices).map(device => ({
      id: device.id,
      instanceId: device.instanceId,
      person: device.person,
      device: device.device,
      appDeviceId: device.appDeviceId,
      environment: device.environment,
      lastSeenAt: device.lastSeenAt,
      lastRegisteredAt: device.lastRegisteredAt,
      lastWakeAt: device.lastWakeAt,
      wakeCount: device.wakeCount || 0,
      tokenSuffix: device.apnsToken ? device.apnsToken.slice(-8) : '',
    })),
    pushLogs: state.pushLogs.slice(0, 100),
  };
}

function adminHtml() {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ioBroker iOS Push Relay</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172033; background: #f5f7fb; }
    main { max-width: 1080px; margin: 0 auto; }
    section { background: white; border: 1px solid #dfe5ef; border-radius: 16px; padding: 20px; margin: 18px 0; box-shadow: 0 8px 30px rgba(20, 35, 60, .06); }
    label { display: block; font-weight: 600; margin-top: 12px; }
    input, select, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9d3e2; border-radius: 10px; font: inherit; margin-top: 4px; }
    textarea { min-height: 160px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; background: #1c63ff; color: white; cursor: pointer; margin-top: 14px; }
    button.secondary { background: #e8eefb; color: #172033; }
    code { background: #eef3fb; padding: 2px 6px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; border-bottom: 1px solid #edf1f7; padding: 8px; font-size: 14px; vertical-align: top; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .muted { color: #68758a; }
    .ok { color: #0d8f4f; font-weight: 700; }
    .warn { color: #b26800; font-weight: 700; }
    .error { color: #b00020; font-weight: 700; }
  </style>
</head>
<body>
<main>
  <h1>ioBroker iOS Push Relay</h1>
  <p class="muted">Mandantenfähiges APNs Silent-Push-Relay. Admin-Credentials liegen nur auf diesem Server.</p>

  <section>
    <h2>APNs Credentials</h2>
    <form id="apnsForm">
      <div class="grid">
        <label>Team ID<input name="teamId" /></label>
        <label>Key ID<input name="keyId" /></label>
        <label>Bundle ID<input name="bundleId" /></label>
        <label>Environment<select name="environment"><option value="sandbox">Sandbox</option><option value="production">Production</option></select></label>
      </div>
      <label>.p8 Private Key<textarea name="privateKey" placeholder="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"></textarea></label>
      <button>Speichern</button>
      <button type="button" class="secondary" id="reloadButton">Neu laden</button>
    </form>
    <p id="apnsStatus" class="muted"></p>
  </section>

  <section>
    <h2>Adapter-Instanz registrieren</h2>
    <form id="instanceForm">
      <label>Name<input name="name" value="iobroker-dev" /></label>
      <button>API-Key erzeugen</button>
    </form>
    <p class="muted">Den API-Key zeigt der Server nur einmal an. Danach in die ioBroker-Adapter-Konfiguration kopieren.</p>
    <pre id="newInstance"></pre>
  </section>

  <section><h2>Instanzen</h2><div id="instances"></div></section>
  <section><h2>Devices</h2><div id="devices"></div></section>
  <section><h2>Push Logs</h2><div id="logs"></div></section>
</main>
<script>
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function table(rows, columns) {
  if (!rows.length) return '<p class="muted">Keine Daten.</p>';
  return '<table><thead><tr>' + columns.map(c => '<th>' + escapeHtml(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + columns.map(c => '<td>' + escapeHtml(row[c.key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
async function load() {
  const state = await api('/admin/api/state');
  document.querySelector('[name=teamId]').value = state.apns.teamId || '';
  document.querySelector('[name=keyId]').value = state.apns.keyId || '';
  document.querySelector('[name=bundleId]').value = state.apns.bundleId || 'DNAngelX.IoBrokerApp';
  document.querySelector('[name=environment]').value = state.apns.environment || 'sandbox';
  document.querySelector('[name=privateKey]').placeholder = state.apns.privateKeyConfigured ? 'Private Key ist gespeichert. Leer lassen, um ihn unverändert zu lassen.' : '-----BEGIN PRIVATE KEY-----\\n...';
  document.getElementById('apnsStatus').innerHTML = state.apns.privateKeyConfigured ? '<span class="ok">Private Key konfiguriert</span>' : '<span class="warn">Private Key fehlt</span>';
  document.getElementById('instances').innerHTML = table(state.instances, [
    { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'enabled', label: 'Aktiv' }, { key: 'lastSeenAt', label: 'Last Seen' }, { key: 'deviceCount', label: 'Devices' }
  ]);
  document.getElementById('devices').innerHTML = table(state.devices, [
    { key: 'id', label: 'ID' }, { key: 'instanceId', label: 'Instanz' }, { key: 'person', label: 'Person' }, { key: 'device', label: 'Device' }, { key: 'lastSeenAt', label: 'Last Seen' }, { key: 'lastWakeAt', label: 'Last Wake' }, { key: 'wakeCount', label: 'Wakes' }, { key: 'tokenSuffix', label: 'Token' }
  ]);
  document.getElementById('logs').innerHTML = table(state.pushLogs, [
    { key: 'createdAt', label: 'Zeit' }, { key: 'deviceId', label: 'Device' }, { key: 'reason', label: 'Reason' }, { key: 'status', label: 'Status' }, { key: 'statusCode', label: 'APNs' }, { key: 'error', label: 'Fehler' }
  ]);
}
document.getElementById('apnsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  if (!payload.privateKey) delete payload.privateKey;
  await api('/admin/api/apns', { method: 'POST', body: JSON.stringify(payload) });
  document.querySelector('[name=privateKey]').value = '';
  await load();
});
document.getElementById('instanceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const created = await api('/admin/api/instances', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
  document.getElementById('newInstance').textContent = JSON.stringify(created, null, 2);
  await load();
});
document.getElementById('reloadButton').addEventListener('click', load);
load().catch(error => alert(error.message));
</script>
</body>
</html>`;
}

async function handleAdmin(req, res, url) {
  if (!requireAdmin(req, res)) return;
  if (req.method === 'GET' && url.pathname === '/admin') {
    sendHtml(res, adminHtml());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/state') {
    sendJson(res, 200, publicState());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/apns') {
    const body = await readJsonBody(req);
    state.apns.teamId = String(body.teamId || '').trim();
    state.apns.keyId = String(body.keyId || '').trim();
    state.apns.bundleId = String(body.bundleId || '').trim();
    state.apns.environment = body.environment === 'production' ? 'production' : 'sandbox';
    if (body.privateKey) state.apns.privateKey = normalizeP8(body.privateKey);
    saveState(state);
    sendJson(res, 200, { success: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/instances') {
    const body = await readJsonBody(req);
    const id = crypto.randomUUID();
    const apiKey = `iosr_${randomToken(32)}`;
    state.instances[id] = {
      id,
      name: String(body.name || id).trim(),
      apiKeyHash: sha256(apiKey),
      enabled: true,
      createdAt: nowIso(),
      lastSeenAt: null,
    };
    saveState(state);
    sendJson(res, 201, { id, apiKey });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, time: nowIso(), apnsConfigured: Boolean(state.apns.teamId && state.apns.keyId && state.apns.privateKey && state.apns.bundleId) });
    return;
  }

  const instance = authenticateInstance(req);
  if (!instance) {
    sendJson(res, 401, { error: 'Invalid or missing relay API key' });
    return;
  }
  instance.lastSeenAt = nowIso();

  if (req.method === 'GET' && url.pathname === '/api/v1/devices') {
    saveState(state);
    sendJson(res, 200, { devices: Object.values(state.devices).filter(device => device.instanceId === instance.id) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/devices/register') {
    const body = await readJsonBody(req);
    const appDeviceId = String(body.appDeviceId || body.clientId || '').trim();
    const apnsToken = String(body.apnsToken || body.deviceToken || '').trim();
    if (!appDeviceId || !apnsToken) {
      sendJson(res, 400, { error: 'appDeviceId and apnsToken are required' });
      return;
    }
    const key = deviceKey(instance.id, appDeviceId);
    const existing = state.devices[key] || {};
    const device = {
      id: key,
      instanceId: instance.id,
      person: String(body.person || existing.person || '').trim(),
      device: String(body.device || existing.device || '').trim(),
      appDeviceId,
      apnsToken,
      environment: body.environment === 'production' ? 'production' : state.apns.environment,
      lastSeenAt: body.lastSeenAt || existing.lastSeenAt || null,
      lastRegisteredAt: nowIso(),
      lastWakeAt: existing.lastWakeAt || null,
      wakeCount: existing.wakeCount || 0,
    };
    state.devices[key] = device;
    saveState(state);
    sendJson(res, 200, { success: true, device: { ...device, apnsToken: undefined } });
    return;
  }

  const wakeMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/wake$/);
  if (req.method === 'POST' && wakeMatch) {
    const body = await readJsonBody(req);
    const appDeviceId = decodeURIComponent(wakeMatch[1]);
    const key = deviceKey(instance.id, appDeviceId);
    const device = state.devices[key];
    if (!device) {
      sendJson(res, 404, { error: 'Device not registered for this instance' });
      return;
    }
    const throttleMs = body.minIntervalMs === undefined ? DEFAULT_WAKE_THROTTLE_MS : Number(body.minIntervalMs);
    if (device.lastWakeAt && Date.now() - Date.parse(device.lastWakeAt) < throttleMs) {
      sendJson(res, 202, { success: false, skipped: true, reason: 'throttled', lastWakeAt: device.lastWakeAt });
      return;
    }
    try {
      const result = await sendApns(device, body.reason || 'stale', body.payload || {});
      device.lastWakeAt = nowIso();
      device.wakeCount = (device.wakeCount || 0) + 1;
      addPushLog({ deviceId: key, instanceId: instance.id, reason: body.reason || 'stale', status: 'sent', statusCode: result.statusCode, apnsId: result.apnsId, error: '' });
      saveState(state);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      const result = error.result || {};
      addPushLog({ deviceId: key, instanceId: instance.id, reason: body.reason || 'stale', status: 'error', statusCode: result.statusCode || 0, apnsId: result.apnsId || '', error: error.message });
      saveState(state);
      sendJson(res, error.statusCode || 500, { error: error.message, result });
    }
    return;
  }

  const notifyMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/notify$/);
  if (req.method === 'POST' && notifyMatch) {
    const body = await readJsonBody(req);
    const appDeviceId = decodeURIComponent(notifyMatch[1]);
    const key = deviceKey(instance.id, appDeviceId);
    const device = state.devices[key];
    if (!device) {
      sendJson(res, 404, { error: 'Device not registered for this instance' });
      return;
    }
    if (!body.payload || typeof body.payload !== 'object') {
      sendJson(res, 400, { error: 'payload is required' });
      return;
    }
    try {
      const result = await sendApns(device, body.reason || 'notification', body.payload, { pushType: 'alert' });
      addPushLog({ deviceId: key, instanceId: instance.id, reason: body.reason || 'notification', status: 'sent', statusCode: result.statusCode, apnsId: result.apnsId, error: '' });
      saveState(state);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      const result = error.result || {};
      addPushLog({ deviceId: key, instanceId: instance.id, reason: body.reason || 'notification', status: 'error', statusCode: result.statusCode || 0, apnsId: result.apnsId || '', error: error.message });
      saveState(state);
      sendJson(res, error.statusCode || 500, { error: error.message, result });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/admin' });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/admin')) {
      await handleAdmin(req, res, url);
      return;
    }
    await handleApi(req, res, url);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ioBroker iOS Push Relay listening on http://${HOST}:${PORT}`);
});
