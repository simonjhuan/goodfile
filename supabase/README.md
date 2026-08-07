# GoodFile — Cloud Share (Supabase)

Adds a **Cloud** tab to GoodFile: upload a file → get a public link + QR that the
receiver opens in any browser (no app needed). Files **auto-delete after 20 minutes**
to free space, deleted server-side so it happens even if the app is closed.

> ⏸ **STATUS: built but disabled.** The Cloud tab was removed from the app UI to ship
> later. All code is preserved (`www/supabase-share.js` + this `supabase/` folder).
> To turn it back on, see **"Re-enable later"** at the bottom of this file.

```
[App] --upload (REST)--> [Supabase Storage 'shared' bucket] --public link + QR--> [Receiver browser]
                                      ^
                          pg_cron every 5 min deletes files older than 20 min
```

## One-time setup (≈5 minutes)

### 1. Create a Supabase project
- Go to https://supabase.com → **New project**. Wait for it to finish provisioning.

### 2. Get your keys — **Settings → API**
- **Project URL** → e.g. `https://abcdefghijklmnop.supabase.co`
- **anon public** key (starts with `eyJ...`) → safe to ship in the app
- **service_role** key (starts with `eyJ...`) → **secret**, used only in the SQL below

### 3. Configure the app
Open [`www/supabase-share.js`](../www/supabase-share.js) and fill the `GF_SUPABASE` block:

```js
var GF_SUPABASE = {
  url:    'https://abcdefghijklmnop.supabase.co', // Project URL
  anon:   'eyJhbGciOi...',                        // anon public key
  bucket: 'shared',
  maxBytes: 50 * 1024 * 1024
};
```

> This project does **not** run `cap sync` at build. After editing any file under
> `www/`, copy it to `android/app/src/main/assets/public/` too (same for `index.html`).

### 4. Run the SQL
Open **Dashboard → SQL Editor**, paste [`supabase/setup.sql`](setup.sql), then **edit the
two placeholders in step 4** (`proj_url` and `service_key`) and **Run**. This:
- creates the public `shared` bucket (50 MB/file limit),
- adds RLS so the anon key can only **upload** and **read** in `shared`,
- schedules a `pg_cron` job that deletes files older than 20 minutes.

### 5. Done — test it
Open the app → **Cloud** tab → tap the cloud → pick a file → share the link/QR.
The countdown shows time left; the file disappears within ~20–25 min.

## Notes & tuning
- **Expiry window** — change `interval '20 minutes'` in `setup.sql` and `CLOUD_TTL_MS`
  in `supabase-share.js` together. Tighten the cron to `'* * * * *'` (every minute) for
  expiry closer to exactly 20 min.
- **Max file size** — raise the bucket `file_size_limit` in `setup.sql` *and* `maxBytes`
  in `supabase-share.js`. Also check **Settings → Storage** global upload limit.
- **Security** — the `anon` key is public by design; RLS restricts it to insert/select on
  the `shared` bucket only (cannot delete or touch other buckets). The `service_role` key
  lives only inside the `security definer` SQL function in your database, never in the app.
- **Privacy** — links use a random 24-char folder, so they are unguessable, but anyone with
  the link can open it until it expires. For private+expiring links instead, switch the
  bucket to private and generate signed URLs (not enabled in this default setup).
- **Offline** — the Cloud tab needs internet (it's a cloud feature). The existing local /
  Direct / Hotspot transfer modes still work fully offline.

## Re-enable later (turn the Cloud tab back on)

The feature was wired into `www/index.html` then removed. To restore it, re-apply
these 5 edits in `www/index.html`, then copy the file to
`android/app/src/main/assets/public/index.html` (this project does not run `cap sync`).

1. **Script include** — before `<script src="i18n.js"></script>` add:
   ```html
   <script src="supabase-share.js"></script>
   ```
2. **Nav button** — after the `n-p2p` button in `.nav-bar` add:
   ```html
   <button class="nav-item" id="n-cloud" type="button"><span class="nav-ic">☁️</span><span class="nav-lbl">Cloud</span></button>
   ```
3. **Tabs array** — change `var tabs=['send','qr','p2p','recv','hist'];`
   to `var tabs=['send','qr','p2p','cloud','recv','hist'];`
4. **Nav wiring** — in `bindEvents()`, after the `n-p2p` line add:
   ```js
   on('n-cloud','click',function(){go('cloud');});
   ```
5. **Screen markup** — paste the contents of
   [`supabase/cloud-screen.html.snippet`](cloud-screen.html.snippet) into `www/index.html`
   immediately **before** the `<!-- RECEIVE -->` screen block.

Then complete the **One-time setup** above (config keys + `setup.sql`).
