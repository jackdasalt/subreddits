# Reddit Briefing

A GitHub Pages news briefing built from public Reddit `/top?t=day` and `/hot` listings.

The deployed site shows a concise overview first, then distinct story cards. It removes duplicate URLs and substantially similar headlines, ranks posts by engagement and freshness, and supports images, Reddit video, galleries and YouTube embeds. Details can load top comments when live access is available.

## Why this version is reliable

The important summary does **not** depend on the visitor's browser contacting Reddit.

A GitHub Actions workflow fetches the public listings, builds `data/digest.json`, and deploys the complete site to GitHub Pages. The workflow runs:

- whenever you push changes;
- when you run it manually;
- once per hour.

If a scheduled fetch fails, the workflow does not replace the last successful Pages deployment with an empty page.

The included Cloudflare Worker is optional. It enables live refreshes and comments where direct browser access is blocked, but it is not required for the main briefing.

---

# Deploy to GitHub Pages

## 1. Create the repository

Create a new GitHub repository and upload **all files and folders from this project** to its root. Make sure the hidden `.github` folder is included.

The repository should contain, amongst other files:

```text
.github/workflows/deploy-pages.yml
scripts/build_digest.py
index.html
app.js
styles.css
subreddits.json
```

## 2. Select GitHub Actions as the Pages source

Open the repository and go to:

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

Do not select “Deploy from a branch”; this project uses the included workflow.

## 3. Run the workflow

Uploading the files to `main` normally starts it automatically. You can also open:

```text
Actions → Build and deploy Reddit briefing → Run workflow
```

When the workflow finishes, its deployment step displays the Pages URL.

That is enough for the main summary site. No Reddit account, API key, OAuth secret or external database is required.

---

# Change the subreddits

Edit `subreddits.json`:

```json
{
  "postsPerSubreddit": 5,
  "subreddits": [
    { "name": "tennis", "label": "Tennis" },
    { "name": "soccer", "label": "Football" },
    { "name": "chess", "label": "Chess" }
  ]
}
```

Use the subreddit name without `r/`. The `label` is the text shown in the filter bar.

The supplied configuration contains:

- `r/tennis`
- `r/soccer`
- `r/chess`
- `r/formula1`
- `r/coys`
- `r/chelseafc`
- `r/reddevils`
- `r/mcfc`

Committing a change starts a fresh build and deployment.

---

# What the summary does

For both the top-day and hot views, the app:

1. reads the latest generated listing data;
2. removes stickied and repetitive daily discussion threads;
3. ranks posts using score, comments, age and upvote ratio;
4. removes exact-link duplicates;
5. removes headlines with substantial word overlap;
6. keeps the configured number of stories per community;
7. builds the large overview from the strongest distinct stories.

Self-post text is used as the card summary when available. Link and media posts are presented as a headline briefing with engagement context. The app does not fabricate facts or send content to an external AI service.

---

# Optional: live refreshes and comments

The static briefing works without this section. Deploy the Worker only if you want the **Refresh briefing** button and comment panel to fetch Reddit live from every visitor's browser session.

## Deploy with the Cloudflare dashboard

1. Create or sign in to a free Cloudflare account.
2. Open **Workers & Pages**.
3. Select **Create → Worker → Deploy**.
4. Open the Worker and choose **Edit code**.
5. Replace the sample with the entire contents of `worker/worker.js`.
6. Deploy it.
7. Copy the resulting URL, for example:

```text
https://reddit-briefing-proxy.your-name.workers.dev
```

8. Put it in `deployment.json`:

```json
{
  "apiBase": "https://reddit-briefing-proxy.your-name.workers.dev",
  "postsPerSubreddit": 5,
  "showMedia": true
}
```

9. Commit the change. The Pages workflow redeploys the site.

Test the Worker with:

```text
https://YOUR-WORKER.workers.dev/health
```

It should return JSON containing `"ok": true`.

Test a listing with:

```text
https://YOUR-WORKER.workers.dev/listing?subreddit=tennis&sort=top&t=day&limit=5
```

## Deploy with the command line

From the `worker` folder:

```bash
npm install
npm run deploy
```

Copy the deployed URL into `deployment.json` and commit it.

---

# Run locally

Run a local web server from the project folder:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

The placeholder `data/digest.json` is empty until the build script runs. To generate live data locally:

```bash
python3 scripts/build_digest.py
```

Then refresh the local page.

To run the optional Worker locally:

```bash
cd worker
npm install
npm run dev
```

Put the local Worker URL printed by Wrangler into `deployment.json`.

---

# Media support

The app embeds:

- Reddit-hosted images;
- Reddit-hosted video fallback files;
- Reddit galleries;
- YouTube videos;
- Reddit preview images for many external links.

Some publishers prohibit embedding. Those cards retain an **Open source** button.

---

# Troubleshooting

## The Pages URL does not exist

Open the Actions tab and confirm the workflow completed. Also confirm Pages is set to **GitHub Actions**, not **Deploy from a branch**.

## The workflow fails while fetching Reddit

Open the failed `Fetch public Reddit listings` step. The builder tries several JSON URLs and an Atom/RSS fallback. Re-run the workflow once; a temporary upstream block should not overwrite an existing successful deployment.

## The site says the published data file is empty

The placeholder file was deployed instead of the generated one. Confirm the included workflow is being used and that its `Fetch public Reddit listings` step succeeded.

## A particular subreddit is missing

Check the spelling in `subreddits.json`. Names may contain letters, digits and underscores and should not include `r/`.

## Live refresh fails but the briefing remains visible

That is expected when the optional Worker has not been configured and the browser blocks direct Reddit access. The hourly published briefing remains available.
