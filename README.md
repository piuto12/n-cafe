# N Cafe - Modern Canteen Management System

A web application for canteen orders, POS transactions, barcode ticket validation,
inventory tracking, and UPI payments.

---

## Host on Your Windows PC or Local Server

These steps run N Cafe on your Windows computer or on a Windows machine connected to
your local network. The computer must stay on and connected while people use the site.
This setup is for local/LAN use, not public Internet hosting.

### 1. Install Node.js

Install **Node.js 22 LTS** from [nodejs.org](https://nodejs.org/). Then open PowerShell
and confirm both commands work:

```powershell
node --version
npm --version
```

### 2. Put the project on the server computer

Download or copy the project onto the Windows computer and extract it to a folder, for
example `C:\n-cafe`. Open PowerShell in that folder:

```powershell
cd C:\n-cafe
```

The folder should contain `package.json`, `server.js`, `admin.html`, and `index.html`.

### 3. Create and edit `.env`

`.env.example` is a template; the server reads settings from `.env`. Create `.env` only
if it does not already exist so you do not overwrite existing passwords:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Replace the example values with your own:

- `JWT_SECRET`: a private random string at least 32 characters long.
- `ADMIN_PASSWORD`: the password you will use to sign in to `/admin`.
- `OPERATOR_PIN`: exactly four digits for the staff scanner.
- Leave `ALLOWED_ORIGIN` commented out for local same-origin use. Do not leave the
  example domain in place.
- Leave `DATA_DIR=../n-cafe-data` or choose another writable folder on this computer.

Save `.env` and close Notepad. Do not share it or upload it to GitHub; it is excluded
from Git because it contains passwords. If you already have `.env`, keep its existing
values unless you intend to change your local credentials.

### 4. Install packages and start the server

In the same PowerShell window, run:

```powershell
npm install
npm start
```

Keep this window open while the site is in use. When the server starts, open
`http://localhost:8000` on the server computer. Open the admin panel at
`http://localhost:8000/admin`.

The local database is SQLite and is created automatically. The server stores its
database under the configured `DATA_DIR` (the example value `../n-cafe-data` keeps the
database in a folder beside the project). Back up this folder regularly.

### 5. Let other devices on your Wi-Fi use it (optional)

Find the server computer's local IPv4 address:

```powershell
ipconfig
```

Use the **IPv4 Address** shown for the connected Wi-Fi/Ethernet adapter. On the other
device, open `http://SERVER-IP:8000`, replacing `SERVER-IP` with that address, for
example `http://192.168.1.25:8000`.

If Windows Firewall asks, allow Node.js on **Private networks only**. If it does not
ask, open PowerShell **as Administrator** and add a private-network firewall rule:

```powershell
New-NetFirewallRule -DisplayName "N Cafe local web server" -Direction Inbound `
  -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

Only devices on your trusted local network should be able to access this server. Do not
configure router port forwarding to expose it to the public Internet. For public hosting,
use the Render instructions below; Render also needs the production environment
variables and MongoDB connection configured there.

### Troubleshooting local startup

- **“Missing required environment variable(s)”**: check that `.env` is in the same folder
  as `server.js`, has `JWT_SECRET`, `ADMIN_PASSWORD`, and `OPERATOR_PIN`, and that you
  restarted the server after editing it.
- **“JWT_SECRET must contain at least 32 random characters”**: replace the example
  value with a longer private random string.
- **Another program is using port 8000**: add `PORT=8001` to `.env`, restart the server,
  and use port `8001` in the browser and firewall rule.
- **Other devices cannot connect**: make sure both devices are on the same Wi-Fi,
  Windows Firewall allows Node.js on Private networks, and you are using the server
  computer's current IPv4 address.

To stop the server, focus its PowerShell window and press **Ctrl+C**.

---

## How to Host on Render

N Cafe includes an Express server for authentication, bookings, payments, and database
access. Deploy it as a **Web Service**, not a Static Site.

### Step 1: Create a Web Service

1. Log in to [Render](https://render.com).
2. Click **New > Web Service**.
3. Connect GitHub and select the `n-cafe` repository.
4. Configure:
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Add these variables under **Environment** before deploying:
   - `JWT_SECRET`: at least 32 random characters.
   - `ADMIN_PASSWORD`: a strong administrator password.
   - `OPERATOR_PIN`: exactly four digits.
   - `ALLOWED_ORIGIN`: your Render HTTPS URL, such as `https://n-cafe.onrender.com`.
   - `MONGODB_URI`: your MongoDB Atlas connection string.
   - `MONGODB_DATABASE`: MongoDB database name, normally `n_cafe`.
6. Click **Create Web Service**.

Render does not load `.env.example` automatically. Enter these values in the service's
**Environment** settings, or create the service from the included `render.yaml`
Blueprint. Never commit real secret values to GitHub.

If deployment stops with `Missing required environment variable(s)`, add the named
variables under **Environment**, click **Save Changes**, and choose **Manual Deploy >
Deploy latest commit**.

## Understanding the Database

The server uses MongoDB when `MONGODB_URI` is configured. MongoDB Atlas is recommended
for hosted production because it persists menus, orders, ledger transactions, settings,
and inventory across redeploys. SQLite remains available for local development when
MongoDB is not configured. The local `.env` file is ignored by Git.

## Key Features

1. **Staff portal** for the operator scanner and admin panel.
2. **UPI payments** using standard `upi://pay` links and payment-app QR codes.
3. **CODE128 barcode scanner** containing a compact 20-character ticket ID.
4. **Automatic receipt printing** after a successful barcode redemption.
5. **Excel/CSV export** for ledger transactions and inventory logs.
