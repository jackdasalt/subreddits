const DIGEST_URL = 'data/digest.json';
const CONFIG_URL = 'subreddits.json';

const state = {
  digest: null,
  config: null,
  activeSubreddit: 'all'
};

const $ = (selector) => document.querySelector(selector);
const els = {
  refresh: $('#refreshButton'),
  settings: $('#settingsButton'),
  panel: $('#settingsPanel'),
  subredditList: $('#subredditList'),
  sourceField: $('#sourceField'),
  generatedField: $('#generatedField'),
  overviewTitle: $('#overviewTitle'),
  overviewText: $('#overviewText'),
  overviewBullets: $('#overviewBullets'),
  themeCloud: $('#themeCloud'),
  statusBar: $('#statusBar'),
  tabs: $('#subredditTabs'),
  grid: $('#digestGrid'),
  template: $('#postCardTemplate')
};

init();

async function init() {
  bindEvents();
  await loadEverything();
}

function bindEvents() {
  els.refresh.addEventListener('click', async () => {
    els.refresh.disabled = true;
    els.refresh.textContent = 'Reloading…';
    await loadEverything(true);
    els.refresh.disabled = false;
    els.refresh.textContent = 'Reload digest';
  });

  els.settings.addEventListener('click', () => {
    const hidden = els.panel.classList.toggle('hidden');
    els.settings.setAttribute('aria-expanded', String(!hidden));
  });
}

async function loadEverything(cacheBust = false) {
  try {
    const suffix = cacheBust ? `?t=${Date.now()}` : '';
    const [digest, config] = await Promise.all([
      fetchJson(`${DIGEST_URL}${suffix}`),
      fetchJson(`${CONFIG_URL}${suffix}`).catch(() => null)
    ]);
    state.digest = digest;
    state.config = config;
    state.activeSubreddit = 'all';
    renderAll();
  } catch (error) {
    renderFatal(error);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function renderAll() {
  renderSettings();
  renderOverview();
  renderStatus();
  renderTabs();
  renderGrid(filteredPosts());
}

function renderSettings() {
  const subreddits = state.config?.subreddits || state.digest?.subreddits || [];
  els.subredditList.value = subreddits.map((sub) => `r/${sub}`).join('\n');
  els.sourceField.value = state.digest?.source || 'Not generated yet';
  els.generatedField.value = state.digest?.generatedAt ? formatDateTime(state.digest.generatedAt) : 'Not generated yet';
}

function renderOverview() {
  const summary = state.digest?.summary || {};
  els.overviewTitle.textContent = summary.title || 'No digest available';
  els.overviewText.textContent = summary.text || 'Run the GitHub Action to generate data/digest.json.';
  els.overviewBullets.innerHTML = (summary.bullets || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  els.themeCloud.innerHTML = (summary.themes || []).map((theme) => `<span class="theme">${escapeHtml(theme)}</span>`).join('');
}

function renderStatus() {
  const posts = state.digest?.posts || [];
  const errors = state.digest?.errors || [];
  const badges = [];
  badges.push(`<span class="badge">${posts.length} selected posts</span>`);
  if (state.digest?.generatedAt) badges.push(`<span class="badge">Generated ${formatRelativeTime(state.digest.generatedAt)}</span>`);
  if (state.digest?.source) badges.push(`<span class="badge">Source: ${escapeHtml(state.digest.source)}</span>`);
  if (errors.length) badges.push(`<span class="badge warning">${errors.length} build issue${errors.length === 1 ? '' : 's'}</span>`);
  els.statusBar.innerHTML = badges.join('');
}

function renderTabs() {
  const posts = state.digest?.posts || [];
  const counts = new Map();
  posts.forEach((post) => counts.set(post.subreddit, (counts.get(post.subreddit) || 0) + 1));
  const subs = ['all', ...[...counts.keys()].sort((a, b) => a.localeCompare(b))];
  els.tabs.innerHTML = subs.map((sub) => {
    const label = sub === 'all' ? `All (${posts.length})` : `r/${sub} (${counts.get(sub)})`;
    return `<button class="tab ${state.activeSubreddit === sub ? 'active' : ''}" data-subreddit="${escapeAttr(sub)}">${escapeHtml(label)}</button>`;
  }).join('');

  els.tabs.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeSubreddit = button.dataset.subreddit;
      renderTabs();
      renderGrid(filteredPosts());
    });
  });
}

function filteredPosts() {
  const posts = state.digest?.posts || [];
  return state.activeSubreddit === 'all' ? posts : posts.filter((post) => post.subreddit === state.activeSubreddit);
}

