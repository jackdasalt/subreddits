import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'subreddits.json');
const DATA_DIR = path.join(ROOT, 'data');
const DIGEST_PATH = path.join(DATA_DIR, 'digest.json');
const LOG_PATH = path.join(DATA_DIR, 'last-build-log.json');

const STOP_WORDS = new Set([
  'the','and','for','with','from','this','that','have','has','had','are','was','were','about','into','over','after','before','just','not','you','your','our','their','they','his','her','its','who','what','when','where','why','how','new','old','today','yesterday','thread','official','discussion','post','match','game','race','club','team','video','watch','reddit','live','daily','weekly','result','results','report','round','season','league','cup','goal','goals','player','players','said','says','now','can','will','would','should','could','again'
]);

const defaultSettings = {
  listing: 'top',
  timeFilter: 'day',
  includeHotFallback: true,
  postLimitPerSubreddit: 35,
  commentLimitPerPost: 10,
  replyDepth: 2,
  maxPostsShown: 28,
  duplicateSimilarityThreshold: 0.48,
  requestDelayMs: 850,
  minimumScore: 10,
  minimumComments: 3,
  hideNsfw: true,
  userAgent: 'reddit-digest-github-pages/2.0'
};

await main();

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const errors = [];

  try {
    const config = await readConfig();
    const settings = { ...defaultSettings, ...(config.settings || {}) };
    const subreddits = unique((config.subreddits || []).map(normaliseSubreddit).filter(Boolean));
    const reddit = await createRedditClient(settings, errors);

    const candidates = [];
    for (const subreddit of subreddits) {
      try {
        let posts = await reddit.fetchPosts(subreddit, settings.listing, settings.timeFilter, settings.postLimitPerSubreddit);

        if ((!posts.length || posts.every((post) => !isRecentEnough(post))) && settings.includeHotFallback) {
          const hotPosts = await reddit.fetchPosts(subreddit, 'hot', null, settings.postLimitPerSubreddit);
          posts = mergePosts(posts, hotPosts);
        }

        candidates.push(...posts.map((post) => normalisePost(post, subreddit)));
        await delay(settings.requestDelayMs);
      } catch (error) {
        errors.push({ subreddit, stage: 'posts', message: error.message });
      }
    }

    const ranked = candidates
      .filter((post) => isRecentEnough(post))
      .filter((post) => !settings.hideNsfw || !post.over18)
      .filter((post) => post.score >= settings.minimumScore || post.commentCount >= settings.minimumComments)
      .sort((a, b) => relevanceScore(b) - relevanceScore(a));

    const selected = dedupePosts(ranked, settings.duplicateSimilarityThreshold)
      .slice(0, settings.maxPostsShown);

    for (const post of selected) {
      try {
        const rawComments = await reddit.fetchComments(post.permalink, settings.commentLimitPerPost);
        post.comments = flattenComments(rawComments, settings.replyDepth).slice(0, settings.commentLimitPerPost);
        post.commentThemes = extractThemesFromText(post.comments.map((comment) => comment.body).join(' '), 6);
        await delay(settings.requestDelayMs);
      } catch (error) {
        post.comments = [];
        post.commentThemes = [];
        post.commentError = error.message;
        errors.push({ subreddit: post.subreddit, postId: post.id, stage: 'comments', message: error.message });
      }
      post.summary = summarisePost(post);
    }

    const digest = {
      generatedAt: new Date().toISOString(),
      source: `${settings.listing}${settings.timeFilter ? `/${settings.timeFilter}` : ''} with a 24-hour freshness filter${settings.includeHotFallback ? ' and hot fallback' : ''}`,
      subreddits,
      settingsUsed: {
        listing: settings.listing,
        timeFilter: settings.timeFilter,
        postLimitPerSubreddit: settings.postLimitPerSubreddit,
        maxPostsShown: settings.maxPostsShown,
        commentLimitPerPost: settings.commentLimitPerPost,
        duplicateSimilarityThreshold: settings.duplicateSimilarityThreshold
      },
      summary: buildDigestSummary(selected, subreddits, candidates, errors),
      posts: selected,
      errors
    };

    await fs.writeFile(DIGEST_PATH, JSON.stringify(digest, null, 2) + '\n');
    await fs.writeFile(LOG_PATH, JSON.stringify({
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      fetchedCandidates: candidates.length,
      selectedPosts: selected.length,
      errors
    }, null, 2) + '\n');

    console.log(`Digest built: ${selected.length} posts from ${subreddits.length} subreddits. Errors: ${errors.length}.`);
  } catch (error) {
    const log = {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      message: error.message,
      stack: error.stack
    };
    await fs.writeFile(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
    console.error(error);
    process.exitCode = 1;
  }
}

