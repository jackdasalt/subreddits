const CONFIG_URL = 'subreddits.json';
const STORAGE_KEY = 'reddit-digest-settings-v1';

const state = {
  config: null,
  posts: [],
  activeSubreddit: 'all',
  errors: []
};

const $ = (selector) => document.querySelector(selector);
const els = {
  refresh: $('#refreshButton'),
  settings: $('#settingsButton'),
  panel: $('#settingsPanel'),
  subredditInput: $('#subredditInput'),
  postLimitInput: $('#postLimitInput'),
  commentLimitInput: $('#commentLimitInput'),
  maxPostsInput: $('#maxPostsInput'),
  dupeThresholdInput: $('#dupeThresholdInput'),
  proxyInput: $('#proxyInput'),
  saveSettings: $('#saveSettingsButton'),
  overviewTitle: $('#overviewTitle'),
  overviewText: $('#overviewText'),
  statusBar: $('#statusBar'),
  tabs: $('#subredditTabs'),
  grid: $('#digestGrid'),
  template: $('#postCardTemplate')
};

init();

async function init() {
  bindEvents();
  state.config = await loadConfig();
  populateSettingsForm();
  await refreshDigest();
}

function bindEvents() {
  els.refresh.addEventListener('click', refreshDigest);
  els.settings.addEventListener('click', () => {
    const hidden = els.panel.classList.toggle('hidden');
    els.settings.setAttribute('aria-expanded', String(!hidden));
  });
  els.saveSettings.addEventListener('click', async () => {
    saveSettingsFromForm();
    await refreshDigest();
  });
}

async function loadConfig() {
  const base = await fetch(CONFIG_URL).then((r) => r.json());
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  return {
    ...base,
    subreddits: saved.subreddits || base.subreddits,
    settings: { ...base.settings, ...(saved.settings || {}) }
  };
}

function populateSettingsForm() {
  const { subreddits, settings } = state.config;
  els.subredditInput.value = subreddits.join('\n');
  els.postLimitInput.value = settings.postLimitPerSubreddit;
  els.commentLimitInput.value = settings.commentLimitPerPost;
  els.maxPostsInput.value = settings.maxPostsShown;
  els.dupeThresholdInput.value = settings.duplicateSimilarityThreshold;
  els.proxyInput.value = settings.corsProxyPrefix || '';
}

