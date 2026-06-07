const ALLOWED_SORTS = new Set(['top', 'hot']);
const MAX_LIMIT = 50;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=180, stale-while-revalidate=600'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'reddit-briefing-proxy' });
      }

      if (url.pathname === '/listing') {
        return await handleListing(url);
      }

      if (url.pathname === '/comments') {
        return await handleComments(url);
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 502);
    }
  }
};

async function handleListing(url) {
  const subreddit = sanitiseSubreddit(url.searchParams.get('subreddit'));
  const sort = ALLOWED_SORTS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'top';
  const time = url.searchParams.get('t') === 'week' ? 'week' : 'day';
  const limit = clampInteger(url.searchParams.get('limit'), 1, MAX_LIMIT, 25);

  if (!subreddit) return json({ error: 'Invalid subreddit' }, 400);

  const cacheKey = new Request(`https://cache.local/listing/${subreddit}/${sort}/${time}/${limit}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  let posts = [];
  let source = 'json';
  let lastError = null;

  for (const endpoint of redditListingEndpoints(subreddit, sort, time, limit)) {
    try {
      const payload = await fetchRedditJson(endpoint);
      posts = parseListing(payload);
      if (posts.length) break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!posts.length) {
    source = 'rss';
    for (const endpoint of redditRssEndpoints(subreddit, sort, time, limit)) {
      try {
        const xml = await fetchRedditText(endpoint);
        posts = parseAtomFeed(xml, subreddit);
        if (posts.length) break;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!posts.length) {
    throw new Error(lastError?.message || 'Reddit returned no posts');
  }

  const response = json({
    subreddit,
    sort,
    time,
    source,
    fetchedAt: new Date().toISOString(),
    posts
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

async function handleComments(url) {
  const subreddit = sanitiseSubreddit(url.searchParams.get('subreddit'));
  const id = sanitiseId(url.searchParams.get('id'));
  const limit = clampInteger(url.searchParams.get('limit'), 1, 20, 12);

  if (!subreddit || !id) return json({ error: 'Invalid subreddit or post id' }, 400);

  const endpoints = [
    `https://www.reddit.com/r/${subreddit}/comments/${id}.json?limit=${limit}&depth=2&sort=top&raw_json=1`,
    `https://old.reddit.com/r/${subreddit}/comments/${id}/.json?limit=${limit}&depth=2&sort=top&raw_json=1`
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchRedditJson(endpoint);
      return json({ comments: parseComments(payload, limit) });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'Comments were unavailable');
}

function redditListingEndpoints(subreddit, sort, time, limit) {
  const timePart = sort === 'top' ? `&t=${time}` : '';
  return [
    `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&raw_json=1${timePart}`,
    `https://www.reddit.com/r/${subreddit}/${sort}/.json?limit=${limit}&raw_json=1${timePart}`,
    `https://api.reddit.com/r/${subreddit}/${sort}?limit=${limit}&raw_json=1${timePart}`,
    `https://old.reddit.com/r/${subreddit}/${sort}/.json?limit=${limit}&raw_json=1${timePart}`
  ];
}

function redditRssEndpoints(subreddit, sort, time, limit) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top') params.set('t', time);
  const query = params.toString();
  return [
    `https://www.reddit.com/r/${subreddit}/${sort}/.rss?${query}`,
    `https://www.reddit.com/r/${subreddit}/${sort}.rss?${query}`,
    `https://old.reddit.com/r/${subreddit}/${sort}/.rss?${query}`
  ];
}

async function fetchRedditJson(url) {
  const response = await fetchWithRedditHeaders(url);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`Reddit HTTP ${response.status}`);
  if (!contentType.includes('json') && !contentType.includes('javascript')) {
    const text = await response.text();
    if (text.trim().startsWith('<')) throw new Error('Reddit returned HTML instead of JSON');
    return JSON.parse(text);
  }
  return response.json();
}

async function fetchRedditText(url) {
  const response = await fetchWithRedditHeaders(url);
  if (!response.ok) throw new Error(`Reddit RSS HTTP ${response.status}`);
  return response.text();
}

function fetchWithRedditHeaders(url) {
  return fetch(url, {
    headers: {
      'Accept': 'application/json, application/atom+xml;q=0.9, text/xml;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.8',
      'User-Agent': 'reddit-briefing/3.0 (public-read-only-digest)'
    },
    redirect: 'follow',
    cf: {
      cacheEverything: true,
      cacheTtl: 180
    }
  });
}

function parseListing(payload) {
  const children = payload?.data?.children;
  if (!Array.isArray(children)) throw new Error('Unexpected Reddit listing format');
  return children.map(item => normalisePost(item?.data)).filter(Boolean);
}

