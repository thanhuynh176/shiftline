# Shiftline — Deploy Guide

## Project Structure

```
shiftline/
├── shiftline-worker.html   ← Worker PWA (mobile)
├── shiftline-manager.html  ← Manager app (desktop)
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service worker
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── apple-touch-icon.png
├── _redirects              ← Cloudflare: / → worker app
└── _headers                ← Cloudflare: cache + SW headers
```

## Deploy to Cloudflare Pages

### Step 1 — Push to GitHub
1. Create a new repo on github.com (name it `shiftline`)
2. In your terminal:
```bash
cd shiftline/
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/shiftline.git
git push -u origin main
```

### Step 2 — Connect Cloudflare Pages
1. Go to https://pages.cloudflare.com → Sign up / Log in (free)
2. Click **Create a project** → **Connect to Git**
3. Authorize GitHub → select your `shiftline` repo
4. Build settings:
   - **Framework preset**: None
   - **Build command**: _(leave blank)_
   - **Build output directory**: `/` _(or leave blank)_
5. Click **Save and Deploy**

Your app will be live at: `https://shiftline.pages.dev` (or a name you pick)

### Step 3 — Share with workers
- Worker app: `https://shiftline.pages.dev/shiftline-worker.html`
- Manager app: `https://shiftline.pages.dev/shiftline-manager.html`
- Root URL `https://shiftline.pages.dev` auto-redirects to worker app

---

## PWA Install — What workers will see

**Android (Chrome):**
- An "Install Shiftline" banner appears automatically after ~3 seconds
- Tap Install → app appears on home screen like a native app

**iPhone (Safari):**
- A hint appears: "Tap Share ⬆ → Add to Home Screen"
- Must be opened in Safari (not Chrome on iOS) for install to work

---

## Supabase Credentials (already embedded in HTML files)
- URL: https://zqatducmyobthysrzvol.supabase.co
- Login: Workers use Worker ID + PIN (e.g. W010 / 1234)
- Manager: ADMIN / 0000
