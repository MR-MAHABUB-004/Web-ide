# Web IDE (Replit-style, self-hosted)

## Install (VPS)
    sudo apt install -y nodejs npm   # Node 18+ recommended
    cd web-ide && npm install
    IDE_PASSWORD='tomar-strong-password' node server.js

Browser: http://YOUR_IP:6617   (firewall এ 6617 open করো: `sudo ufw allow 6617`)

## 24/7 চালাতে (pm2)
    npm i -g pm2
    IDE_PASSWORD='...' pm2 start server.js --name web-ide
    pm2 save && pm2 startup

## Project URL
প্রতিটা project: http://YOUR_IP:6617/p/<project-name>/
- Static (index.html আছে, package.json নেই): সরাসরি serve হয়, Run লাগে না।
- Node (package.json বা server.js আছে): ▶ Run চাপলে `npm install` (দরকার হলে) + `npm start` চলে,
  `PORT` env দেওয়া হয় — তোমার app এ `app.listen(process.env.PORT)` ব্যবহার করো।
- Link/asset এ relative path ব্যবহার করো (`style.css`, `api/hello`) — `/style.css` এও কাজ করবে (Referer fallback আছে)।

## আগের project import
`projects/` ফোল্ডারে ফোল্ডার কপি করে দাও, অথবা IDE তে Upload + shell এ `unzip x.zip`.

## Env
IDE_PORT (default 6617) · IDE_PASSWORD · PROJECTS_DIR