function normalisePost(post) {
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
    url: safeHttpUrl(post.url_overridden_by_dest || post.url || absoluteRedditUrl(post.permalink)),
    domain: cleanText(post.domain || ''),
    flair: cleanText(post.link_flair_text || ''),
    stickied: Boolean(post.stickied),
    spoiler: Boolean(post.spoiler),
    over18: Boolean(post.over_18),
    media: extractMedia(post)
  };
}

function extractMedia(post) {
  const redditVideo = post.secure_media?.reddit_video || post.media?.reddit_video;
  if (redditVideo?.fallback_url) {
    return {
      type: 'video',
      url: decodeEntities(redditVideo.fallback_url),
      poster: getPreviewImage(post)
    };
  }

  if (post.is_gallery && post.gallery_data?.items && post.media_metadata) {
    const images = post.gallery_data.items
      .map(item => post.media_metadata[item.media_id])
      .map(item => item?.s?.u || item?.s?.gif)
      .filter(Boolean)
      .map(decodeEntities)
      .slice(0, 8);
    if (images.length) return { type: 'gallery', images };
  }

  const destination = decodeEntities(post.url_overridden_by_dest || post.url || '');
  if (isImageUrl(destination) || post.post_hint === 'image') {
    return { type: 'image', url: destination || getPreviewImage(post) };
  }

  const youtubeId = getYouTubeId(destination);
  if (youtubeId) return { type: 'youtube', id: youtubeId };

  const preview = getPreviewImage(post);
  if (preview) return { type: 'image', url: preview, previewOnly: true };
  return { type: 'none' };
}

function getPreviewImage(post) {
  const image = post.preview?.images?.[0]?.source?.url;
  return image ? decodeEntities(image) : '';
}

function parseComments(payload, limit) {
  const children = payload?.[1]?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .filter(item => item.kind === 't1')
    .slice(0, limit)
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

function parseAtomFeed(xml, subreddit) {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return entries.map(entry => {
    const title = decodeEntities(extractTag(entry, 'title'));
    const link = decodeEntities(extractAttribute(entry, 'link', 'href'));
    const updated = extractTag(entry, 'updated') || extractTag(entry, 'published');
    const authorBlock = extractTag(entry, 'author');
    const author = decodeEntities(extractTag(authorBlock, 'name'));
    const content = decodeEntities(stripTags(extractTag(entry, 'content')));
    const id = extractPostId(link) || extractPostId(extractTag(entry, 'id'));
    const image = firstImageFromHtml(extractTag(entry, 'content'));

    if (!id || !title) return null;
    return {
      id,
      subreddit,
      title: cleanText(title),
      selftext: cleanText(content),
      author: cleanText(author.replace(/^\/u\//, '')),
      score: 0,
      numComments: 0,
      upvoteRatio: 0,
      createdUtc: updated ? Math.floor(new Date(updated).getTime() / 1000) : Math.floor(Date.now() / 1000),
      permalink: safeHttpUrl(link),
      url: safeHttpUrl(link),
      domain: 'reddit.com',
      flair: '',
      stickied: false,
      spoiler: false,
      over18: false,
      media: image ? { type: 'image', url: image, previewOnly: true } : { type: 'none' }
    };
  }).filter(Boolean);
}

function extractTag(source, tag) {
  if (!source) return '';
  const match = source.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function extractAttribute(source, tag, attribute) {
  const match = source.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? match[1] : '';
}

function firstImageFromHtml(html) {
  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? safeHttpUrl(decodeEntities(match[1])) : '';
}

function stripTags(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');
}

function cleanText(value) {
  return decodeEntities(value).replace(/\u0000/g, '').trim();
}

function absoluteRedditUrl(permalink) {
  if (!permalink) return '';
  return permalink.startsWith('http') ? safeHttpUrl(permalink) : `https://www.reddit.com${permalink}`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function sanitiseSubreddit(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9_]{2,32}$/.test(clean) ? clean : '';
}

function sanitiseId(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9]{3,16}$/.test(clean) ? clean : '';
}

function extractPostId(value) {
  const match = String(value || '').match(/\/comments\/([A-Za-z0-9]+)/i);
  return match ? match[1] : '';
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function isImageUrl(url) {
  return /\.(?:jpe?g|png|gif|webp)(?:\?.*)?$/i.test(url);
}

function getYouTubeId(value) {
  try {
    const url = new URL(value);
    if (url.hostname.includes('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] || '';
    if (url.hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
      return url.searchParams.get('v') || '';
    }
  } catch {
    return '';
  }
  return '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}
