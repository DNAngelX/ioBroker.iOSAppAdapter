# ioBroker iOS Push Relay

Mandantenfähiges APNs Silent-Push-Relay für die ioBroker iOS/watchOS App.

## Start lokal

```bash
ADMIN_USER=admin ADMIN_PASSWORD=admin PORT=8787 node server.js
```

WebUI: `http://localhost:8787/admin`

## Produktionsbetrieb

- Relay intern auf `127.0.0.1:8787` betreiben.
- Öffentlich nur per HTTPS Reverse Proxy auf `443` freigeben.
- Optional `80` nur für Let's Encrypt/HTTP-zu-HTTPS-Redirect öffnen.
- Adapter-Relay-URL: `https://ios.stoll-mueller.de`
- NGINX/Caddy Proxy-Ziel: `http://192.168.20.190:8787` oder lokal auf dem Relay-Host `http://127.0.0.1:8787`.
- APNs Credentials nur in der Relay-WebUI speichern, niemals im ioBroker-Adapter.
- Adapter erhalten eigene API-Keys und dürfen nur eigene Devices wecken.
