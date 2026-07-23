/*
 * Cloudflare Worker to scrape Telegram channel posts incrementally.
 * 
 * Setup Instructions:
 * 1. Create a Cloudflare KV Namespace (e.g., named `TELEGRAM_KV`).
 * 2. Bind it to this worker in your `wrangler.toml`:
 *    [[kv_namespaces]]
 *    binding = "TELEGRAM_KV"
 *    id = "your_kv_namespace_id_here"
 * 3. (Recommended) Add a Cron Trigger to run it automatically:
 *    [triggers]
 *    crons = ["15 * * * *"] Runs every 15 minutes to catch new posts or continue backfill
*/


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
      return new Response('State and text reset. Next scrape will start completely fresh.', { 
        headers: { 'content-type': 'text/plain' } 
      });
    }

    return new Response(
      'Telegram Channel Scraper\n\nEndpoints:\n- /scrape : Fetch and store posts (auto-resumes if interrupted)\n- /get    : Retrieve the combined text\n- /reset  : Clear all data and start fresh',
      { headers: { 'content-type': 'text/plain' } }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScrape(env));
  }
};

async function handleScrape(env) {
  const channelName = 'TribalAmbient';
  const baseUrl = `https://t.me/s/${channelName}`;
  
  // 1. Retrieve state
  const lastState = await env.TELEGRAM_KV.get('tribal_ambient_state', 'json') || {};
  let minPostId = lastState.minPostId || 0; // Oldest post we have
  let maxPostId = lastState.maxPostId || 0; // Newest post we have
  
  let newPosts = [];
  let iterations = 0;
  
  // DYNAMIC LIMITS: High enough to backfill, safe enough to avoid 30s timeout
  const MAX_ITERATIONS = 100; 
  const TIME_LIMIT_MS = 25000; // 25 seconds (leaves 5s buffer for KV writes and response)
  const startTime = Date.now();
  
  let currentUrl = baseUrl;
  let stopReason = 'Finished normally';

  while (iterations < MAX_ITERATIONS) {
    // ⏱️ SAFETY CHECK: Prevent Worker timeout
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      stopReason = `Time limit (${TIME_LIMIT_MS}ms) reached to prevent Worker timeout.`;
      break;
    }

    const response = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      stopReason = 'Failed to fetch page (channel might be private or deleted).';
      break;
    }

    const html = await response.text();
    
    // Regex to find post containers and their text content
    const regex = /<div[^>]*data-post="[^"]*\/(\d+)"[^>]*>[\s\S]*?<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    
    let match;
    let foundAny = false;
    let oldestPostIdOnPage = Infinity;
    let hitKnownPost = false;

    while ((match = regex.exec(html)) !== null) {
      foundAny = true;
      const postId = parseInt(match[1], 10);
      
      // CHECK: If we've reached a post ID we already have, STOP immediately.
      if (postId <= maxPostId) {
        hitKnownPost = true;
        stopReason = 'Caught up to previously saved posts.';
        break; 
      }
      
      let textHtml = match[2];
      const plainText = textHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (plainText.length > 0) {
        newPosts.push({ id: postId, text: plainText });
      }
      
      if (postId < oldestPostIdOnPage) {
        oldestPostIdOnPage = postId;
      }
    }

    if (hitKnownPost) break;
    if (!foundAny) {
      stopReason = 'Reached the beginning of the channel (no more posts).';
      break;
    }

    // Paginate to the next older batch
    currentUrl = `${baseUrl}?before=${oldestPostIdOnPage}`;
    iterations++;
  }

  if (newPosts.length > 0) {
    // Sort new posts by ID ascending (oldest new post first) to maintain chronological order
    newPosts.sort((a, b) => a.id - b.id);

    const existingData = await env.TELEGRAM_KV.get('tribal_ambient_posts', 'text');
    const newCombinedText = newPosts.map(p => `--- Post #${p.id} ---\n${p.text}`).join('\n\n');
    
    const finalText = existingData 
      ? `${existingData}\n\n${newCombinedText}` 
      : newCombinedText;

    // Store the updated combined text
    await env.TELEGRAM_KV.put('tribal_ambient_posts', finalText, { 
      metadata: { 
        lastUpdated: new Date().toISOString(), 
        totalPostsScraped: (finalText.match(/--- Post #/g) || []).length 
      } 
    });

    // Update the state boundaries
    const newlyScrapedMin = Math.min(...newPosts.map(p => p.id));
    const newlyScrapedMax = Math.max(...newPosts.map(p => p.id));
    
    const updatedMinPostId = minPostId === 0 ? newlyScrapedMin : Math.min(minPostId, newlyScrapedMin);
    const updatedMaxPostId = Math.max(maxPostId, newlyScrapedMax);

    await env.TELEGRAM_KV.put('tribal_ambient_state', JSON.stringify({ 
      minPostId: updatedMinPostId, 
      maxPostId: updatedMaxPostId 
    }));
  }

  const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
  
  return new Response(
    `✅ Scraped ${newPosts.length} NEW posts.\n` +
    `⏱️ Execution time: ${executionTime}s\n` +
    `🔄 Iterations used: ${iterations} / ${MAX_ITERATIONS}\n` +
    `📊 Tracking Post IDs: ${minPostId === 0 ? newlyScrapedMin : Math.min(minPostId, newlyScrapedMin || Infinity)} to ${Math.max(maxPostId, newlyScrapedMax || 0)}\n` +
    `🛑 Stopped because: ${stopReason}\n\n` +
    `${stopReason.includes('limit') ? '👉 ACTION: Trigger /scrape again to continue where it left off.\n' : ''}` +
    `Use the /get endpoint to view the combined text.`,
    { headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
}