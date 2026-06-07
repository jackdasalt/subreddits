
const statusEl = document.getElementById("status");
const footerMetaEl = document.getElementById("footerMeta");
const subsEl = document.getElementById("subs");

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","so","because","as","of","to","in","for","on",
  "with","by","from","at","into","about","than","after","before","over","under","again",
  "further","once","here","there","when","where","why","how","all","any","both","each",
  "few","more","most","other","some","such","no","nor","not","only","own","same","too",
  "very","can","will","just","don","should","now","is","are","was","were","be","been",
  "being","have","has","had","do","does","did","doing"
]);

function normaliseWord(w){
  return w.toLowerCase().replace(/[^a-z0-9']/g, "").trim();
}

function sentenceScore(sent, freq){
  const words = sent.split(/\s+/).map(normaliseWord).filter(Boolean);
  if (!words.length) return 0;
  let score = 0;
  for (const w of words){
    if (STOPWORDS.has(w)) continue;
    score += freq.get(w) || 0;
    if (/^[0-9]+$/.test(w)) score += 2;
  }
  // preference for shorter sentences if informative
  return score / Math.pow(words.length, 0.6);
}

function extractiveSummary(textParts, maxSentences = 5){
  const text = textParts.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(s => s.trim()).filter(Boolean);

  // freq map across all text
  const freq = new Map();
  for (const sent of sentences){
    for (const w of sent.split(/\s+/).map(normaliseWord)){
      if (!w || STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  // score sentences; keep top N but preserve original order
  const ranked = sentences.map((s, i) => ({i, s, score: sentenceScore(s, freq)}))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map(r => r.s);

  // fallback to titles
  if (!ranked.length){
    return sentences.slice(0, Math.min(maxSentences, sentences.length)).join(" ");
  }

  return ranked.join(" ");
}

function buildBriefing(posts){
  // pick top ~6 posts but keep total text manageable
  const topPosts = posts.slice(0, 8);
  const parts = topPosts.map(p => (p.title + ". " + (p.selftext || "")).trim()).filter(Boolean);

  const summary = extractiveSummary(parts, 6);
  const headlines = topPosts
    .map(p => p.title)
    .filter(Boolean)
    .slice(0, 6);

  return { summary, headlines, posts: topPosts };
}

function formatMeta(posts){
  if (!posts.length) return "";
  const newest = posts.reduce((a, b) => (b.createdUtc > a.createdUtc ? b : a), posts[0]);
  const oldest = posts.reduce((a, b) => (b.createdUtc < a.createdUtc ? b : a), posts[0]);
  const range = `${formatAge(newest.createdUtc)} ↔ ${formatAge(oldest.createdUtc)}`;
  return `${posts.length} posts • ${range}`;
}

function formatAge(createdUtc){
  if (!createdUtc) return "fresh";
  const deltaMs = Date.now() - createdUtc * 1000;
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderMedia(media){
  if (!media || media.type === "none") return "";
  if (media.type === "image") return `<div class="post-media"><img src="${escapeHtml(media.url)}" alt=""></div>`;
  if (media.type === "video") return `<div class="post-media"><video controls src="${escapeHtml(media.url)}" poster="${media.poster ? escapeHtml(media.poster) : ""}"></video></div>`;
  if (media.type === "gallery"){
    return `
      <div class="post-media">
        ${media.images.map(u => `<img src="${escapeHtml(u)}" alt="">`).join("")}
      </div>`;
  }
  if (media.type === "youtube"){
    const id = media.id || media.url;
    return `
      <div class="post-media">
        <iframe width="100%" height="315" src="https://www.youtube.com/embed/${escapeHtml(id)}"
          title="YouTube video player" frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen></iframe>
      </div>`;
  }
  return "";
}

function escapeHtml(str){
  return String(str || "").replace(/[&<>"']/g, ch => (
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" :
    ch === "'" ? "&#39;" : ch
  ));
}

async function loadJson(path){
  const res = await fetch(path, {cache: "no-store"});
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main(){
  statusEl.textContent = "Loading digest…";
  let config, digest;
  try{
    config = await loadJson("subreddits.json");
    digest = await loadJson("data/digest.json");
  }catch(e){
    statusEl.textContent = "Could not load summary data. Refresh in a moment.";
    console.error(e);
    return;
  }

  const generatedAt = digest.generatedAt || digest.generated_at;
  footerMetaEl.textContent = generatedAt ? `Generated at ${generatedAt}` : "";

  const subs = (config.subreddits || []).map(x => x.name || x);
  const postsBySub = new Map();
  for (const post of (digest.top || [])){
    const key = post.subreddit || "";
    if (!subs.includes(key)) continue;
    if (!postsBySub.has(key)) postsBySub.set(key, []);
    postsBySub.get(key).push(post);
  }
  // stable sorting by engagement already done server-side; ensure deterministic within subreddit
  for (const [k, list] of postsBySub){
    list.sort((a, b) => b.score - a.score || b.numComments - a.numComments || (b.createdUtc || 0) - (a.createdUtc || 0));
    postsBySub.set(k, list);
  }

  subsEl.innerHTML = "";
  for (const subreddit of subs){
    const posts = postsBySub.get(subreddit) || [];
    const { summary, headlines, posts: topPosts } = buildBriefing(posts);

    const card = document.createElement("article");
    card.className = "sub-card";

    card.innerHTML = `
      <div class="sub-head">
        <h2 class="sub-title">r/${escapeHtml(subreddit)}</h2>
        <div class="sub-meta">${escapeHtml(formatMeta(posts))}</div>
      </div>

      <p class="briefing">${escapeHtml(summary || "No posts were summarised for this subreddit yet.")}</p>

      <ol class="headlines">
        ${headlines.map(h => `<li>${escapeHtml(h)}</li>`).join("")}
      </ol>

      <div class="actions">
        <button class="btn btn-more" type="button">Read details</button>
      </div>

      <div class="details">
        ${topPosts.map(p => `
          <div class="post">
            <p class="post-title">${escapeHtml(p.title)}</p>
            <div class="post-meta">${p.author ? escapeHtml(p.author) + " • " : ""}${p.score.toLocaleString()} upvotes • ${p.numComments.toLocaleString()} comments</div>
            <div class="post-body">${escapeHtml((p.selftext || "").slice(0, 1200))}</div>
            ${renderMedia(p.media)}
          </div>
        `).join("")}
      </div>
    `;

    const btnMore = card.querySelector(".btn-more");
    const details = card.querySelector(".details");
    btnMore?.addEventListener("click", () => {
      details.classList.toggle("open");
      btnMore.textContent = details.classList.contains("open") ? "Hide details" : "Read details";
    });

    subsEl.appendChild(card);
  }

  statusEl.textContent = "Loaded.";
}

main();