function saveSettingsFromForm() {
  const subreddits = els.subredditInput.value
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/^r\//i, ''))
    .filter(Boolean);

  state.config = {
    subreddits,
    settings: {
      ...state.config.settings,
      postLimitPerSubreddit: clamp(Number(els.postLimitInput.value), 5, 100),
      commentLimitPerPost: clamp(Number(els.commentLimitInput.value), 3, 50),
      maxPostsShown: clamp(Number(els.maxPostsInput.value), 3, 40),
      duplicateSimilarityThreshold: clamp(Number(els.dupeThresholdInput.value), 0.2, 0.95),
      corsProxyPrefix: els.proxyInput.value.trim()
    }
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

async function refreshDigest() {
  setLoading(true);
  state.errors = [];
  state.posts = [];
  state.activeSubreddit = 'all';
  renderStatus(['Fetching Reddit JSON…']);
  renderGrid([]);

  const fetched = [];
  for (const subreddit of state.config.subreddits) {
    try {
      const posts = await fetchTopPosts(subreddit);
      fetched.push(...posts);
      renderStatus([`Fetched r/${subreddit}`, `${fetched.length} candidate posts`]);
      await delay(state.config.settings.requestDelayMs);
    } catch (error) {
      state.errors.push(`r/${subreddit}: ${error.message}`);
    }
  }

  const ranked = fetched
    .filter(isRecentEnough)
    .filter((post) => !post.over_18)
    .sort((a, b) => relevanceScore(b) - relevanceScore(a));

  state.posts = dedupePosts(ranked, state.config.settings.duplicateSimilarityThreshold)
    .slice(0, state.config.settings.maxPostsShown)
    .map((post) => ({ ...post, summary: summarisePost(post) }));

  renderOverview();
  renderTabs();
  renderGrid(filteredPosts());
  renderStatus();
  setLoading(false);
}

async function fetchTopPosts(subreddit) {
  const limit = state.config.settings.postLimitPerSubreddit;
  const path = `/r/${encodeURIComponent(subreddit)}/top.json?t=day&limit=${limit}&raw_json=1`;
  const json = await redditFetch(path);
  return (json.data?.children || []).map((child) => normalisePost(child.data, subreddit));
}

async function fetchComments(post) {
  const path = `${post.permalink}.json?limit=${state.config.settings.commentLimitPerPost}&sort=top&raw_json=1`;
  const json = await redditFetch(path);
  const listing = json?.[1]?.data?.children || [];
  return flattenComments(listing).slice(0, state.config.settings.commentLimitPerPost);
}

async function redditFetch(path) {
  const { redditJsonBaseUrl, corsProxyPrefix } = state.config.settings;
  const url = `${redditJsonBaseUrl}${path}`;
  const target = corsProxyPrefix ? `${corsProxyPrefix}${encodeURIComponent(url)}` : url;
  const response = await fetch(target, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function normalisePost(data, fallbackSubreddit) {
  return {
    id: data.id,
    subreddit: data.subreddit || fallbackSubreddit,
    title: data.title || 'Untitled',
    selftext: data.selftext || '',
    url: data.url_overridden_by_dest || data.url || '',
    permalink: data.permalink,
    score: data.score || 0,
    upvoteRatio: data.upvote_ratio || 0,
    numComments: data.num_comments || 0,
    createdUtc: data.created_utc || 0,
    domain: data.domain || '',
    postHint: data.post_hint || '',
    thumbnail: data.thumbnail || '',
    preview: data.preview,
    media: data.media,
    secureMedia: data.secure_media,
    gallery: data.gallery_data,
    mediaMetadata: data.media_metadata,
    isVideo: data.is_video,
    over_18: data.over_18
  };
}

function isRecentEnough(post) {
  const ageMs = Date.now() - post.createdUtc * 1000;
  return ageMs <= 24 * 60 * 60 * 1000 + 20 * 60 * 1000;
}

function relevanceScore(post) {
  return post.score + post.numComments * 3 + Math.round(post.upvoteRatio * 100);
}

function dedupePosts(posts, threshold) {
  const selected = [];
  for (const post of posts) {
    const duplicate = selected.some((existing) => textSimilarity(post.title, existing.title) >= threshold);
    if (!duplicate) selected.push(post);
  }
  return selected;
}

function textSimilarity(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  const intersection = [...aa].filter((x) => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size || 1;
  return intersection / union;
}

function tokenSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}

function summarisePost(post) {
  const source = `${post.title}. ${post.selftext}`.replace(/\s+/g, ' ').trim();
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [source];
  const clean = sentences.map((s) => s.trim()).filter(Boolean);
  const first = clean.slice(0, 2).join(' ');
  const context = [];
  if (post.domain && !post.domain.includes('self.')) context.push(`Linked source: ${post.domain}.`);
  context.push(`${formatNumber(post.score)} points and ${formatNumber(post.numComments)} comments in r/${post.subreddit}.`);
  return `${first || post.title} ${context.join(' ')}`;
}

function renderOverview() {
  if (!state.posts.length) {
    els.overviewTitle.textContent = 'No digest could be built';
    els.overviewText.textContent = 'Reddit returned no accessible recent posts. Check the settings, your network, or add a CORS proxy if your browser blocks Reddit JSON requests.';
    return;
  }
  const subs = [...new Set(state.posts.map((p) => `r/${p.subreddit}`))].join(', ');
  const themes = extractThemes(state.posts);
  els.overviewTitle.textContent = `${state.posts.length} notable items across ${subs}`;
  els.overviewText.textContent = themes.length
    ? `Dominant themes: ${themes.join(', ')}. The cards below are ranked by a simple blend of score, comment volume and upvote ratio, then filtered to avoid repeated stories.`
    : 'The cards below are ranked by a simple blend of score, comment volume and upvote ratio, then filtered to avoid repeated stories.';
}

function extractThemes(posts) {
  const counts = new Map();
  posts.flatMap((p) => [...tokenSet(p.title)]).forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([, count]) => count > 1).slice(0, 8).map(([token]) => token);
}

function renderTabs() {
  const subs = ['all', ...new Set(state.posts.map((p) => p.subreddit))];
  els.tabs.innerHTML = '';
  subs.forEach((sub) => {
    const button = document.createElement('button');
    button.className = `tab ${state.activeSubreddit === sub ? 'active' : ''}`;
    button.textContent = sub === 'all' ? 'All' : `r/${sub}`;
    button.addEventListener('click', () => {
      state.activeSubreddit = sub;
      renderTabs();
      renderGrid(filteredPosts());
    });
    els.tabs.appendChild(button);
  });
}

function filteredPosts() {
  return state.activeSubreddit === 'all' ? state.posts : state.posts.filter((p) => p.subreddit === state.activeSubreddit);
}

function renderGrid(posts) {
  els.grid.innerHTML = '';
  if (!posts.length) {
    els.grid.innerHTML = '<div class="empty-state">No posts to show for this filter.</div>';
    return;
  }

  posts.forEach((post) => {
    const node = els.template.content.cloneNode(true);
    const card = node.querySelector('.post-card');
    card.querySelector('.subreddit').textContent = `r/${post.subreddit}`;
    card.querySelector('.score').textContent = `${formatNumber(post.score)} pts`;
    card.querySelector('.comment-count').textContent = `${formatNumber(post.numComments)} comments`;
    card.querySelector('h3').textContent = post.title;
    card.querySelector('.post-summary').textContent = post.summary;
    card.querySelector('.source-link').href = `https://www.reddit.com${post.permalink}`;
    renderMedia(card.querySelector('.media-slot'), post);

    const commentsButton = card.querySelector('.comments-button');
    const comments = card.querySelector('.comments');
    commentsButton.addEventListener('click', async () => {
      if (comments.dataset.loaded === 'true') {
        comments.classList.toggle('hidden');
        commentsButton.textContent = comments.classList.contains('hidden') ? 'Show top comments' : 'Hide top comments';
        return;
      }
      commentsButton.disabled = true;
      commentsButton.textContent = 'Loading comments…';
      try {
        const data = await fetchComments(post);
        comments.innerHTML = data.length ? data.map(renderComment).join('') : '<p class="post-summary">No accessible comments returned.</p>';
        comments.dataset.loaded = 'true';
        comments.classList.remove('hidden');
        commentsButton.textContent = 'Hide top comments';
      } catch (error) {
        comments.innerHTML = `<p class="post-summary">Could not load comments: ${escapeHtml(error.message)}.</p>`;
        comments.classList.remove('hidden');
        commentsButton.textContent = 'Retry comments';
      } finally {
        commentsButton.disabled = false;
      }
    });

    els.grid.appendChild(node);
  });
}

function renderMedia(container, post) {
  const video = post.secureMedia?.reddit_video || post.media?.reddit_video;
  if (video?.fallback_url) {
    container.innerHTML = `<video controls preload="metadata" src="${escapeAttr(video.fallback_url)}"></video>`;
    return;
  }

  if (post.postHint === 'image' && post.url) {
    container.innerHTML = `<img loading="lazy" src="${escapeAttr(post.url)}" alt="Post media" />`;
    return;
  }

  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview) {
    container.innerHTML = `<img loading="lazy" src="${escapeAttr(preview)}" alt="Post preview" />`;
    return;
  }

  const embed = post.secureMedia?.oembed?.html || post.media?.oembed?.html;
  if (embed) {
    container.innerHTML = decodeHtml(embed);
  }
}

function flattenComments(children, depth = 0) {
  const out = [];
  for (const child of children) {
    if (child.kind !== 't1') continue;
    const c = child.data;
    if (!c?.body || c.body === '[deleted]' || c.body === '[removed]') continue;
    out.push({ author: c.author, score: c.score, body: c.body, depth });
    const replies = c.replies?.data?.children;
    if (replies && depth < 2) out.push(...flattenComments(replies, depth + 1));
  }
  return out;
}

function renderComment(comment) {
  return `<article class="comment ${comment.depth ? 'reply' : ''}">
    <div class="comment-meta">${escapeHtml(comment.author)} · ${formatNumber(comment.score)} pts</div>
    <div class="comment-body">${escapeHtml(comment.body)}</div>
  </article>`;
}

function renderStatus(extra = []) {
  const badges = [];
  extra.forEach((text) => badges.push(`<span class="badge">${escapeHtml(text)}</span>`));
  if (state.errors.length) badges.push(`<span class="badge warning">${state.errors.length} fetch issue${state.errors.length > 1 ? 's' : ''}</span>`);
  if (state.posts.length) badges.push(`<span class="badge">Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`);
  els.statusBar.innerHTML = badges.join('');
}

function setLoading(loading) {
  els.refresh.disabled = loading;
  els.refresh.textContent = loading ? 'Refreshing…' : 'Refresh digest';
}

function formatNumber(n) {
  return Intl.NumberFormat('en-GB', { notation: n >= 10000 ? 'compact' : 'standard' }).format(n || 0);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }
function decodeHtml(html) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = html;
  return textarea.value;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const STOP_WORDS = new Set([
  'the','and','for','with','from','this','that','have','has','had','are','was','were','about','into','over','after','before','just','not','you','your','our','their','they','his','her','its','who','what','when','where','why','how','new','old','today','yesterday','thread','official','discussion','post','match','game','race','club','team','video','watch','reddit'
]);
