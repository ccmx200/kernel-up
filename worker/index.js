// ==================== 配置项 ====================
const CONFIG = {
  githubRepo: "ccmx200/kernel-up",
  releaseTag: "v7.0",
  pageTitle: "小米 Raphael (K20 Pro) 定制内核镜像",
  githubRepoUrl: "https://github.com/ccmx200/kernel-up",
  releaseCacheTTL: 86400,    // Release 信息缓存 1 天
  assetCacheTTL: 2592000,    // .deb 缓存 30 天
  scriptCacheTTL: 86400,     // 脚本缓存 1 天
  pageCacheTTL: 3600,        // 首页 HTML 缓存 1 小时
  cronMaxRetries: 2,         // 定时任务重试次数
};

// ==================== ESM 核心导出 ====================
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, ctx);
  },
  
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warmUpCache(ctx));
  }
};

// ==================== 核心路由处理 ====================
async function handleRequest(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. 首页：利用 Cloudflare 原生缓存
  if (path === "/" || path === "") {
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;

    let cached = await cache.match(cacheKey);
    if (cached) return cached;

    const content = await generateContent(ctx);
    const html = generateHtml(content);
    
    // 增加安全响应头，提升服务质量评级
    const response = new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${CONFIG.pageCacheTTL}`,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-XSS-Protection": "1; mode=block",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // 2. 代理下载 .deb、.7z 或 脚本
  if (path.endsWith(".deb") || path.endsWith(".7z") || path === "/Update-kernel.sh") {
    return proxyDownload(request, path, ctx);
  }

  return new Response("Not Found", { status: 404 });
}

// ==================== 数据获取（利用原生缓存）====================
async function fetchReleaseInfo(ctx) {
  const apiUrl = `https://api.github.com/repos/${CONFIG.githubRepo}/releases/tags/kernel-${CONFIG.releaseTag}`;
  const req = new Request(apiUrl, {
    headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Cloudflare-Worker" },
  });

  const cache = caches.default;
  let cached = await cache.match(req);

  if (cached) {
    try { return parseReleaseData(await cached.json()); } catch (e) {}
  }

  try {
    const resp = await fetch(req);
    if (!resp.ok) return null;

    const data = await resp.json();
    const cacheResp = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CONFIG.releaseCacheTTL}`,
      },
    });

    ctx.waitUntil(cache.put(req, cacheResp));
    return parseReleaseData(data);
  } catch (e) {
    console.error("Release fetch failed:", e);
    return null;
  }
}

function parseReleaseData(data) {
  const body = data.body || "";
  const buildTimeMatch = body.match(/构建时间:\s*(.+)/);
  const buildIdMatch = body.match(/构建 ID:\s*(.+)/);
  return {
    version: CONFIG.releaseTag,
    buildTime: buildTimeMatch ? buildTimeMatch[1].trim() : null,
    buildId: buildIdMatch ? buildIdMatch[1].trim() : null,
    publishedAt: data.published_at,
    assets: data.assets || [],
  };
}

// ==================== 代理下载 ====================
async function proxyDownload(request, path, ctx) {
  const isDeb = path.endsWith(".deb");
  const is7z = path.endsWith(".7z");
  const method = request.method.toUpperCase();

  const isAsset = isDeb || is7z;
  const targetUrl = isAsset
    ? `https://github.com/${CONFIG.githubRepo}/releases/download/kernel-${CONFIG.releaseTag}${path}`
    : `https://raw.githubusercontent.com/${CONFIG.githubRepo}/HEAD/Update-kernel.sh`;

  const cacheKey = new Request(targetUrl, { method: "GET" });
  const ttl = isAsset ? CONFIG.assetCacheTTL : CONFIG.scriptCacheTTL;
  const cache = caches.default;

  let cached = await cache.match(cacheKey);
  if (cached) {
    const respHeaders = new Headers(cached.headers);
    respHeaders.set("X-Cache", "HIT");
    if (isAsset) respHeaders.set("Content-Disposition", "attachment");

    if (method === "HEAD") {
      return new Response(null, { status: cached.status, headers: respHeaders });
    }
    return new Response(cached.body, { status: cached.status, headers: respHeaders });
  }

  const proxyHeaders = new Headers({ "User-Agent": "Cloudflare-Worker" });

  try {
    const resp = await fetch(targetUrl, {
      method: "GET",
      headers: proxyHeaders,
      redirect: "follow",
    });

    if (resp.status !== 200) {
      return new Response(resp.body, { status: resp.status, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    const clientHeaders = new Headers(resp.headers);
    clientHeaders.set("Access-Control-Allow-Origin", "*");
    clientHeaders.set("Accept-Ranges", "bytes");
    clientHeaders.set("X-Cache", "MISS");
    if (isAsset) clientHeaders.set("Content-Disposition", "attachment");

    const clonedResp = resp.clone();
    const cacheHeaders = new Headers(clonedResp.headers);
    cacheHeaders.set("Cache-Control", `public, max-age=${ttl}`);
    if (isAsset) cacheHeaders.set("Content-Disposition", "attachment");

    const cacheObj = new Response(clonedResp.body, { status: 200, headers: cacheHeaders });
    ctx.waitUntil(cache.put(cacheKey, cacheObj));

    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: clientHeaders });
    }

    return new Response(resp.body, { status: 200, headers: clientHeaders });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

// ==================== 定时预缓存任务 ====================
async function warmUpCache(ctx) {
  const info = await fetchReleaseInfo(ctx);
  if (!info?.assets?.length) return;

  const assetsToCache = info.assets.filter(a => a.name.endsWith(".deb") || a.name.endsWith(".7z"));
  const cache = caches.default;

  for (const asset of assetsToCache) {
    const downloadUrl = asset.browser_download_url;
    const cacheKey = new Request(downloadUrl, { method: "GET" });

    if (await cache.match(cacheKey)) continue;

    for (let retry = 0; retry < CONFIG.cronMaxRetries; retry++) {
      try {
        const resp = await fetch(downloadUrl, { headers: { "User-Agent": "Cloudflare-Worker-Cron" }, redirect: "follow" });
        if (!resp.ok) continue;

        const cacheHeaders = new Headers(resp.headers);
        cacheHeaders.set("Cache-Control", `public, max-age=${CONFIG.assetCacheTTL}`);
        cacheHeaders.set("Content-Disposition", "attachment");

        await cache.put(cacheKey, new Response(resp.body, { status: 200, headers: cacheHeaders }));
        break;
      } catch (e) {}
    }
  }
}

// ==================== 页面生成逻辑 ====================
function formatDate(d) {
  return d ? new Date(d).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知";
}

function getRelativeTime(d) {
  if (!d) return "";
  const diff = Date.now() - new Date(d);
  const h = Math.floor(diff / 36e5);
  const days = Math.floor(h / 24);
  if (days > 0) return `${days} 天前`;
  if (h > 0) return `${h} 小时前`;
  return "刚刚";
}

async function generateContent(ctx) {
  const info = await fetchReleaseInfo(ctx);

  const buildHtml = info ? `
    <div class="stats">
      <div class="stat"><div class="stat-label">内核版本</div><div class="stat-value text-gradient">${info.version}</div></div>
      <div class="stat"><div class="stat-label">构建时间</div><div class="stat-value">${info.buildTime || formatDate(info.publishedAt)}</div></div>
      <div class="stat"><div class="stat-label">发布时间</div><div class="stat-value">${getRelativeTime(info.publishedAt)}</div></div>
      <div class="stat"><div class="stat-label">构建 ID</div><div class="stat-value id-text">${info.buildId || "-"}</div></div>
    </div>` : `
    <div class="stats error-state">
      <div class="stat-error">⚠️ 暂时无法获取最新构建数据，请稍后刷新重试</div>
    </div>`;

  return `
    <header class="hero">
      <div class="icon-wrapper">🐧</div>
      <h1>小米 Raphael 内核 <span>${CONFIG.releaseTag}</span></h1>
      <p>极简 · 稳定 · 高速 · 一键升级</p>
    </header>

    <main>
      <section class="card glass">
        <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg> 最新构建信息</h2>
        ${buildHtml}
      </section>

      <section class="card glass">
        <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> 极速一键升级</h2>
        <div class="terminal">
          <div class="terminal-header">
            <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
          </div>
          <div class="terminal-body" id="cmd">sudo bash -c "$(curl -fsSL https://up-kernel.cuicanmx.cn/Update-kernel.sh)"</div>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="copyCmd()" id="copyBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            <span>一键复制命令</span>
          </button>
        </div>
      </section>

      <div class="grid-2">
        <section class="card glass slim">
          <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> 关于本项目</h2>
          <p class="desc">依托 Cloudflare CDN 边缘节点，为 <strong>红米 K20 Pro（raphael）</strong> 提供稳定的内核更新服务。代码全开源，GitHub Actions 自动化构建，支持断点续传加速。</p>
        </section>

        <section class="card glass slim warning">
          <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg> 刷机须知</h2>
          <ul>
            <li>仅适配机型：<strong>小米 Raphael (K20 Pro)</strong></li>
            <li>请保持电量充足，操作前务必备份核心数据</li>
            <li>更新完成后，请执行 <code>reboot</code> 重启设备</li>
          </ul>
        </section>
      </div>
    </main>`;
}

function generateHtml(content) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${CONFIG.pageTitle}</title>
  <meta name="description" content="自动化构建、高速分发的红米 K20 Pro 极简内核一键升级服务。">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐧</text></svg>">
  <style>
    :root {
      --primary: #4f46e5; --primary-hover: #4338ca;
      --bg-color: #f8fafc; --text-main: #0f172a; --text-muted: #64748b;
      --card-bg: rgba(255, 255, 255, 0.85); --card-border: rgba(226, 232, 240, 0.8);
      --font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-color); color: var(--text-main); font-family: var(--font-ui); line-height: 1.6; -webkit-font-smoothing: antialiased; 
           background-image: radial-gradient(at 0% 0%, hsla(253,16%,7%,0.03) 0, transparent 50%), radial-gradient(at 50% 0%, hsla(225,39%,30%,0.03) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(339,49%,30%,0.03) 0, transparent 50%);
           background-attachment: fixed; }
    .container { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.25rem; }
    
    /* Hero Section */
    .hero { text-align: center; margin-bottom: 2.5rem; animation: fadeUp 0.6s ease-out; }
    .hero .icon-wrapper { font-size: 3.5rem; line-height: 1; margin-bottom: 0.5rem; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.1)); }
    .hero h1 { font-size: 2.25rem; font-weight: 800; letter-spacing: -0.025em; color: #1e293b; margin-bottom: 0.4rem; }
    .hero h1 span { background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { color: var(--text-muted); font-size: 1.1rem; font-weight: 500; }

    /* Cards */
    .card { background: var(--card-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--card-border); border-radius: 16px; padding: 1.75rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -2px rgba(0,0,0,0.02); transition: transform 0.2s, box-shadow 0.2s; animation: fadeUp 0.6s ease-out backwards; }
    .card:nth-child(2) { animation-delay: 0.1s; }
    .card:nth-child(3) { animation-delay: 0.2s; }
    .card:hover { box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); }
    .card h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 1.25rem; display: flex; align-items: center; gap: 0.5rem; color: #1e293b; }
    .card h2 svg { width: 22px; height: 22px; color: var(--primary); }
    .slim { padding: 1.5rem; }

    /* Stats Grid */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
    .stat { background: #fff; padding: 1rem 1.25rem; border-radius: 12px; border: 1px solid #f1f5f9; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
    .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 0.25rem; }
    .stat-value { font-size: 1.15rem; font-weight: 700; color: var(--text-main); word-break: break-word; }
    .text-gradient { background: linear-gradient(to right, #2563eb, #4f46e5); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .id-text { font-family: var(--font-mono); font-size: 0.95rem; background: #f1f5f9; padding: 0.1rem 0.4rem; border-radius: 4px; display: inline-block; }
    .error-state { background: #fef2f2; border: 1px solid #fecaca; }
    .stat-error { text-align: center; color: #991b1b; padding: 1rem; width: 100%; font-weight: 500; }

    /* Terminal Mac Style */
    .terminal { background: #0f172a; border-radius: 12px; overflow: hidden; margin-bottom: 1.25rem; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1), 0 10px 15px -3px rgba(0,0,0,0.1); }
    .terminal-header { background: #1e293b; padding: 10px 16px; display: flex; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .dot.red { background: #ff5f56; } .dot.yellow { background: #ffbd2e; } .dot.green { background: #27c93f; }
    .terminal-body { padding: 1.25rem 1.5rem; color: #38bdf8; font-family: var(--font-mono); font-size: 0.95rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }

    /* Button */
    .btn-group { display: flex; justify-content: flex-start; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); user-select: none; }
    .btn-primary { background: var(--primary); color: #fff; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2); }
    .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 6px 8px -1px rgba(79, 70, 229, 0.3); }
    .btn-primary:active { transform: scale(0.97); }
    .btn svg { width: 18px; height: 18px; }
    .btn.copied { background: #059669; box-shadow: 0 4px 6px -1px rgba(5, 150, 105, 0.2); }

    /* Layout & Utilities */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; align-items: start; animation: fadeUp 0.6s ease-out 0.3s backwards; }
    .desc { color: #475569; font-size: 0.95rem; }
    
    .warning { background: linear-gradient(to right bottom, #fffbeb, #fef3c7); border-color: #fde68a; }
    .warning h2 { color: #b45309; }
    .warning h2 svg { color: #d97706; }
    .warning ul { padding-left: 1.5rem; color: #92400e; font-size: 0.95rem; }
    .warning li { margin-bottom: 0.5rem; }
    .warning code { background: rgba(217, 119, 6, 0.15); padding: 0.1rem 0.3rem; border-radius: 4px; font-family: var(--font-mono); font-size: 0.85em; }

    /* Footer */
    footer { text-align: center; margin-top: 3rem; animation: fadeUp 0.6s ease-out 0.4s backwards; }
    .github-link { display: inline-flex; align-items: center; gap: 0.5rem; background: #fff; border: 1px solid var(--card-border); padding: 0.6rem 1.25rem; border-radius: 12px; color: #334155; font-weight: 600; text-decoration: none; font-size: 0.9rem; transition: all 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
    .github-link:hover { background: #f8fafc; border-color: var(--primary); color: var(--primary); transform: translateY(-1px); }
    .github-link svg { width: 18px; height: 18px; fill: currentColor; }

    @keyframes fadeUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }

    @media(max-width: 768px) {
      .grid-2 { grid-template-columns: 1fr; gap: 1rem; }
      .container { padding: 1.5rem 1rem; }
      .hero h1 { font-size: 1.8rem; }
      .card { padding: 1.25rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    ${content}
    <footer>
      <a href="${CONFIG.githubRepoUrl}" target="_blank" rel="noopener noreferrer" class="github-link">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        GitHub 代码仓库
      </a>
    </footer>
  </div>
  <script>
    function copyCmd(){
      const cmd = document.getElementById('cmd').innerText;
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = document.getElementById('copyBtn');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg><span>复制成功</span>';
        btn.classList.add('copied');
        setTimeout(() => { 
          btn.innerHTML = originalHtml; 
          btn.classList.remove('copied'); 
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}