async function readConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

async function createRedditClient(settings, errors) {
  const userAgent = process.env.REDDIT_USER_AGENT || settings.userAgent;
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  let accessToken = null;
  if (clientId && clientSecret) {
    try {
      accessToken = await getAppOnlyToken(clientId, clientSecret, userAgent);
      console.log('Using OAuth application-only Reddit access.');
    } catch (error) {
      errors.push({ stage: 'oauth', message: `Could not obtain OAuth token; falling back to public JSON: ${error.message}` });
    }
  } else {
    console.log('No Reddit OAuth secrets found. Using public .json endpoints.');
  }

  return {
    async fetchPosts(subreddit, listing, timeFilter, limit) {
      const safeListing = ['top', 'hot', 'new', 'rising'].includes(listing) ? listing : 'top';
      const search = new URLSearchParams({ limit: String(limit), raw_json: '1' });
      if (safeListing === 'top' && timeFilter) search.set('t', timeFilter);
      const route = `/r/${encodeURIComponent(subreddit)}/${safeListing}.json?${search}`;
      const json = await redditRequest(route, { accessToken, userAgent });
      return json?.data?.children?.map((child) => child.data).filter(Boolean) || [];
    },

    async fetchComments(permalink, limit) {
      const cleanPermalink = permalink.startsWith('/') ? permalink : `/${permalink}`;
      const search = new URLSearchParams({ limit: String(limit), sort: 'top', raw_json: '1' });
      const route = `${cleanPermalink.replace(/\/$/, '')}.json?${search}`;
      const json = await redditRequest(route, { accessToken, userAgent });
      return json?.[1]?.data?.children || [];
    }
  };
}

async function getAppOnlyToken(clientId, clientSecret, userAgent) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const json = await response.json();
  if (!json.access_token) throw new Error('No access_token in OAuth response');
  return json.access_token;
}

