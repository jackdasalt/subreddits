
const statusEl = document.getElementById("status");
const datelineEl = document.getElementById("dateline");
const footerMetaEl = document.getElementById("footerMeta");
const subsEl = document.getElementById("subs");

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","so","because","as","of","to","in","for","on","with","by","from","at",
  "into","about","than","after","before","over","under","once","here","there","when","where","why","how","all","any",
  "both","each","few","more","most","other","some","such","no","nor","not","only","own","same","too","very","can",
  "will","just","don","should","now","is","are","was","were","be","been","being","have","has","had","do","does","did",
  "doing"
]);

function escapeHtml(str){
  return String(str || "").replace(/[&<>"']/g, ch => (
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;"
  ));
}

function normaliseWord(w){
  return w.toLowerCase().replace(/[^a-z0-9']/g, "").trim();
}

function keyWords(title){
  // strip leading [SOURCE] tags and common symbols/hashtags
  let t = String(title || "");
  // remove reddit signature if present (from RSS)
  t = t.replace(/submitted by \/u\/.*$/gmi, "").trim();
  t = t.replace(/^\s*(\[[^\]]+\]\s*)+/g, ""); // [UEFA] [Denmark FA]
  t = t.replace(/[#@]/g, " "); // #ManCity, @lequipe
  t = t.replace(/https?:\/\/\S+/g, " ");
  return t.split(/\s+/).map(normaliseWord).filter(w => w && !STOPWORDS.has(w) && w.length >= 3);
}

function jaccard(a, b){
  const A = new Set(a);
  const B = new Set(b);
  const inter = new Set([...A].filter(x => B.has(x)));
  const union = new Set([...A, ...B]);
  return union.size ? inter.size / union.size : 0;
}

function clusterTitles(posts){
  // Greedy clustering on word sets; returns clusters of posts
  const sorted = [...posts].sort((a, b) => b.score - a.score || b.numComments - a.numComments);
  const clusters = [];
  for (const p of sorted){
    const words = keyWords(p.title);
    if (!words.length) continue;
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < clusters.length; i++){
      const sim = jaccard(words, clusters[i].words);
      if (sim > bestSim){ bestSim = sim; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestSim >= 0.44){
      clusters[bestIdx].posts.push(p);
    }else{
      clusters.push({words, posts: [p]});
    }
  }
  return clusters;
}

function sentenceScore(sent, freq){
  const words = sent.split(/\s+/).map(normaliseWord).filter(Boolean);
  if (!words.length) return 0;
  let s = 0;
  for (const w of words){
    if (STOPWORDS.has(w)) continue;
    s += (freq.get(w) || 0);
    if (/^[0-9]+$/.test(w)) s += 2;
  }
  return s / Math.pow(words.length, 0.6);
}

function maximalMarginalRelevance(sentences, freq, maxSentences){
  const selected = [];
  const sim = (a, b) => {
    const A = new Set(a.split(/\s+/).map(normaliseWord));
    const B = new Set(b.split(/\s+/).map(normaliseWord));
    if (!A.size || !B.size) return 0;
    const inter = new Set([...A].filter(x => B.has(x)));
    const union = new Set([...A, ...B]);
    return union.size ? inter.size / union.size : 0;
  };

  for (let k = 0; k < maxSentences; k++){
    let best = null;
    let bestScore = -1;

    for (const sent of sentences){
      // skip already selected
      if (selected.includes(sent)) continue;

      const relevance = sentenceScore(sent, freq);
      const redundancy = selected.length
        ? Math.max(...selected.map(s => sim(sent, s)))
        : 0;
      const mmrScore = 0.75 * relevance - 0.25 * redundancy;
      if (mmrScore > bestScore){
        bestScore = mmrScore;
        best = sent;
      }
    }

    if (!best || bestScore <= 0) break;
    selected.push(best);
  }

  // preserve original reading order
  return selected.length ? sentences.filter(s => selected.includes(s)) : [];
}

function extractiveSummary(textParts, maxSentences){
  const text = textParts.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);

  const freq = new Map();
  for (const s of sentences){
    for (const w of s.split(/\s+/).map(normaliseWord)){
      if (!w || STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  const ranked = maximalMarginalRelevance(sentences, freq, maxSentences);
  if (!ranked.length) return sentences.slice(0, maxSentences).join(" ");
  return ranked.join(" ");
}

function buildBriefing(posts){
  const clusters = clusterTitles(posts);
  const keyStories = clusters.slice(0, 5).map(c => {
    const lead = stripSource(c.posts[0].title);
    const follow = c.posts.length > 1 ? " Further updates and discussion followed." : "";
    return normaliseSentence(lead + follow);
  });

  // Summarise with titles + bodies, but strip repeated signatures like "submitted by /u/..."
  const topForText = posts.slice(0, 10);
  const parts = topForText.map(p => {
    const title = stripSource(p.title);
    const body = (p.selftext || "").replace(/submitted by \/u\/.*$/gmi, "").trim();
    return (title + ". " + body).trim();
  }).filter(Boolean);

  const summary = extractiveSummary(parts, 5);
  const keyline = keyStories;
  return { summary, keyline };
}

function stripSource(title){
  let t = String(title || "").trim();
  // remove leading [SOURCE] tags
  t = t.replace(/^\s*(\[[^\]]+\]\s*)+/g, "");
  // simple tidy
  t = t.replace(/\s+/g, " ").trim();
  // remove trailing source residue such as ". submitted by", which sometimes survives in title via RSS parsing
  t = t.replace(/submitted by \/u\/.*$/gmi, "").trim();
  return t;
}

function normaliseSentence(s){
  if (!s) return "";
  const t = s.trim();
  const end = t.slice(-1);
  if ("!.?".includes(end)) return t;
  return t + ".";
}

function formatMeta(posts){
  if (!posts.length) return "";
  const newest = posts.reduce((a, b) => (b.createdUtc > a.createdUtc ? b : a), posts[0]);
  const oldest = posts.reduce((a, b) => (b.createdUtc < a.createdUtc ? b : a), posts[0]);
  return `${posts.length} posts • ${formatAge(newest.createdUtc)} ↔ ${formatAge(oldest.createdUtc)}`;
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
  if (media.type === "image"){
    return `<div class="post-media"><img src="${escapeHtml(media.url)}" alt=""></div>`;
  }
  if (media.type === "video"){
    const poster = media.poster ? ` poster="${escapeHtml(media.poster)}"` : "";
    return `<div class="post-media"><video controls src="${escapeHtml(media.url)}"${poster}></video></div>`;
  }
  if (media.type === "gallery"){
    return `<div class="post-media">${(media.images || []).slice(0, 6).map(u => `<img src="${escapeHtml(u)}" alt="">`).join("")}</div>`;
  }
  if (media.type === "youtube"){
    const id = media.id || media.url;
    return `<div class="post-media"><iframe width="100%" height="315" src="https://www.youtube.com/embed/${escapeHtml(id)}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }
  return "";
}

function renderReplies(replies){
  if (!replies || !replies.length) return "";
  return `
    <div class="replies">
      ${replies.map(c => `
        <div class="comment">
          <div class="comment-header">${escapeHtml(c.author || "Unknown")} • ${escapeHtml(String(c.score ?? 0))} points</div>
          <div class="comment-body">${escapeHtml(c.body || "")}</div>
          ${renderReplies(c.replies || [])}
        </div>
      `).join("")}
    </div>`;
}

function renderComments(comments){
  if (!comments || !comments.length) return "";
  return `
    <div class="comments">
      ${comments.map(c => `
        <div class="comment">
          <div class="comment-header">${escapeHtml(c.author || "Unknown")} • ${escapeHtml(String(c.score ?? 0))} points</div>
          <div class="comment-body">${escapeHtml(c.body || "")}</div>
          ${renderReplies(c.replies || [])}
        </div>
      `).join("")}
    </div>`;
}

async function loadJson(path){
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main(){
  statusEl.textContent = "Loading briefing…";

  let config, digest;
  try{
    config = await loadJson("subreddits.json");
    digest = await loadJson("data/digest.json");
  }catch(e){
    statusEl.textContent = "Could not load briefing data. Refresh after the next build.";
    console.error(e);
    return;
  }

  const generatedAt = digest.generatedAt || digest.generated_at;
  if (generatedAt){
    datelineEl.textContent = new Date(generatedAt).toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
    footerMetaEl.textContent = `Generated at ${generatedAt}`;
  }

  const subs = (config.subreddits || []).map(x => x.name || x);
  const postsBySub = new Map();

  for (const post of (digest.top || [])){
    const key = post.subreddit || "";
    if (!subs.includes(key)) continue;
    if (!postsBySub.has(key)) postsBySub.set(key, []);
    postsBySub.get(key).push(post);
  }

  for (const [k, list] of postsBySub){
    list.sort((a, b) => b.score - a.score || b.numComments - a.numComments || (b.createdUtc || 0) - (a.createdUtc || 0));
    postsBySub.set(k, list);
  }

  subsEl.innerHTML = "";
  for (const subreddit of subs){
    const posts = postsBySub.get(subreddit) || [];
    const { summary, keyline } = buildBriefing(posts);

    const card = document.createElement("article");
    card.className = "sub-card";
    card.innerHTML = `
      <div class="sub-header">
        <h2 class="sub-title">r/${escapeHtml(subreddit)}</h2>
        <div class="sub-meta">${escapeHtml(formatMeta(posts))}</div>
      </div>

      <p class="briefing">${escapeHtml(summary || "No posts were summarised for this subreddit yet.")}</p>

      <ul class="keyline">
        ${keyline.map(x => `<li>${escapeHtml(x)}</li>`).join("")}
      </ul>

      <div class="actions">
        <button class="btn btn-more" type="button">Read details</button>
      </div>

      <div class="details">
        ${(posts.slice(0, 10)).map(p => `
          <div class="post">
            <p class="post-title">${escapeHtml(stripSource(p.title))}</p>
            <div class="post-meta">${escapeHtml(p.author || "Unknown")} • ${(p.score ?? 0).toLocaleString()} upvotes • ${(p.numComments ?? 0).toLocaleString()} comments</div>
            <div class="post-body">${escapeHtml((p.selftext || "").replace(/submitted by \/u\/.*$/gmi, "").trim())}</div>
            ${renderMedia(p.media)}
            ${renderComments(p.comments || p.topComments || [])}
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
