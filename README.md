# Reddit Digest

A GitHub Pages-friendly subreddit briefing app.

This version fixes the browser-side Reddit fetching problem: the web page does **not** fetch Reddit directly. A GitHub Action fetches `/top.json?t=day` server-side, captures top comments/replies and media metadata, writes `data/digest.json`, and the static site reads that local file.

## What it does

- Tracks the subreddits listed in `subreddits.json`.
- Uses `top/day` by default, with an optional `hot` fallback.
- Filters to posts created in the past 24 hours.
- Ranks by score, comment count, upvote ratio and freshness.
- Removes near-duplicate stories by comparing titles and URLs.
- Saves top comments and nested replies into the digest file.
- Displays Reddit-hosted videos, GIF-style videos, images, galleries, previews and supported oEmbed embeds inside the app.
- Runs as a static site on GitHub Pages.

## Quick GitHub Pages deployment

1. Create a new GitHub repository.
2. Upload every file and folder from this project to the repository root.
3. Go to **Settings → Actions → General → Workflow permissions**.
4. Select **Read and write permissions**, then save.
5. Go to **Settings → Pages**.
6. Under **Build and deployment**, choose **Deploy from a branch**.
7. Select your default branch, usually `main`, and `/root`, then save.
8. Go to **Actions → Build Reddit Digest → Run workflow**.
9. Wait for the workflow to finish, then open your GitHub Pages URL.

The workflow also runs every two hours. You can change the schedule in `.github/workflows/build-digest.yml`.

## Changing subreddits

Edit `subreddits.json`:

```json
{
  "subreddits": ["tennis", "soccer", "chess", "formula1"],
  "settings": {
    "listing": "top",
    "timeFilter": "day"
  }
}
```

Use names without `r/`, though the script also cleans `r/example` if you enter it.

## Recommended: add Reddit OAuth secrets

The app can run without secrets via Reddit’s public `.json` pages. For better reliability, create a Reddit app and add these GitHub repository secrets:

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`, for example `web:reddit-digest:v2.0 by u_yourname`

Then rerun the workflow. The builder automatically uses OAuth when the secrets exist and falls back to public JSON if they do not.

## Local testing

Requires Node 20 or newer.

```bash
npm run build
npm run serve
```

Then open:

```text
http://localhost:8080
```

## Important limitations

- This is not a real-time Reddit client. It updates when the GitHub Action runs.
- Some third-party media providers block embedding. When that happens, the app shows the available preview or fallback media instead.
- Reddit-hosted video `fallback_url` sometimes lacks audio because Reddit may store video and audio separately.
- The summaries are extractive/rule-based. For genuine AI summaries, add a server-side summarisation step to `scripts/build-digest.mjs` using your preferred model API key.

## File map

```text
index.html                       Static app shell
styles.css                       Design system and layout
app.js                           Front-end renderer for data/digest.json
subreddits.json                  Editable subreddit/settings config
data/digest.json                 Generated digest consumed by the web app
scripts/build-digest.mjs         Server-side Reddit fetcher/summariser
.github/workflows/build-digest.yml Scheduled/manual GitHub Action
```
