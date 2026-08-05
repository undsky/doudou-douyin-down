(function() {
  if (window.__doudouDyInjected) return;
  window.__doudouDyInjected = true;

  // 从 url 列表中挑选画质最佳的一条：优先 jpeg/jpg（无损于 webp 且兼容性好），其次首条
  function pickFromUrlList(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const jpeg = list.find(u => typeof u === 'string' && (u.includes('.jpeg') || u.includes('.jpg')));
    return jpeg || list.find(u => typeof u === 'string') || null;
  }

  // 图片地址提取。
  // 实测（搜索接口）：watermark_free_download_url_list 恒为 null；
  // download_url_list 是 tplv-dy-water-v2 带水印且分辨率更低的版本（772x1373）；
  // url_list 的 tplv-dy-aweme-images 反而是无水印全分辨率原图（1080x1920）。
  // 故优先级为：无水印原图 > url_list > 其它，download_url_list 仅作最后兜底。
  function extractImageUrls(imgObj) {
    if (!imgObj) return null;
    if (typeof imgObj === 'string') return imgObj;

    let url = pickFromUrlList(imgObj.watermark_free_download_url_list) ||
              pickFromUrlList(imgObj.watermarkFreeDownloadUrlList) ||
              pickFromUrlList(imgObj.url_list) ||
              pickFromUrlList(imgObj.urlList) ||
              pickFromUrlList(imgObj.display_image?.url_list) ||
              pickFromUrlList(imgObj.display_image?.urlList) ||
              pickFromUrlList(imgObj.download_url_list) ||
              pickFromUrlList(imgObj.downloadUrlList) ||
              pickFromUrlList(imgObj.owner_watermark_image?.url_list);

    if (url && url.startsWith('//')) {
      url = 'https:' + url;
    }
    return url;
  }

  function parseAweme(aweme, notes, videos) {
    if (!aweme || typeof aweme !== 'object') return;
    const id = aweme.aweme_id || aweme.awemeId;
    if (!id) return;

    // 1. 提取图文高清图片（覆盖各类 JSON 结构节点）
    const rawImages = aweme.images ||
                      aweme.image_post_info?.images ||
                      aweme.image_post_info?.image_list ||
                      aweme.images_info ||
                      aweme.img_url_list ||
                      aweme.image_album;

    if (rawImages && Array.isArray(rawImages) && rawImages.length > 0) {
      const list = rawImages.map(img => extractImageUrls(img)).filter(Boolean);
      if (list.length > 0) {
        notes[id] = list;
      }
    }

    // 2. 提取最高画质无水印视频播放地址
    if (aweme.video) {
      const video = aweme.video;
      let url = null;
      const bitRateList = video.bitRateList || video.bit_rate_list;
      if (bitRateList && Array.isArray(bitRateList) && bitRateList.length > 0) {
        const sorted = [...bitRateList].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
        for (const item of sorted) {
          url = item.playAddr?.[0]?.src || item.play_addr?.url_list?.[0] || item.playAddrH265?.[0]?.src;
          if (url) break;
        }
      }
      if (!url) {
        url = video.playAddr?.[0]?.src ||
              video.playAddrH265?.[0]?.src ||
              video.play_addr?.url_list?.[0] ||
              video.download_addr?.url_list?.[0];
      }
      if (url) {
        if (url.startsWith('//')) url = 'https:' + url;
        url = url.replace(/playwm/g, 'play').replace(/&watermark=1/g, '').replace(/\?watermark=1/g, '');
        videos[id] = url;
      }
    }
  }

  // 搜索接口为流式响应，body 是多个 JSON 对象首尾拼接而成，
  // 整体 JSON.parse 必定失败，需按括号深度切分后逐块解析。
  function splitJsonObjects(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return out;
  }

  function collectAwemes(data, awemeList) {
    if (!data || typeof data !== 'object') return;
    if (data.aweme_detail) awemeList.push(data.aweme_detail);
    if (Array.isArray(data.aweme_list)) awemeList.push(...data.aweme_list);
    if (data.data) {
      const items = Array.isArray(data.data) ? data.data : [data.data];
      items.forEach(item => {
        if (!item || typeof item !== 'object') return;
        if (item.aweme_info) awemeList.push(item.aweme_info);
        if (item.aweme_detail) awemeList.push(item.aweme_detail);
        if (item.aweme) awemeList.push(item.aweme);
        // 搜索结果中的合集 / 聚合卡片
        if (Array.isArray(item.aweme_list)) awemeList.push(...item.aweme_list);
      });
    }
  }

  function processResponseText(text) {
    if (!text) return;

    const awemeList = [];
    const blocks = splitJsonObjects(text);
    for (const block of blocks) {
      try {
        collectAwemes(JSON.parse(block), awemeList);
      } catch (e) { /* 单块解析失败不影响其余块 */ }
    }
    if (awemeList.length === 0) return;

    const notes = {};
    const videos = {};
    awemeList.forEach(aweme => parseAweme(aweme, notes, videos));

    if (Object.keys(notes).length > 0 || Object.keys(videos).length > 0) {
      window.postMessage({ type: 'DOUDOU_DY_MEDIA_DATA', notes, videos }, '*');
    }
  }

  function isTargetApi(urlString) {
    if (!urlString) return false;
    return urlString.includes('/aweme/') ||
           urlString.includes('/search/') ||
           urlString.includes('/general/search/') ||
           urlString.includes('/feed/') ||
           urlString.includes('/post/') ||
           urlString.includes('/note/') ||
           urlString.includes('/jingxuan/');
  }

  // 拦截 Fetch
  const originalFetch = window.fetch;

  window.fetch = async function(url, options) {
    const urlString = typeof url === 'string' ? url : url?.url || '';
    const promise = originalFetch.apply(this, arguments);

    if (isTargetApi(urlString)) {
      promise.then(response => {
        response.clone().text().then(text => {
          processResponseText(text);
        }).catch(() => {});
      }).catch(() => {});
    }

    return promise;
  };

  // 拦截 XHR
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function(method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function() {
    this.addEventListener('load', function() {
      const urlString = typeof this._url === 'string' ? this._url : this._url?.url || '';
      if (isTargetApi(urlString)) {
        try {
          processResponseText(this.responseText);
        } catch(e) {}
      }
    });
    return originalSend.apply(this, arguments);
  };

  // ===== SPA 路由变化通知 =====
  // 抖音在精选/推荐页切换作品只改写 history（modal_id 变化），既不刷新页面也不触发
  // popstate；而 Content Script 运行在隔离世界，拿不到页面的 history 对象，无法自己
  // hook。所以在 Main World 里 hook 后 postMessage 通知内容脚本重新扫描资源。
  let lastHref = location.href;
  function notifyUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    window.postMessage({ type: 'DOUDOU_DY_URL_CHANGED', url: location.href }, '*');
  }

  ['pushState', 'replaceState'].forEach(function(name) {
    const orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function() {
      const ret = orig.apply(this, arguments);
      setTimeout(notifyUrlChange, 0);
      return ret;
    };
  });
  window.addEventListener('popstate', () => setTimeout(notifyUrlChange, 0));
  window.addEventListener('hashchange', () => setTimeout(notifyUrlChange, 0));
  // 兜底轮询：抖音若绕过 history 包装（例如自己缓存了原生方法）仍能被发现
  setInterval(notifyUrlChange, 500);
})();