async function redditRequest(route, { accessToken, userAgent }) {
  const base = accessToken ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const response = await fetch(`${base}${route}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    }
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
  }
  if (!contentType.includes('json')) {
    const body = await response.text().catch(() => '');
    throw new Error(`Expected JSON but received ${contentType || 'unknown content type'} — ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  return response.json();
}

function normalisePost(data, fallbackSubreddit) {
  const media = extractMedia(data);
  return {
    id: data.id,
    subreddit: data.subreddit || fallbackSubreddit,
    title: stripHtml(data.title || 'Untitled'),
    flair: data.link_flair_text || '',
    selftext: stripHtml(data.selftext || ''),
    url: data.url_overridden_by_dest || data.url || '',
    permalink: data.permalink || '',
    redditUrl: `https://www.reddit.com${data.permalink || ''}`,
    score: data.score || 0,
    upvoteRatio: data.upvote_ratio || 0,
    commentCount: data.num_comments || 0,
    createdUtc: data.created_utc || 0,
    createdIso: data.created_utc ? new Date(data.created_utc * 1000).toISOString() : null,
    ageMinutes: data.created_utc ? Math.round((Date.now() - data.created_utc * 1000) / 60000) : null,
    domain: data.domain || '',
    author: data.author || '',
    over18: Boolean(data.over_18),
    spoiler: Boolean(data.spoiler),
    isStickied: Boolean(data.stickied),
    media,
    comments: [],
    commentThemes: []
  };
}

function extractMedia(data) {
  const media = [];
  const secureMedia = data.secure_media || data.media || {};
  const redditVideo = secureMedia?.reddit_video;

  if (redditVideo?.fallback_url) {
    media.push({
      type: 'video',
      provider: 'reddit',
      url: redditVideo.fallback_url,
      poster: firstPreviewImage(data),
      note: redditVideo.is_gif ? 'Reddit-hosted GIF/video' : 'Reddit-hosted video'
    });
  }

  const url = data.url_overridden_by_dest || data.url || '';
  if (url.match(/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i)) {
    media.push({ type: 'image', provider: data.domain || 'image', url: decodeEntities(url) });
  }

  if (url.match(/\.gifv(\?.*)?$/i)) {
    media.push({ type: 'video', provider: 'gifv', url: decodeEntities(url.replace(/\.gifv(\?.*)?$/i, '.mp4')) });
  }

  const gallery = extractGallery(data);
  media.push(...gallery);

  const preview = firstPreviewImage(data);
  if (!media.length && preview) {
    media.push({ type: 'image', provider: 'preview', url: preview });
  }

  const oembed = secureMedia?.oembed;
  if (oembed?.html) {
    media.push({
      type: 'embed',
      provider: oembed.provider_name || data.domain || 'embed',
      html: decodeEntities(oembed.html),
      thumbnail: decodeEntities(oembed.thumbnail_url || '')
    });
  }

  return dedupeMedia(media);
}

function extractGallery(data) {
  const metadata = data.media_metadata || {};
  const order = data.gallery_data?.items?.map((item) => item.media_id) || Object.keys(metadata);
  const items = [];
  for (const id of order) {
    const item = metadata[id];
    if (!item) continue;
    const source = item.s?.u || item.s?.gif || item.s?.mp4;
    if (!source) continue;
    const url = decodeEntities(source);
    items.push({
      type: item.e === 'AnimatedImage' || url.includes('.mp4') ? 'video' : 'image',
      provider: 'reddit-gallery',
      url
    });
  }
  return items;
}

function firstPreviewImage(data) {
  const url = data.preview?.images?.[0]?.source?.url || data.preview?.images?.[0]?.resolutions?.at(-1)?.url || '';
  return decodeEntities(url);
}

function dedupeMedia(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.html || item.thumbnail;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenComments(children, maxDepth, depth = 0) {
  const out = [];
  for (const child of children || []) {
    if (child.kind !== 't1') continue;
    const data = child.data;
    if (!data?.body || data.body === '[deleted]' || data.body === '[removed]') continue;
    out.push({
      id: data.id,
      author: data.author || 'unknown',
      score: data.score || 0,
      body: stripMarkdown(stripHtml(data.body || '')).slice(0, 1800),
      depth,
      permalink: data.permalink ? `https://www.reddit.com${data.permalink}` : ''
    });
    const replies = data.replies?.data?.children;
    if (replies && depth < maxDepth) {
      out.push(...flattenComments(replies, maxDepth, depth + 1));
    }
  }
  return out;
}

function summarisePost(post) {
  const bits = [];
  const titleSentence = ensureSentence(post.title);
  bits.push(titleSentence);

  const context = [];
  if (post.flair) context.push(`Flair: ${post.flair}`);
  if (post.domain && !post.domain.startsWith('self.')) context.push(`source: ${post.domain}`);
  if (post.media.length) context.push(`${post.media.length} media item${post.media.length === 1 ? '' : 's'}`);
  context.push(`${formatCompact(post.score)} points`);
  context.push(`${formatCompact(post.commentCount)} comments`);
  bits.push(context.join(' · ') + '.');

  const bodySummary = summariseText(post.selftext, 180);
  if (bodySummary) bits.push(bodySummary);
  if (post.commentThemes.length) bits.push(`Comment themes: ${post.commentThemes.join(', ')}.`);
  return bits.join(' ');
}

function buildDigestSummary(posts, subreddits, candidates, errors) {
  if (!posts.length) {
    return {
      title: 'No digest could be built',
      text: candidates.length
        ? 'Reddit returned candidate posts, but none passed the 24-hour, minimum-score, minimum-comment and duplicate filters.'
        : 'No accessible candidate posts were returned. Check the build log, Reddit access, and optional OAuth secrets.',
      bullets: errors.slice(0, 5).map((error) => `${error.subreddit ? `r/${error.subreddit}: ` : ''}${error.stage}: ${error.message}`),
      themes: []
    };
  }

  const bySub = groupBy(posts, (post) => post.subreddit);
  const busiest = Object.entries(bySub)
    .map(([subreddit, items]) => ({ subreddit, posts: items.length, comments: items.reduce((sum, post) => sum + post.commentCount, 0) }))
    .sort((a, b) => b.comments - a.comments)
    .slice(0, 4);
  const themes = extractThemesFromText(posts.map((post) => `${post.title} ${post.selftext} ${post.commentThemes.join(' ')}`).join(' '), 10);
  const topItems = posts.slice(0, 5).map((post) => `r/${post.subreddit}: ${post.title}`);

  return {
    title: `${posts.length} notable, non-duplicate posts from the past 24 hours`,
    text: `The digest scanned ${candidates.length} candidate posts across ${subreddits.length} subreddits, ranked them by score, comment volume and upvote ratio, then removed near-duplicates. The busiest areas by comment volume were ${busiest.map((item) => `r/${item.subreddit}`).join(', ')}.`,
    bullets: topItems,
    themes
  };
}

function relevanceScore(post) {
  const hoursOld = Math.max((Date.now() - post.createdUtc * 1000) / 36e5, 0.25);
  const freshnessBoost = Math.max(0.25, 1.25 - hoursOld / 30);
  return (post.score + post.commentCount * 4 + Math.round(post.upvoteRatio * 200)) * freshnessBoost;
}

function isRecentEnough(post) {
  if (!post.createdUtc) return false;
  const ageMs = Date.now() - post.createdUtc * 1000;
  return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000 + 30 * 60 * 1000;
}

function dedupePosts(posts, threshold) {
  const selected = [];
  for (const post of posts) {
    const duplicate = selected.some((existing) => {
      if (post.url && existing.url && post.url === existing.url) return true;
      const titleSimilarity = jaccard(tokenSet(post.title), tokenSet(existing.title));
      return titleSimilarity >= threshold;
    });
    if (!duplicate) selected.push(post);
  }
  return selected;
}

function tokenList(text) {
  return String(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function tokenSet(text) {
  return new Set(tokenList(text));
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / union.size;
}

function extractThemesFromText(text, count) {
  const map = new Map();
  for (const token of tokenList(text)) map.set(token, (map.get(token) || 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([word]) => word);
}

function mergePosts(a, b) {
  const map = new Map();
  for (const post of [...a, ...b]) map.set(post.id, post);
  return [...map.values()];
}

function unique(values) {
  return [...new Set(values)];
}

function normaliseSubreddit(value) {
  return String(value).trim().replace(/^r\//i, '').replace(/^\//, '').replace(/[^a-zA-Z0-9_]/g, '');
}

function formatCompact(value) {
  return Intl.NumberFormat('en-GB', { notation: value >= 10000 ? 'compact' : 'standard' }).format(value || 0);
}

function stripHtml(value) {
  return decodeEntities(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value) {
  return String(value)
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function summariseText(text, maxLength) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return ensureSentence(clean);
  const sentence = clean.match(/[^.!?]+[.!?]+/)?.[0]?.trim();
  const clipped = sentence && sentence.length <= maxLength ? sentence : `${clean.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}…`;
  return ensureSentence(clipped);
}

function ensureSentence(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  return /[.!?…]$/.test(clean) ? clean : `${clean}.`;
}

function groupBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
