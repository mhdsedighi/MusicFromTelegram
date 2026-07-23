/**
 * CLOUDFLARE WORKER: Telegram Channel SoundCloud & Hashtag Archive
 * 
 * Setup:
 * 1. Create a Cloudflare KV Namespace (e.g., `TELEGRAM_KV`).
 * 2. Bind it in `wrangler.toml`:
 *    [[kv_namespaces]]
 *    binding = "TELEGRAM_KV"
 *    id = "your_kv_namespace_id_here"
 * 3. (Recommended) Add a Cron Trigger to run automatically:
 *    [triggers]
 *    crons = ["15 * * * *"]
 */

// 🚫 HASHTAGS TO OMIT (One per line, NO commas, NO quotes)
// Add any generic, spam, or non-music tags you want to hide from the UI here.
const EXCLUDED_HASHTAGS = `
essay
thoughts
lyrics
quote
`;

// Convert the exclusion list into a fast-lookup Set (lowercase, trimmed)
const EXCLUDED_SET = new Set(
  EXCLUDED_HASHTAGS.split('\n')
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 0)
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(getHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/api/tracks') {
      const tracks = await env.TELEGRAM_KV.get('tribal_ambient_tracks', 'json') || [];
      return new Response(JSON.stringify(tracks), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/scrape') {
      return await handleScrape(env);
    }

    if (url.pathname === '/get') {
      const storedText = await env.TELEGRAM_KV.get('tribal_ambient_posts', 'text');
      return new Response(storedText || 'No data found. Run /scrape first.', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/reset') {
      await env.TELEGRAM_KV.delete('tribal_ambient_state');
      await env.TELEGRAM_KV.delete('tribal_ambient_posts');
      await env.TELEGRAM_KV.delete('tribal_ambient_tracks');
      return new Response('All data reset.', { headers: { 'content-type': 'text/plain' } });
    }

    return new Response('Endpoints: / (UI), /scrape, /get, /api/tracks, /reset', { headers: { 'content-type': 'text/plain' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScrape(env));
  }
};

async function handleScrape(env) {
  const channelName = 'TribalAmbient';
  const baseUrl = `https://t.me/s/${channelName}`;
  
  const lastState = await env.TELEGRAM_KV.get('tribal_ambient_state', 'json') || {};
  let minPostId = lastState.minPostId || 0; 
  let maxPostId = lastState.maxPostId || 0; 
  
  const existingTracksRaw = await env.TELEGRAM_KV.get('tribal_ambient_tracks', 'json');
  let existingTracks = Array.isArray(existingTracksRaw) ? existingTracksRaw : [];
  
  let newPostsText = [];
  let newTracks = [];
  let iterations = 0;
  
  const MAX_ITERATIONS = 100; 
  const TIME_LIMIT_MS = 25000; 
  const startTime = Date.now();
  
  let currentUrl = baseUrl;
  let stopReason = 'Finished normally';

  while (iterations < MAX_ITERATIONS) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      stopReason = `Time limit reached (${TIME_LIMIT_MS}ms).`;
      break;
    }

    const response = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      stopReason = 'Failed to fetch page.';
      break;
    }

    const html = await response.text();
    
    // 🛡️ ROBUST EXTRACTION: Find ALL post wrappers by their data-post attribute
    // This works even if the post has NO text (e.g., only a link preview or image)
    const postStarts = [...html.matchAll(/<div[^>]*data-post="[^"]*\/(\d+)"[^>]*>/g)];
    
    if (postStarts.length === 0) {
      stopReason = 'Reached the beginning of the channel (no posts found on page).';
      break;
    }

    let batchMinId = Infinity;
    let batchMaxId = -1;
    let hitKnownPost = false;

    for (let i = 0; i < postStarts.length; i++) {
      const postId = parseInt(postStarts[i][1], 10);
      
      // 🛑 CRITICAL CHECK: If we've reached a post ID we already have, STOP immediately.
      if (postId <= maxPostId) {
        hitKnownPost = true;
        stopReason = 'Caught up to previously saved posts.';
        break; 
      }

      // Track the boundaries of this specific batch
      if (postId < batchMinId) batchMinId = postId;
      if (postId > batchMaxId) batchMaxId = postId;

      // Extract the HTML chunk belonging to this specific post
      const startIndex = postStarts[i].index + postStarts[i][0].length;
      const endIndex = i < postStarts.length - 1 ? postStarts[i+1].index : html.length;
      const postHtml = html.substring(startIndex, endIndex);

      // 🎵 Extract SoundCloud links from this post's HTML
      const scRegex = /https?:\/\/(?:www\.)?soundcloud\.com\/[^\s<"']+/gi;
      const scLinks = [...new Set(postHtml.match(scRegex) || [])];

      // 🧹 Extract text (if it exists)
      let plainText = "";
      const textMatch = postHtml.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (textMatch) {
        plainText = textMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
      }

      // 🏷️ Dynamically extract ALL hashtags from plain text
      const hashRegex = /(?:^|\s)#([a-zA-Z0-9_]+)/g;
      const rawTags = new Set();
      let hashMatch;
      while ((hashMatch = hashRegex.exec(plainText)) !== null) {
        rawTags.add(hashMatch[1].toLowerCase());
      }

      // 🚫 FILTER: Keep only tags that are NOT in the exclusion list
      const validTags = [...rawTags].filter(tag => !EXCLUDED_SET.has(tag));

      if (plainText.length > 0) {
        newPostsText.push(`--- Post #${postId} ---\n${plainText}`);
      }

      // 💾 If it has SoundCloud links, save to tracks array WITH filtered tags
      if (scLinks.length > 0) {
        newTracks.push({
          postId: postId,
          hashtags: validTags,
          links: scLinks
        });
      }
    }

    if (hitKnownPost) break;

    // 📉 Paginate to the next older batch using the oldest post ID we just successfully processed
    currentUrl = `${baseUrl}?before=${batchMinId}`;
    iterations++;
  }

  // Save Combined Text
  if (newPostsText.length > 0) {
    newPostsText.sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    const existingData = await env.TELEGRAM_KV.get('tribal_ambient_posts', 'text');
    const finalText = existingData ? `${existingData}\n\n${newPostsText.join('\n\n')}` : newPostsText.join('\n\n');
    await env.TELEGRAM_KV.put('tribal_ambient_posts', finalText);
  }

  // Save Tracks JSON
  if (newTracks.length > 0 || existingTracks.length > 0) {
    const trackMap = new Map();
    existingTracks.forEach(t => trackMap.set(t.postId, t));
    newTracks.forEach(t => trackMap.set(t.postId, t));
    
    const mergedTracks = Array.from(trackMap.values());
    mergedTracks.sort((a, b) => b.postId - a.postId); // Newest first for UI
    
    await env.TELEGRAM_KV.put('tribal_ambient_tracks', JSON.stringify(mergedTracks));
  }

  // 🔄 ALWAYS UPDATE STATE if we processed any posts, even if they had no text/links.
  // This guarantees we never get stuck in an infinite loop or re-scrape the same page.
  if (batchMinId !== Infinity) {
    const updatedMin = minPostId === 0 ? batchMinId : Math.min(minPostId, batchMinId);
    const updatedMax = Math.max(maxPostId, batchMaxId);
    await env.TELEGRAM_KV.put('tribal_ambient_state', JSON.stringify({ minPostId: updatedMin, maxPostId: updatedMax }));
  }

  return new Response(
    `✅ Processed ${newPostsText.length} text posts.\n🎵 Found ${newTracks.length} new tracks.\n⏱️ Time: ${((Date.now() - startTime) / 1000).toFixed(2)}s\n🔄 Iterations: ${iterations}\n🛑 Reason: ${stopReason}`,
    { headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
}

// 🎨 HTML UI GENERATOR (Unchanged, dynamically reads filtered tags)
function getHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tribal Ambient Archive</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #121212; color: #e0e0e0; }
    h1 { color: #bb86fc; text-align: center; margin-bottom: 30px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 30px; justify-content: center; position: sticky; top: 0; background: #121212; padding: 15px 0; border-bottom: 1px solid #333; z-index: 10; }
    button { padding: 8px 16px; border: 1px solid #444; background: #2a2a2a; color: #e0e0e0; cursor: pointer; border-radius: 20px; font-size: 14px; transition: all 0.2s; }
    button:hover { background: #3a3a3a; border-color: #bb86fc; }
    button.active { background: #bb86fc; color: #121212; border-color: #bb86fc; font-weight: bold; }
    .track { margin-bottom: 25px; padding: 20px; border: 1px solid #333; border-radius: 12px; background: #1e1e1e; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    .track-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
    .track-tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag { background: #333; padding: 4px 10px; border-radius: 12px; font-size: 0.85em; color: #bb86fc; }
    .links a { display: block; color: #03dac6; text-decoration: none; margin-bottom: 8px; word-break: break-all; font-size: 1.1em; }
    .links a:hover { text-decoration: underline; }
    .loader { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
  <h1>🎧 Tribal Ambient Archive</h1>
  <div class="controls" id="controls">
    <button id="btn-all" class="active">All Hashtags</button>
  </div>
  <div id="tracks" class="loader">Loading tracks...</div>

  <script>
    let allTracks = [];
    let activeTags = new Set(['ALL']);

    async function init() {
      try {
        const res = await fetch('/api/tracks');
        allTracks = await res.json();
        renderControls();
        renderTracks();
      } catch (e) {
        document.getElementById('tracks').innerText = 'Error loading tracks. Run /scrape first.';
      }
    }

    function renderControls() {
      const controls = document.getElementById('controls');
      const allBtn = document.getElementById('btn-all');
      
      const allTags = new Set();
      allTracks.forEach(t => t.hashtags.forEach(tag => allTags.add(tag)));
      
      const sortedTags = Array.from(allTags).sort();
      
      sortedTags.forEach(tag => {
        const btn = document.createElement('button');
        btn.innerText = '#' + tag;
        btn.dataset.tag = tag;
        if (activeTags.has(tag)) btn.classList.add('active');
        btn.onclick = () => toggleTag(tag, btn);
        controls.appendChild(btn);
      });
      
      allBtn.onclick = () => toggleTag('ALL', allBtn);
    }

    function toggleTag(tag, btn) {
      if (tag === 'ALL') {
        activeTags.clear();
        activeTags.add('ALL');
        document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } else {
        activeTags.delete('ALL');
        document.getElementById('btn-all').classList.remove('active');
        if (activeTags.has(tag)) {
          activeTags.delete(tag);
          btn.classList.remove('active');
        } else {
          activeTags.add(tag);
          btn.classList.add('active');
        }
        if (activeTags.size === 0) {
          activeTags.add('ALL');
          document.getElementById('btn-all').classList.add('active');
        }
      }
      renderTracks();
    }

    function renderTracks() {
      const container = document.getElementById('tracks');
      container.innerHTML = '';
      container.className = '';
      
      let filtered = allTracks;
      if (!activeTags.has('ALL')) {
        filtered = allTracks.filter(t => t.hashtags.some(tag => activeTags.has(tag)));
      }
      
      if (filtered.length === 0) {
        container.innerHTML = '<div class="loader">No tracks found for selected tags.</div>';
        return;
      }
      
      filtered.forEach(t => {
        const div = document.createElement('div');
        div.className = 'track';
        const tagsHtml = t.hashtags.length > 0 
          ? t.hashtags.map(tag => \`<span class="tag">#\${tag}</span>\`).join('')
          : '<span class="tag" style="color:#888">No tags</span>';
        const linksHtml = t.links.map(link => \`<a href="\${link}" target="_blank" rel="noopener">\${link}</a>\`).join('');
        
        div.innerHTML = \`
          <div class="track-header">
            <div class="track-tags">\${tagsHtml}</div>
            <div class="track-id">Post #\${t.postId}</div>
          </div>
          <div class="links">\${linksHtml}</div>
        \`;
        container.appendChild(div);
      });
    }

    init();
  </script>
</body>
</html>`;
}