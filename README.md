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
configure router port forwarding to expose it to the public Internet. For worldwide
access, follow the company Linux server steps below or use the Render instructions.

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

## Host Publicly on a Company Ubuntu/Debian Server

Use this section if your company already provides a public Linux server. The website
will be available worldwide at your domain. Coordinate with your company's IT/server
administrator before opening firewall ports or changing DNS. These commands assume
Ubuntu or Debian, SSH access with `sudo`, and a domain name pointed at the server.

### 1. Point your domain to the server

Ask your administrator for the server's public IP address. At your domain's DNS
provider, create an **A record** for the chosen hostname (for example, `cafe.example.com`)
pointing to that IP. If your server uses IPv6, configure an AAAA record too. Wait for
DNS to update before requesting an HTTPS certificate.

### 2. Install server packages and Node.js 22

Connect to the server using SSH, then install Git, Nginx, and certificate tools:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx
```

Install **Node.js 22** using your company's approved package source or Node.js
installation procedure. Check the installed version and path:

```bash
node --version
command -v node
npm --version
```

`node --version` must report version 22.x. Keep the path from `command -v node`; you
will need it in the systemd service below.

### 3. Install the app

Clone the repository into `/opt/n-cafe` (use your company's approved Git URL and
authentication method if it differs):

```bash
sudo git clone https://github.com/piuto12/n-cafe.git /opt/n-cafe
cd /opt/n-cafe
sudo npm ci --omit=dev
```

Create a dedicated, unprivileged Linux account for the app and its writable data
directory:

```bash
sudo useradd --system --home-dir /var/lib/n-cafe --shell /usr/sbin/nologin ncafe
sudo install -d -o ncafe -g ncafe -m 750 /var/lib/n-cafe
```

### 4. Configure production environment variables

Production mode requires MongoDB; it does not use the local SQLite database. Use a
company-managed MongoDB service or MongoDB Atlas, and create a database/user for N Cafe.
Restrict database network access to this app server when possible.

Create a root-only environment file:

```bash
sudo install -d -m 700 /etc/n-cafe
sudo nano /etc/n-cafe/n-cafe.env
```

Put these settings in the file, replacing the example values with your own:

```dotenv
NODE_ENV=production
PORT=8000
JWT_SECRET=replace-with-at-least-32-random-characters
ADMIN_PASSWORD=replace-with-a-strong-unique-password
OPERATOR_PIN=replace-with-exactly-four-digits
MONGODB_URI=mongodb+srv://<database-user>:<url-encoded-password>@<cluster>/<database>?retryWrites=true&w=majority
MONGODB_DATABASE=n_cafe
ALLOWED_ORIGIN=https://cafe.example.com
DATA_DIR=/var/lib/n-cafe
```

Use the real public HTTPS origin for `ALLOWED_ORIGIN` (no trailing slash). Generate a
secret with a trusted password manager or `openssl rand -base64 48`. URL-encode special
characters in the MongoDB password before putting it in the connection URI. Save the
file, then restrict access:

```bash
sudo chown root:root /etc/n-cafe/n-cafe.env
sudo chmod 600 /etc/n-cafe/n-cafe.env
```

Never put these production values in the repository, `.env.example`, or a message.

### 5. Run the app as a system service

Create the systemd unit:

```bash
sudo nano /etc/systemd/system/n-cafe.service
```

Paste this configuration. Replace `/usr/bin/node` with the exact path printed by
`command -v node` in Step 2 if it is different:

```ini
[Unit]
Description=N Cafe web application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ncafe
Group=ncafe
WorkingDirectory=/opt/n-cafe
EnvironmentFile=/etc/n-cafe/n-cafe.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/n-cafe

[Install]
WantedBy=multi-user.target
```

Enable the service and check that it starts:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now n-cafe
sudo systemctl status n-cafe
sudo journalctl -u n-cafe -n 50 --no-pager
```

The app listens internally on port 8000. Do not expose that port directly to the
Internet; Nginx will accept public web traffic and forward it to the app.

### 6. Configure Nginx as the public HTTPS front end

Create the Nginx site file and replace `cafe.example.com` with your domain:

```bash
sudo nano /etc/nginx/sites-available/n-cafe
```

```nginx
server {
    listen 80;
    server_name cafe.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and validate Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/n-cafe /etc/nginx/sites-enabled/n-cafe
sudo nginx -t
sudo systemctl reload nginx
```

Ask your company administrator to allow inbound **TCP 80 and 443** to this server.
Keep port 8000 blocked from public access. Once DNS points to this server and port 80 is
reachable, issue the HTTPS certificate:

```bash
sudo certbot --nginx -d cafe.example.com
```

Follow Certbot's prompts and choose the option to redirect HTTP traffic to HTTPS.

### 7. Verify and maintain the deployment

Open `https://cafe.example.com` and `https://cafe.example.com/admin`. Check the health
endpoint:

```bash
curl -i https://cafe.example.com/health
```

It should return HTTP 200 and report a connected database. If startup fails, inspect
`sudo journalctl -u n-cafe -n 100 --no-pager` and verify the MongoDB URI, network access,
and environment file values.

To deploy a later update:

```bash
cd /opt/n-cafe
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo systemctl restart n-cafe
sudo systemctl status n-cafe
```

Arrange regular MongoDB backups with your database administrator. Keep Node.js, Linux,
Nginx, and the app updated, and do not expose the database or app port directly to the
public Internet.

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
