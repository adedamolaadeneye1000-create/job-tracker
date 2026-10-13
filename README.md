# Job Hunt Tracker

A personal web app for tracking job applications. It shows weekly progress against a target, a funnel from application to offer, where applications drop out, results by career track, a feedback log, and a week-by-week plan to an offer.

**Built with:** HTML, CSS and plain JavaScript (no build step) · Supabase (Postgres database, authentication, Row Level Security) · installable as an app on your phone (PWA) · hosted on GitHub Pages.

---

## Set it up (about an hour the first time)

### Part 1: Create the database in Supabase

1. Go to [supabase.com](https://supabase.com) and sign up for a free account.
2. Click **New project**.
   - Name: `job-hunt`
   - Database password: make a strong one and save it somewhere safe.
   - Region: the one closest to you (London).
   - Click **Create new project** and wait a couple of minutes.
3. In the left menu, open **SQL Editor**, then **New query**.
4. Open `supabase/schema.sql` from this folder, copy everything, paste it in, and click **Run**. You should see "Success. No rows returned".
5. In the left menu, open **Authentication**, then **Users**. Click **Add user**, then **Create new user**.
   - Enter your email and a password you will remember.
   - Tick **Auto Confirm User**, then create the user.
6. Still in **Authentication**, open **Sign In / Providers** and turn off **Allow new users to sign up**. Save. Now only your account can sign in.
7. Click **Connect** at the top of the project page. Copy the **Project URL** and the **publishable key** (it starts with `sb_publishable_`).
8. Open `config.js` in a text editor (Notepad, TextEdit or VS Code). Paste the URL and the key between the quotes, then save.

### Part 2: Put it online with GitHub Pages

1. Sign in to [github.com](https://github.com) (or create a free account).
2. Click **+** at the top right, then **New repository**.
   - Name: `job-tracker`
   - Visibility: **Public** (GitHub Pages is free for public repositories)
   - Click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Drag in everything inside this folder: the files `index.html`, `app.js`, `styles.css`, `config.js`, `content.js`, `sw.js`, `manifest.webmanifest`, `README.md`, and the folders `icons`, `vendor` and `supabase`. Click **Commit changes**.
5. Open **Settings**, then **Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose **main** and **/ (root)**, then **Save**.
6. Wait a minute or two. Your site is at `https://YOUR-GITHUB-USERNAME.github.io/job-tracker/`.

### Part 3: Finish off

1. In Supabase, open **Authentication**, then **URL Configuration**. Set **Site URL** to your GitHub Pages address and save. This makes password reset emails link back to your site.
2. Open your site and sign in.
3. Scroll to **Your data**, click **Import applications** and choose `my-applications.json`. Keep that file off GitHub, because it holds your personal job data.
4. Add it to your phone's home screen:
   - **Android (Chrome):** open the site, tap **⋮**, then **Add to Home screen** or **Install app**.
   - **iPhone (Safari):** open the site, tap **Share**, then **Add to Home Screen**.

---

## Everyday use

- **New job:** click **Add application**.
- **Progress:** click the application, change its status, add any feedback, and save.
- **Weekly check:** look at **Needs attention** and the weekly chart.
- **Backup:** use **Download backup** under **Your data** now and then.

## Changing the content

Your name, goal date, plan, career tracks and CV list live in `content.js`. Edit it, then upload the new version to GitHub (**Add file**, then **Upload files**). The site updates within a minute or two.

## Good to know

- **Free Supabase projects pause** after about a week of low activity. Supabase emails you first. If the site says your applications couldn't load, open the Supabase dashboard and click **Resume project**. Your data is kept. Using the tracker a few times a week keeps it awake.
- **The publishable key is meant to be public.** Row Level Security in `schema.sql` means only your signed-in account can read or change your rows. Never put the **secret** key (`sb_secret_...`) or the old `service_role` key in any file here.
- **Offline:** the app opens without a connection, but needs one to load and save applications.

---

## How it works

| Part | What it does |
| --- | --- |
| `index.html` | Page structure: sign-in screen, tracker sections, the add/edit form. |
| `styles.css` | Design tokens (colours, fonts) with light and dark mode, then component styles. |
| `app.js` | All behaviour. Data layer (Supabase queries and column mapping), one render function per section, the editor, import/export, sign-in, start-up. |
| `content.js` | Personal content: plan, tracks, CV names, goal date. |
| `config.js` | Supabase project URL and publishable key. |
| `supabase/schema.sql` | Two tables (`applications`, `settings`), an `updated_at` trigger, and Row Level Security policies using `auth.uid()`. |
| `sw.js` + `manifest.webmanifest` | Make it installable. Network-first caching for the app's own files; database calls are never cached. |
| `vendor/` | A pinned copy of supabase-js 2.117.2 (MIT licence), so the site does not depend on a CDN. |

**Security choices:** every piece of user text is inserted as text (no `innerHTML`), a Content Security Policy limits where scripts and data can come from, and sign-ups are switched off so only one account exists.

**Data model:** each application stores its current `status` and the `furthest` stage it reached (0 = not applied, 5 = offer). Keeping both means a rejected application still records whether it got to tests or interview, which powers the "Where applications stop" analysis.
