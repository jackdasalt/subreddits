
(function() {
  const statusEl = document.getElementById('status');
  const briefingsEl = document.getElementById('briefings');
  const metaEl = document.getElementById('meta');

  function normalise(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function sentenceSplit(text) {
    const s = normalise(text);
    if (!s) return [];
    return s.split(/(?<=[.!?])\s+/g).filter(Boolean);
  }

  const STOP = new Set([
    'the','a','an','and','or','but','if','to','of','for','in','on','at','by','from','with',
    'this','that','these','those','be','is','are','was','were','it','as','i','you','he','she',
    'they','we','me','him','her','them','my','your','their','our','its','has','have','had',
    'do','does','did','will','would','can','could','should','may','might','about','over',
    'under','after','before','just'
  ]);

  function words(text) {
    const s = normalise(text).toLowerCase();
    return s.match(/[a-z]{2,}/g) || [];
  }

  function summarise(posts, opts = {}) {
    const maxSentences = opts.maxSentences ?? 3;
    const maxHeadlines = opts.maxHeadlines ?? 3;

    // Prefer top posts; fallback to whatever
    const top = (posts || []).filter(p => p?.subreddit && p?.title);

    // Deduplicate by title
    const seenTitle = new Set();
    const dedup = [];
    for (const p of top) {
      const t = normalise(p.title).toLowerCase();
      if (t && !seenTitle.has(t)) {
        seenTitle.add(t);
        dedup.push(p);
      }
    }

    const corpus = dedup.map(p => {
      const title = normalise(p.title);
      const selftext = normalise(p.selftext);
      return {
        title,
        selftext,
        score: Number(p.score || 0),
        created: Number(p.createdUtc || 0)
      };
    });

    const combined = corpus.map(c => `${c.title}. ${c.selftext}`.trim()).join(' ');
    const sentences = sentenceSplit(combined);
    if (!sentences.length) {
      return {
        summary: 'No summary available (no readable content).',
        headlines: dedup.slice(0, maxHeadlines).map(p => normalise(p.title))
      };
    }

    // word frequency
    const freq = new Map();
    for (const w of words(combined)) {
      if (STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }

    const scored = sentences.map((sent, idx) => {
      const ws = words(sent);
      if (!ws.length) return { idx, sent, score: 0 };
      let s = 0;
      for (const w of ws) {
        if (STOP.has(w)) continue;
        s += freq.get(w) || 0;
      }
      // normalise by length to avoid run-on dominance
      s = s / Math.sqrt(ws.length);
      return { idx, sent: sent.trim(), score: s };
    });

    scored.sort((a, b) => b.score - a.score);
    const topN = scored.slice(0, maxSentences).filter(x => x.sent);
    // preserve original order for readability
    topN.sort((a, b) => a.idx - b.idx);

    const summary = topN.map(x => x.sent).join(' ');

    const headlines = dedup
      .slice()
      .sort((a, b) => Number(b.score||0) - Number(a.score||0))
      .slice(0, maxHeadlines)
      .map(p => normalise(p.title));

    return { summary: summary || 'No summary available.', headlines };
  }

  async function main() {
    try {
      const [digestRes, subsRes] = await Promise.all([
        fetch('data/digest.json', { cache: 'no-store' }),
        fetch('subreddits.json', { cache: 'no-store' })
      ]);

      if (!digestRes.ok) throw new Error(`digest.json: HTTP ${digestRes.status}`);
      if (!subsRes.ok) throw new Error(`subreddits.json: HTTP ${subsRes.status}`);

      const digest = await digestRes.json();
      const subsCfg = await subsRes.json();

      const subs = (subsCfg.subreddits || subsCfg || [])
        .map(x => (typeof x === 'string' ? { name: x, label: x } : x))
        .map(x => ({
          name: normalise(x.name || x.label || x.subreddit || ''),
          label: x.label ? normalise(x.label) : normalise(x.name || '')
        }))
        .filter(x => x.name);

      const topPosts = (digest.top || []).filter(p => p && p.subreddit);
      // group by subreddit
      const bySub = new Map();
      for (const p of topPosts) {
        const key = normalise(p.subreddit).toLowerCase();
        if (!key) continue;
        if (!bySub.has(key)) bySub.set(key, []);
        bySub.get(key).push(p);
      }

      const briefings = [];
      for (const cfg of subs) {
        const key = cfg.name.toLowerCase().replace(/^r\//,'');
        const posts = bySub.get(key) || [];
        const { summary, headlines } = summarise(posts, { maxSentences: 3, maxHeadlines: 4 });
        briefings.push({
          label: cfg.label || cfg.name,
          name: cfg.name,
          summary,
          headlines
        });
      }

      // sort: the subs with the most posts first, then alphabetically
      briefings.sort((a, b) => {
        const ac = (bySub.get(a.name.toLowerCase()) || []).length;
        const bc = (bySub.get(b.name.toLowerCase()) || []).length;
        if (bc !== ac) return bc - ac;
        return a.label.localeCompare(b.label, 'en');
      });

      // render
      briefingsEl.innerHTML = '';
      for (const b of briefings) {
        const card = document.createElement('article');
        card.className = 'card';
        card.innerHTML = `
          <h3>${escapeHtml(b.label)}</h3>
          <p class="briefing">${escapeHtml(b.summary)}</p>
          <ol class="headlines">
            ${b.headlines.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
          </ol>
        `;
        briefingsEl.appendChild(card);
      }

      metaEl.innerHTML = `Generated at <strong>${escapeHtml(digest.generatedAt || '')}</strong>
      (top posts in digest: ${topPosts.length})`;
      statusEl.textContent = 'Ready.';
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'Failed to load data. Make sure data/digest.json and subreddits.json exist in the repo.';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  main();
})();