function renderGrid(posts) {
  els.grid.innerHTML = '';
  if (!posts.length) {
    els.grid.innerHTML = `<div class="empty-state">${state.digest?.generatedAt ? 'No posts to show for this filter.' : 'No generated posts yet. Run the GitHub Action once, then reload this page.'}</div>`;
    return;
  }

  posts.forEach((post) => {
    const node = els.template.content.cloneNode(true);
    const card = node.querySelector('.post-card');
    card.querySelector('.subreddit').textContent = `r/${post.subreddit}`;
    card.querySelector('.flair').textContent = post.flair ? `· ${post.flair}` : '';
    card.querySelector('.age').textContent = post.createdIso ? `· ${formatRelativeTime(post.createdIso)}` : '';
    card.querySelector('h3').textContent = post.title;
    card.querySelector('.post-summary').textContent = post.summary || '';
    card.querySelector('.score').textContent = `${formatNumber(post.score)} pts`;
    card.querySelector('.comment-count').textContent = `${formatNumber(post.commentCount)} comments`;
    card.querySelector('.ratio').textContent = `${Math.round((post.upvoteRatio || 0) * 100)}% upvoted`;
    card.querySelector('.domain').textContent = post.domain ? post.domain : '';
    card.querySelector('.source-link').href = post.redditUrl || '#';
    renderMedia(card.querySelector('.media-slot'), post.media || []);

    const commentsButton = card.querySelector('.comments-button');
    const comments = card.querySelector('.comments');
    commentsButton.addEventListener('click', () => {
      const hidden = comments.classList.toggle('hidden');
      if (!hidden && !comments.dataset.loaded) {
        comments.innerHTML = renderComments(post);
        comments.dataset.loaded = 'true';
      }
      commentsButton.textContent = hidden ? 'Show top comments' : 'Hide top comments';
    });

    els.grid.appendChild(node);
  });
}

function renderMedia(container, media) {
  if (!media.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = media.slice(0, 5).map((item) => {
    if (item.type === 'image') {
      return `<figure class="media-item"><img loading="lazy" src="${escapeAttr(item.url)}" alt="Post media"></figure>`;
    }
    if (item.type === 'video') {
      return `<figure class="media-item"><video controls preload="metadata" ${item.poster ? `poster="${escapeAttr(item.poster)}"` : ''} src="${escapeAttr(item.url)}"></video>${item.note ? `<p class="media-note">${escapeHtml(item.note)}</p>` : ''}</figure>`;
    }
    if (item.type === 'embed' && item.html) {
      return `<figure class="media-item embed-wrap">${sanitiseEmbedHtml(item.html)}</figure>`;
    }
    if (item.thumbnail) {
      return `<figure class="media-item"><img loading="lazy" src="${escapeAttr(item.thumbnail)}" alt="Embed thumbnail"></figure>`;
    }
    return '';
  }).join('');
}

function renderComments(post) {
  if (post.commentError) {
    return `<p class="post-summary">Comments could not be loaded during the build: ${escapeHtml(post.commentError)}</p>`;
  }
  if (!post.comments?.length) {
    return '<p class="post-summary">No comments were captured for this post.</p>';
  }
  return post.comments.map((comment) => `
    <article class="comment ${comment.depth ? 'reply' : ''}">
      <div class="comment-meta">${escapeHtml(comment.author)} · ${formatNumber(comment.score)} pts${comment.depth ? ` · reply level ${comment.depth}` : ''}</div>
      <div class="comment-body">${escapeHtml(comment.body)}</div>
    </article>
  `).join('');
}

function renderFatal(error) {
  els.overviewTitle.textContent = 'Digest data could not be loaded';
  els.overviewText.textContent = `The site could not read data/digest.json: ${error.message}. Run the GitHub Action or check that the data folder was uploaded.`;
  els.overviewBullets.innerHTML = '';
  els.themeCloud.innerHTML = '';
  els.statusBar.innerHTML = '<span class="badge warning">Missing or invalid digest data</span>';
  els.tabs.innerHTML = '';
  els.grid.innerHTML = '<div class="empty-state">No local digest file is available.</div>';
}

function sanitiseEmbedHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowedTags = new Set(['IFRAME', 'BLOCKQUOTE', 'A', 'DIV', 'SPAN', 'P', 'BR', 'IMG']);
  const allowedAttrs = new Set(['src', 'href', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'loading', 'referrerpolicy', 'class', 'style', 'alt']);

  template.content.querySelectorAll('*').forEach((node) => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (!allowedAttrs.has(name) || /^javascript:/i.test(value)) node.removeAttribute(attr.name);
    });
    if (node.tagName === 'IFRAME') {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.setAttribute('allowfullscreen', 'true');
    }
  });

  return template.innerHTML;
}

function formatNumber(n) {
  return Intl.NumberFormat('en-GB', { notation: n >= 10000 ? 'compact' : 'standard' }).format(n || 0);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function formatRelativeTime(value) {
  const diffSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  if (abs < 60) return rtf.format(diffSeconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
  return rtf.format(Math.round(diffSeconds / 86400), 'day');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
