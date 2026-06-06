# Reddit Digest

A static GitHub Pages web app that builds a 24-hour briefing from configured subreddits. It fetches top posts, ranks them, removes near-duplicates, shows extractive summaries, embeds available media, and loads top comments/replies inside the app.

## Important limitations

This is designed for easy GitHub Pages deployment, so it runs fully in the browser. That means:

- There is no private backend and no safe place to store Reddit OAuth client secrets.
- Reddit's public JSON endpoints can be rate-limited or blocked by CORS from some browsers/origins.
- The summaries are extractive and heuristic, not AI-generated, because a static site cannot safely call a paid LLM API with a secret key.
- Media is embedded when Reddit exposes a direct image, video, preview or oEmbed payload. Some third-party embeds may still refuse iframe/video playback.

For a more robust version, add a small serverless proxy on Cloudflare Workers, Netlify Functions or Vercel that handles Reddit OAuth/caching and, optionally, AI summarisation.

## Local testing

Do not open `index.html` directly from your filesystem. Run a tiny local server:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## GitHub Pages deployment

1. Create a new GitHub repository, for example `reddit-digest`.
2. Upload these files to the repository root:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `subreddits.json`
   - `README.md`
3. Commit and push to `main`.
4. In GitHub, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select branch `main` and folder `/root`.
7. Save. GitHub will publish the site at a `github.io` URL.

## Adding or removing subreddits

Edit `subreddits.json`:

```json
{
  "subreddits": ["tennis", "soccer", "chess"]
}
```

Use names without the `r/` prefix. You can also edit the list in the website settings panel; browser changes are saved in `localStorage` for your device only.

## CORS proxy option

Start with `corsProxyPrefix` blank. If Reddit blocks requests from your GitHub Pages URL, create a proxy you control and set the prefix in `subreddits.json` or the settings panel.

The app expects a proxy prefix that accepts the encoded target URL appended to the end, for example:

```json
"corsProxyPrefix": "https://your-proxy.example/?url="
```

## What the app ranks as important

The score is a simple blend of Reddit score, comment count and upvote ratio. Near-duplicate titles are removed using token overlap, controlled by `duplicateSimilarityThreshold` in `subreddits.json`.
