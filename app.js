(() => {
  'use strict';

  const CACHE_KEY = 'reddit-briefing-cache-v3';
  const SETTINGS_KEY = 'reddit-briefing-settings-v3';
  const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 16000;

  const state = {
    config: null,
    settings: {
      apiBase: '',
      postsPerSubreddit: 5,
      showMedia: true
    },
    sort: 'top',
    filter: 'all',
    posts: [],
    failures: [],
    loading: false,
    fetchedAt: null,
    source: 'live'
  };

  const elements = {
    refreshButton: document.querySelector('#refreshButton'),
    settingsButton: document.querySelector('#settingsButton'),
    emptySettingsButton: document.querySelector('#emptySettingsButton'),
    statusDot: document.querySelector('#statusDot'),
    statusText: document.querySelector('#statusText'),
    updatedText: document.querySelector('#updatedText'),
    heroSummary: document.querySelector('#heroSummary'),
    overviewTitle: document.querySelector('#overviewTitle'),
    overviewCopy: document.querySelector('#overviewCopy'),
    subredditFilters: document.querySelector('#subredditFilters'),
    briefingGrid: document.querySelector('#briefingGrid'),
    emptyState: document.querySelector('#emptyState'),
    emptyMessage: document.querySelector('#emptyMessage'),
    settingsDialog: document.querySelector('#settingsDialog'),
    apiBaseInput: document.querySelector('#apiBaseInput'),
    postsPerSubInput: document.querySelector('#postsPerSubInput'),
    showMediaInput: document.querySelector('#showMediaInput'),
    saveSettingsButton: document.querySelector('#saveSettingsButton'),
    detailsDialog: document.querySelector('#detailsDialog'),
    detailsCommunity: document.querySelector('#detailsCommunity'),
    detailsTitle: document.querySelector('#detailsTitle'),
    detailsBody: document.querySelector('#detailsBody'),
    closeDetailsButton: document.querySelector('#closeDetailsButton'),
    skeletonTemplate: document.querySelector('#skeletonTemplate')
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();

    let deployment = {};
    try {
      deployment = await fetchJsonWithTimeout('deployment.json', 8000);
    } catch {
      deployment = {};
    }

    state.settings = {
      ...state.settings,
      ...deployment,
      ...readJsonStorage(SETTINGS_KEY)
    };

    try {
      state.config = await fetchJsonWithTimeout('subreddits.json', 8000);
    } catch (error) {
      showFatal('The subreddits.json file could not be loaded. Make sure all files were uploaded together.');
      return;
    }

    state.settings.apiBase = normaliseApiBase(state.settings.apiBase || '');
    state.settings.postsPerSubreddit = Number(
      state.settings.postsPerSubreddit || state.config.postsPerSubreddit || 5
    );
    renderFilters();
    syncSettingsForm();
    await loadBriefing({ force: false });
  }

  function bindEvents() {
    elements.refreshButton.addEventListener('click', () => loadBriefing({ force: true }));
    elements.settingsButton.addEventListener('click', openSettings);
    elements.emptySettingsButton.addEventListener('click', openSettings);
    elements.saveSettingsButton.addEventListener('click', saveSettings);
    elements.closeDetailsButton.addEventListener('click', () => elements.detailsDialog.close());

    document.querySelectorAll('[data-sort]').forEach(button => {
      button.addEventListener('click', async () => {
        if (state.loading || button.dataset.sort === state.sort) return;
        state.sort = button.dataset.sort;
        document.querySelectorAll('[data-sort]').forEach(item => {
          item.classList.toggle('is-active', item === button);
        });
        await loadBriefing({ force: false });
      });
    });
  }

  function openSettings() {
    syncSettingsForm();
    elements.settingsDialog.showModal();
  }

  function syncSettingsForm() {
    elements.apiBaseInput.value = state.settings.apiBase || '';
    elements.postsPerSubInput.value = String(state.settings.postsPerSubreddit || 5);
    elements.showMediaInput.checked = state.settings.showMedia !== false;
  }

  async function saveSettings() {
    state.settings = {
      apiBase: normaliseApiBase(elements.apiBaseInput.value),
      postsPerSubreddit: Number(elements.postsPerSubInput.value),
      showMedia: elements.showMediaInput.checked
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    elements.settingsDialog.close();
    await loadBriefing({ force: true });
  }

  async function loadBriefing({ force }) {
    if (state.loading) return;

    const previous = {
      posts: state.posts,
      fetchedAt: state.fetchedAt,
      source: state.source,
      failures: state.failures
    };

    state.loading = true;
    state.failures = [];
    state.posts = [];
    state.fetchedAt = null;
    state.source = 'live';
    setLoadingUi();

    const cache = readJsonStorage(CACHE_KEY);
    const cacheKey = buildCacheKey();
    const matchingCache = cache && cache.key === cacheKey ? cache : null;

    if (!force) {
      try {
        const snapshot = await loadPublishedSnapshot();
        if (snapshot.posts.length) {
          state.posts = snapshot.posts;
          state.fetchedAt = snapshot.fetchedAt;
          state.failures = snapshot.failures;
          state.source = 'snapshot';
          saveBrowserCache(cacheKey);
          state.loading = false;
          renderAll();
          return;
        }
      } catch {
        // The published snapshot is optional during local development.
      }

      if (matchingCache && Date.now() - matchingCache.savedAt < CACHE_MAX_AGE_MS) {
        applyCachedBriefing(matchingCache);
        state.loading = false;
        renderAll();
        return;
      }
    }

    const subreddits = state.config.subreddits || [];
    const results = await mapWithConcurrency(subreddits, 3, async subreddit => {
      try {
        const posts = await fetchSubredditListing(subreddit.name);
        return { subreddit, posts };
      } catch (error) {
        state.failures.push({ subreddit: subreddit.name, message: error.message });
        return { subreddit, posts: [] };
      }
    });

    const rawPosts = results.flatMap(result => result.posts);
    const freshPosts = rawPosts
      .filter(post => isFreshEnough(post.createdUtc))
      .filter(post => !post.stickied)
      .filter(post => !isLowSignalRecurringThread(post.title));

    state.posts = selectAndDedupe(freshPosts, state.settings.postsPerSubreddit);
    state.fetchedAt = new Date().toISOString();

    if (state.posts.length) {
      state.source = 'live';
      saveBrowserCache(cacheKey);
    } else if (previous.posts.length) {
      state.posts = previous.posts;
      state.fetchedAt = previous.fetchedAt;
      state.source = 'retained';
      state.failures = state.failures.length ? state.failures : previous.failures;
    } else if (matchingCache && Date.now() - matchingCache.savedAt < CACHE_MAX_AGE_MS) {
      applyCachedBriefing(matchingCache);
    }

    state.loading = false;
    renderAll();
  }

  async function loadPublishedSnapshot() {
    const payload = await fetchJsonWithTimeout(`data/digest.json?v=${Date.now()}`, 8000);
    const listing = Array.isArray(payload?.[state.sort]) ? payload[state.sort] : [];
    const posts = listing
      .map(normaliseWorkerPost)
      .filter(Boolean)
      .filter(post => !post.stickied)
      .filter(post => !isLowSignalRecurringThread(post.title));

    return {
      posts: selectAndDedupe(posts, state.settings.postsPerSubreddit),
      fetchedAt: payload.generatedAt || new Date().toISOString(),
      failures: Array.isArray(payload.failures)
        ? payload.failures.filter(item => !item.sort || item.sort === state.sort)
        : []
    };
  }

  function saveBrowserCache(cacheKey) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      key: cacheKey,
      savedAt: Date.now(),
      fetchedAt: state.fetchedAt,
      posts: state.posts
    }));
  }

  function applyCachedBriefing(cache) {
    state.posts = Array.isArray(cache.posts) ? cache.posts : [];
    state.fetchedAt = cache.fetchedAt || new Date(cache.savedAt).toISOString();
    state.source = 'cached';
  }

  function buildCacheKey() {
    const names = (state.config?.subreddits || []).map(item => item.name).join(',');
    return `${names}|${state.sort}|${state.settings.postsPerSubreddit}`;
  }

  async function fetchSubredditListing(subreddit) {
    const limit = Math.max(18, state.settings.postsPerSubreddit * 4);

    if (state.settings.apiBase) {
      const url = new URL(`${state.settings.apiBase}/listing`);
      url.searchParams.set('subreddit', subreddit);
      url.searchParams.set('sort', state.sort);
      url.searchParams.set('t', 'day');
      url.searchParams.set('limit', String(limit));
      const payload = await fetchJsonWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
      const posts = Array.isArray(payload.posts) ? payload.posts : [];
      return posts.map(normaliseWorkerPost).filter(Boolean);
    }

    const directUrl = buildRedditListingUrl(subreddit, limit);

    try {
      const payload = await jsonp(directUrl, REQUEST_TIMEOUT_MS);
      return parseRedditListing(payload);
    } catch (jsonpError) {
      try {
        const payload = await fetchJsonWithTimeout(directUrl, REQUEST_TIMEOUT_MS);
        return parseRedditListing(payload);
      } catch (fetchError) {
        throw new Error(`Direct Reddit access failed: ${fetchError.message}`);
      }
    }
  }

  function buildRedditListingUrl(subreddit, limit) {
    const sort = state.sort === 'hot' ? 'hot' : 'top';
    const url = new URL(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('raw_json', '1');
    if (sort === 'top') url.searchParams.set('t', 'day');
    return url.toString();
  }

  function parseRedditListing(payload) {
    const children = payload?.data?.children;
    if (!Array.isArray(children)) throw new Error('Reddit returned an unexpected listing format.');
    return children.map(item => normaliseRedditPost(item?.data)).filter(Boolean);
  }

  function normaliseRedditPost(post) {
    if (!post?.id || !post?.title) return null;
    return {
      id: String(post.id),
      subreddit: String(post.subreddit || ''),
      title: cleanText(post.title),
      selftext: cleanText(post.selftext || ''),
      author: cleanText(post.author || ''),
      score: Number(post.score || post.ups || 0),
      numComments: Number(post.num_comments || 0),
      upvoteRatio: Number(post.upvote_ratio || 0),
      createdUtc: Number(post.created_utc || 0),
      permalink: absoluteRedditUrl(post.permalink),
      url: safeUrl(post.url_overridden_by_dest || post.url || absoluteRedditUrl(post.permalink)),
      domain: cleanText(post.domain || ''),
      flair: cleanText(post.link_flair_text || ''),
      stickied: Boolean(post.stickied),
      spoiler: Boolean(post.spoiler),
      over18: Boolean(post.over_18),
      media: extractMedia(post)
    };
  }

  function normaliseWorkerPost(post) {
    if (!post?.id || !post?.title) return null;
    return {
      id: String(post.id),
      subreddit: String(post.subreddit || ''),
      title: cleanText(post.title),
      selftext: cleanText(post.selftext || ''),
      author: cleanText(post.author || ''),
      score: Number(post.score || 0),
      numComments: Number(post.numComments || 0),
      upvoteRatio: Number(post.upvoteRatio || 0),
      createdUtc: Number(post.createdUtc || 0),
      permalink: safeUrl(post.permalink),
      url: safeUrl(post.url),
      domain: cleanText(post.domain || ''),
      flair: cleanText(post.flair || ''),
      stickied: Boolean(post.stickied),
      spoiler: Boolean(post.spoiler),
      over18: Boolean(post.over18),
      media: normaliseMedia(post.media)
    };
  }

  function extractMedia(post) {
    const media = { type: 'none' };
    const redditVideo = post.secure_media?.reddit_video || post.media?.reddit_video;

    if (redditVideo?.fallback_url) {
      return {
        type: 'video',
        url: decodeHtml(redditVideo.fallback_url),
        poster: getPreviewImage(post)
      };
    }

    if (post.is_gallery && post.gallery_data?.items && post.media_metadata) {
      const images = post.gallery_data.items
        .map(item => post.media_metadata[item.media_id])
        .map(item => item?.s?.u || item?.s?.gif)
        .filter(Boolean)
        .map(decodeHtml)
        .slice(0, 8);
      if (images.length) return { type: 'gallery', images };
    }

    const destination = decodeHtml(post.url_overridden_by_dest || post.url || '');
    if (isImageUrl(destination) || post.post_hint === 'image') {
      return { type: 'image', url: destination || getPreviewImage(post) };
    }

    const youtubeId = getYouTubeId(destination);
    if (youtubeId) return { type: 'youtube', id: youtubeId };

    const preview = getPreviewImage(post);
    if (preview) return { type: 'image', url: preview, previewOnly: true };

    return media;
  }

  function normaliseMedia(media) {
    if (!media || typeof media !== 'object') return { type: 'none' };
    if (media.type === 'gallery') {
      return { type: 'gallery', images: (media.images || []).map(safeUrl).filter(Boolean) };
    }
    if (media.type === 'youtube') return { type: 'youtube', id: String(media.id || '') };
    if (['image', 'video'].includes(media.type)) {
      return {
        type: media.type,
        url: safeUrl(media.url),
        poster: safeUrl(media.poster),
        previewOnly: Boolean(media.previewOnly)
      };
    }
    return { type: 'none' };
  }

  function getPreviewImage(post) {
    const image = post.preview?.images?.[0]?.source?.url;
    return image ? decodeHtml(image) : '';
  }

  function selectAndDedupe(posts, perSubreddit) {
    const ranked = posts
      .map(post => ({ ...post, rankScore: calculateRank(post) }))
      .sort((a, b) => b.rankScore - a.rankScore);

    const selected = [];
    const subredditCounts = new Map();

    for (const candidate of ranked) {
      const currentCount = subredditCounts.get(candidate.subreddit.toLowerCase()) || 0;
      if (currentCount >= perSubreddit) continue;
      if (selected.some(existing => areNearDuplicates(existing, candidate))) continue;
      selected.push(candidate);
      subredditCounts.set(candidate.subreddit.toLowerCase(), currentCount + 1);
    }

    return selected;
  }

  function calculateRank(post) {
    const ageHours = Math.max(0, (Date.now() / 1000 - post.createdUtc) / 3600);
    const freshness = Math.max(0.25, 1 - ageHours / 32);
    const engagement = Math.log10(Math.max(1, post.score + 1)) * 3.2
      + Math.log10(Math.max(1, post.numComments + 1)) * 2.4;
    const quality = post.upvoteRatio ? Math.max(0.65, post.upvoteRatio) : 0.85;
    const selftextBonus = post.selftext.length > 120 ? 0.45 : 0;
    return engagement * freshness * quality + selftextBonus;
  }

  function areNearDuplicates(a, b) {
    if (a.id === b.id) return true;
    const aUrl = canonicalUrl(a.url);
    const bUrl = canonicalUrl(b.url);
    if (aUrl && bUrl && aUrl === bUrl) return true;

    const tokensA = titleTokens(a.title);
    const tokensB = titleTokens(b.title);
    if (!tokensA.size || !tokensB.size) return false;

    let intersection = 0;
    tokensA.forEach(token => { if (tokensB.has(token)) intersection += 1; });
    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = intersection / union;
    const containment = intersection / Math.min(tokensA.size, tokensB.size);
    return jaccard >= 0.64 || containment >= 0.82;
  }

  function titleTokens(title) {
    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'from',
      'is', 'are', 'was', 'were', 'be', 'this', 'that', 'after', 'before', 'as', 'by', 'via'
    ]);
    return new Set(normaliseTitle(title)
      .split(' ')
      .filter(token => token.length > 2 && !stopwords.has(token)));
  }

  function normaliseTitle(title) {
    return title
      .toLowerCase()
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      url.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(key => {
        url.searchParams.delete(key);
      });
      return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.replace(/\/$/, '').toLowerCase();
    } catch {
      return '';
    }
  }

  function isFreshEnough(createdUtc) {
    if (!createdUtc) return true;
    return Date.now() - createdUtc * 1000 <= DAY_MS + 60 * 60 * 1000;
  }

  function isLowSignalRecurringThread(title) {
    return /^(daily|weekly) (discussion|general discussion|free talk)|simple questions thread|off[- ]topic thread/i.test(title.trim());
  }

  function renderAll() {
    renderStatus();
    renderOverview();
    renderFilters();
    renderCards();
  }

  function setLoadingUi() {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = 'Refreshing…';
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = `Reading ${state.config?.subreddits?.length || 0} communities…`;
    elements.updatedText.textContent = '';
    elements.emptyState.hidden = true;
    elements.briefingGrid.hidden = false;
    elements.briefingGrid.replaceChildren();
    for (let i = 0; i < 6; i += 1) {
      elements.briefingGrid.append(elements.skeletonTemplate.content.cloneNode(true));
    }
  }

  function renderStatus() {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = 'Refresh briefing';

    if (state.posts.length) {
      elements.statusDot.className = 'status-dot ok';
      const failedPart = state.failures.length ? ` · ${state.failures.length} unavailable` : '';
      const sourceLabel = {
        live: 'Live briefing',
        snapshot: 'Published briefing',
        cached: 'Cached briefing',
        retained: 'Previous briefing retained'
      }[state.source] || 'Briefing';
      elements.statusText.textContent = `${sourceLabel} · ${state.posts.length} distinct stories${failedPart}`;
      elements.updatedText.textContent = state.fetchedAt ? `Updated ${formatRelativeTime(new Date(state.fetchedAt))}` : '';
    } else {
      elements.statusDot.className = 'status-dot error';
      elements.statusText.textContent = 'No stories were received';
      elements.updatedText.textContent = '';
    }
  }

  function renderOverview() {
    if (!state.posts.length) {
      elements.overviewTitle.textContent = 'No briefing could be built';
      elements.overviewCopy.replaceChildren(paragraph(
        state.settings.apiBase
          ? 'The published snapshot and configured proxy did not return usable posts. Check the deployment logs and proxy URL.'
          : 'The published data file is empty and direct Reddit access was blocked. Run the included GitHub Pages workflow or configure the optional Worker.'
      ));
      return;
    }

    const visible = getVisiblePosts();
    const communities = new Set(visible.map(post => post.subreddit));
    elements.overviewTitle.textContent = `${visible.length} distinct stories across ${communities.size} communities`;
    elements.overviewCopy.replaceChildren();

    const grouped = groupBy(visible.slice(0, Math.min(12, visible.length)), post => post.subreddit);
    const groups = [...grouped.entries()].slice(0, 5);

    groups.forEach(([subreddit, posts]) => {
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `r/${subreddit}: `;
      p.append(strong, document.createTextNode(posts.slice(0, 3).map(post => headlineSentence(post.title)).join(' ')));
      elements.overviewCopy.append(p);
    });
  }

  function renderFilters() {
    if (!state.config) return;
    elements.subredditFilters.replaceChildren();

    const allButton = makeFilterButton('all', 'All');
    elements.subredditFilters.append(allButton);

    for (const subreddit of state.config.subreddits || []) {
      elements.subredditFilters.append(makeFilterButton(subreddit.name.toLowerCase(), subreddit.label || `r/${subreddit.name}`));
    }
  }

  function makeFilterButton(value, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-button${state.filter === value ? ' is-active' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      state.filter = value;
      renderFilters();
      renderOverview();
      renderCards();
    });
    return button;
  }

  function getVisiblePosts() {
    return state.filter === 'all'
      ? state.posts
      : state.posts.filter(post => post.subreddit.toLowerCase() === state.filter);
  }

  function renderCards() {
    elements.briefingGrid.replaceChildren();
    const posts = getVisiblePosts();

    if (!posts.length) {
      elements.briefingGrid.hidden = true;
      elements.emptyState.hidden = false;
      elements.emptyMessage.textContent = state.failures.length
        ? `${state.failures.length} community requests failed. Check the Pages workflow, or use the included Worker for live access.`
        : 'There are no recent posts for this filter.';
      return;
    }

    elements.emptyState.hidden = true;
    elements.briefingGrid.hidden = false;
    posts.forEach((post, index) => elements.briefingGrid.append(createStoryCard(post, index === 0 && state.filter === 'all')));
  }

  function createStoryCard(post, featured) {
    const article = document.createElement('article');
    article.className = `story-card${featured ? ' featured' : ''}`;

    const copy = document.createElement('div');
    copy.className = 'story-copy';

    const meta = document.createElement('div');
    meta.className = 'story-meta';

    const community = document.createElement('span');
    community.className = 'community-pill';
    community.textContent = `r/${post.subreddit}`;
    meta.append(community);

    if (post.flair) meta.append(document.createTextNode(post.flair));
    meta.append(document.createTextNode(`${formatNumber(post.score)} points · ${formatNumber(post.numComments)} comments · ${formatAge(post.createdUtc)}`));

    const title = document.createElement('h3');
    title.textContent = post.title;

    const summary = document.createElement('p');
    summary.className = 'story-summary';
    summary.textContent = summarisePost(post);

    const actions = document.createElement('div');
    actions.className = 'story-actions';

    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.className = 'story-action';
    detailsButton.textContent = 'Details and comments';
    detailsButton.addEventListener('click', () => openDetails(post));
    actions.append(detailsButton);

    const sourceLink = document.createElement('a');
    sourceLink.className = 'story-action secondary';
    sourceLink.href = post.url || post.permalink;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = post.domain && !post.domain.includes('reddit') ? 'Open source' : 'Open post';
    actions.append(sourceLink);

    copy.append(meta, title, summary, actions);

    const media = state.settings.showMedia ? createMedia(post.media, post.title) : null;
    if (featured && media) article.append(copy, media);
    else {
      article.append(copy);
      if (media) article.append(media);
    }

    return article;
  }

  function summarisePost(post) {
    const text = post.selftext.trim();
    if (text && text !== '[removed]' && text !== '[deleted]') {
      return truncateAtSentence(text, 280);
    }

    const context = post.flair ? `${post.flair}. ` : '';
    const engagement = post.numComments >= 100
      ? `It has prompted substantial discussion, with ${formatNumber(post.numComments)} comments.`
      : `It is among the strongest community signals from the past 24 hours.`;
    return `${context}${engagement}`;
  }

  function createMedia(media, alt) {
    if (!media || media.type === 'none') return null;
    const frame = document.createElement('div');
    frame.className = 'media-frame';

    if (media.type === 'image' && media.url) {
      const image = document.createElement('img');
      image.src = media.url;
      image.alt = alt;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => frame.remove(), { once: true });
      frame.append(image);
      return frame;
    }

    if (media.type === 'video' && media.url) {
      const video = document.createElement('video');
      video.src = media.url;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      if (media.poster) video.poster = media.poster;
      frame.append(video);
      return frame;
    }

    if (media.type === 'youtube' && media.id) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(media.id)}`;
      iframe.title = alt;
      iframe.loading = 'lazy';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      frame.append(iframe);
      return frame;
    }

    if (media.type === 'gallery' && media.images?.length) {
      const gallery = document.createElement('div');
      gallery.className = 'gallery';
      media.images.forEach((url, index) => {
        const image = document.createElement('img');
        image.src = url;
        image.alt = `${alt} — image ${index + 1}`;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        gallery.append(image);
      });
      frame.append(gallery);
      return frame;
    }

    return null;
  }

  async function openDetails(post) {
    elements.detailsCommunity.textContent = `r/${post.subreddit}`;
    elements.detailsTitle.textContent = post.title;
    elements.detailsBody.replaceChildren();

    const story = document.createElement('section');
    story.className = 'details-story';
    story.append(paragraph(post.selftext || summarisePost(post)));

    const storyMeta = paragraph(`${formatNumber(post.score)} points · ${formatNumber(post.numComments)} comments · posted ${formatAge(post.createdUtc)}`);
    storyMeta.className = 'comment-meta';
    story.append(storyMeta);

    const link = document.createElement('a');
    link.className = 'story-action secondary';
    link.href = post.url || post.permalink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open original source';
    story.append(link);

    elements.detailsBody.append(story);
    const commentsHeading = document.createElement('h3');
    commentsHeading.className = 'comments-heading';
    commentsHeading.textContent = 'Top comments';
    elements.detailsBody.append(commentsHeading, paragraph('Loading comments…'));
    elements.detailsDialog.showModal();

    try {
      const comments = await fetchComments(post);
      renderComments(commentsHeading, comments);
    } catch (error) {
      const message = paragraph(`Comments could not be loaded: ${error.message}`);
      message.className = 'comment-body';
      replaceFollowingContent(commentsHeading, message);
    }
  }

  async function fetchComments(post) {
    if (state.settings.apiBase) {
      const url = new URL(`${state.settings.apiBase}/comments`);
      url.searchParams.set('subreddit', post.subreddit);
      url.searchParams.set('id', post.id);
      url.searchParams.set('limit', '12');
      const payload = await fetchJsonWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
      return Array.isArray(payload.comments) ? payload.comments : [];
    }

    const url = new URL(`https://www.reddit.com/comments/${encodeURIComponent(post.id)}.json`);
    url.searchParams.set('limit', '12');
    url.searchParams.set('depth', '2');
    url.searchParams.set('sort', 'top');
    url.searchParams.set('raw_json', '1');

    let payload;
    try {
      payload = await jsonp(url.toString(), REQUEST_TIMEOUT_MS);
    } catch {
      payload = await fetchJsonWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
    }
    return parseRedditComments(payload);
  }

  function parseRedditComments(payload) {
    const children = payload?.[1]?.data?.children;
    if (!Array.isArray(children)) return [];
    return children
      .filter(item => item.kind === 't1')
      .slice(0, 12)
      .map(item => normaliseComment(item.data, 0))
      .filter(Boolean);
  }

  function normaliseComment(comment, depth) {
    if (!comment?.body || ['[removed]', '[deleted]'].includes(comment.body)) return null;
    const replies = Array.isArray(comment.replies?.data?.children)
      ? comment.replies.data.children
        .filter(item => item.kind === 't1')
        .slice(0, depth === 0 ? 3 : 0)
        .map(item => normaliseComment(item.data, depth + 1))
        .filter(Boolean)
      : [];
    return {
      author: cleanText(comment.author || 'unknown'),
      body: cleanText(comment.body),
      score: Number(comment.score || 0),
      replies
    };
  }

  function renderComments(heading, comments) {
    const fragment = document.createDocumentFragment();
    if (!comments.length) {
      fragment.append(paragraph('No accessible comments were returned for this post.'));
    } else {
      comments.forEach(comment => fragment.append(createCommentNode(comment)));
    }
    replaceFollowingContent(heading, fragment);
  }

  function replaceFollowingContent(heading, content) {
    let node = heading.nextSibling;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    elements.detailsBody.append(content);
  }

  function createCommentNode(comment) {
    const article = document.createElement('article');
    article.className = 'comment';
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    meta.textContent = `u/${comment.author} · ${formatNumber(comment.score)} points`;
    const body = document.createElement('p');
    body.className = 'comment-body';
    body.textContent = comment.body;
    article.append(meta, body);
    (comment.replies || []).forEach(reply => article.append(createCommentNode(reply)));
    return article;
  }

  function jsonp(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const callbackName = `__redditBriefing_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const target = new URL(url);
      target.searchParams.set('jsonp', callbackName);

      let settled = false;
      const cleanup = () => {
        delete window[callbackName];
        script.remove();
      };

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('The public feed timed out.'));
      }, timeoutMs);

      window[callbackName] = data => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        reject(new Error('The public feed was blocked.'));
      };
      script.src = target.toString();
      document.head.append(script);
    });
  }

  async function fetchJsonWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Request timed out.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  function showFatal(message) {
    state.loading = false;
    state.posts = [];
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Configuration error';
    elements.overviewTitle.textContent = 'The app could not start';
    elements.overviewCopy.replaceChildren(paragraph(message));
    elements.briefingGrid.hidden = true;
    elements.emptyState.hidden = false;
    elements.emptyMessage.textContent = message;
  }

  function paragraph(text) {
    const p = document.createElement('p');
    p.textContent = text;
    return p;
  }

  function groupBy(items, keyFn) {
    const map = new Map();
    items.forEach(item => {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return map;
  }

  function headlineSentence(title) {
    const clean = title.trim().replace(/[.!?]+$/, '');
    return clean ? `${clean}.` : '';
  }

  function truncateAtSentence(text, maxLength) {
    const cleaned = cleanText(text).replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    const clipped = cleaned.slice(0, maxLength);
    const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
    return `${clipped.slice(0, sentenceEnd > maxLength * 0.45 ? sentenceEnd + 1 : maxLength).trim()}…`;
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\u0000/g, '')
      .trim();
  }

  function decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value || '');
    return textarea.value;
  }

  function absoluteRedditUrl(permalink) {
    if (!permalink) return '';
    return permalink.startsWith('http') ? safeUrl(permalink) : `https://www.reddit.com${permalink}`;
  }

  function safeUrl(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
      const url = new URL(input, window.location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function normaliseApiBase(value) {
    const safe = safeUrl(value.trim());
    return safe.replace(/\/$/, '');
  }

  function isImageUrl(url) {
    return /\.(?:jpe?g|png|gif|webp)(?:\?.*)?$/i.test(url);
  }

  function getYouTubeId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('youtu.be')) return parsed.pathname.split('/').filter(Boolean)[0] || '';
      if (parsed.hostname.includes('youtube.com')) {
        if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || '';
        return parsed.searchParams.get('v') || '';
      }
      return '';
    } catch {
      return '';
    }
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('en-GB', { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
  }

  function formatAge(createdUtc) {
    const minutes = Math.max(1, Math.floor((Date.now() / 1000 - createdUtc) / 60));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatRelativeTime(date) {
    const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  function readJsonStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
})();
