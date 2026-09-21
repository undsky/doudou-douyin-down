/* Douyin WASM Loader Bundle */
/**
 * 抖音下载助手 - WASM 加载器与算法桥接
 */
(function (global) {
  "use strict";

  let wasmInstance = null;
  let wasmLoadingPromise = null;

  async function initWasm() {
    if (wasmInstance) return wasmInstance;
    if (wasmLoadingPromise) return wasmLoadingPromise;

    wasmLoadingPromise = (async () => {
      try {
        let wasmUrl = "build/douyin.wasm";
        if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
          wasmUrl = chrome.runtime.getURL("build/douyin.wasm");
        }

        let bytes;
        if (typeof process !== "undefined" && process.versions && process.versions.node && typeof require === "function") {
          const fs = require("fs");
          const path = require("path");
          const wasmPath = path.resolve(__dirname, "..", "build", "douyin.wasm");
          if (fs.existsSync(wasmPath)) {
            bytes = fs.readFileSync(wasmPath);
          } else {
            const distWasmPath = path.resolve(__dirname, "build", "douyin.wasm");
            bytes = fs.readFileSync(distWasmPath);
          }
        } else {
          const response = await fetch(wasmUrl);
          bytes = await response.arrayBuffer();
        }

        const module = await WebAssembly.instantiate(bytes, {
          env: {
            abort(msg, file, line, col) {
              console.error("[Douyin WASM] Abort called:", { msg, file, line, col });
            }
          }
        });

        wasmInstance = module.instance;
        console.log("[Douyin WASM] 核心 WebAssembly 算法模块成功装载并在沙箱中就绪");
        return wasmInstance;
      } catch (err) {
        console.error("[Douyin WASM] 加载 WASM 核心模块失败:", err);
        throw err;
      }
    })();

    return wasmLoadingPromise;
  }

  // 内存辅助读写机制
  function writeStringToMemory(instance, str, ptr) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str || "");
    const memView = new Uint8Array(instance.exports.memory.buffer);
    memView.set(bytes, ptr);
    return bytes.length;
  }

  function readStringFromMemory(instance, ptr, len) {
    const memView = new Uint8Array(instance.exports.memory.buffer, ptr, len);
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(memView);
  }

  async function isVideoUrl(url) {
    if (!url) return false;
    const instance = await initWasm();
    const { getInBufPtr, isVideoUrlWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const inLen = writeStringToMemory(instance, url, inPtr);
    const res = isVideoUrlWasm(inPtr, inLen);
    return res === 1;
  }

  async function isTargetApi(url) {
    if (!url) return false;
    const instance = await initWasm();
    const { getInBufPtr, isTargetApiWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const inLen = writeStringToMemory(instance, url, inPtr);
    const res = isTargetApiWasm(inPtr, inLen);
    return res === 1;
  }

  async function cleanVideoUrl(url) {
    if (!url) return "";
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, cleanVideoUrlWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const inLen = writeStringToMemory(instance, url, inPtr);
    const outLen = cleanVideoUrlWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function sanitizeFilename(name) {
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, sanitizeFilenameWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const inLen = writeStringToMemory(instance, name || "", inPtr);
    const outLen = sanitizeFilenameWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function buildDownloadPath(type, mediaId, index, ext) {
    const instance = await initWasm();
    const { getInBufPtr, getOutBufPtr, buildDownloadPathWasm } = instance.exports;

    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;

    const idStr = String(mediaId || Date.now());
    const typeLen = writeStringToMemory(instance, type || "video", inPtr);
    const idPtr = inPtr + typeLen + 16;
    const idLen = writeStringToMemory(instance, idStr, idPtr);
    const extPtr = idPtr + idLen + 16;
    const extLen = writeStringToMemory(instance, ext || "", extPtr);

    const outLen = buildDownloadPathWasm(inPtr, typeLen, idPtr, idLen, index || 0, extPtr, extLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  global.DouyinWasm = {
    initWasm,
    isVideoUrl,
    isTargetApi,
    cleanVideoUrl,
    sanitizeFilename,
    buildDownloadPath
  };
})(typeof window !== "undefined" ? window : globalThis);


/* Douyin Downloader Core */
/**
 * 抖音下载助手 - Content Script
 * 驱动架构：AssemblyScript / WebAssembly (WASM) 核心算法模块
 * 功能：高清无水印视频缓冲下载、图文集超清原图批量保存、资源扫描与独立悬浮下载面板 UI
 */

(function() {
  'use strict';

  // 创作者服务平台 (creator.douyin.com) 不加载本插件
  if (location.hostname === 'creator.douyin.com' || location.hostname.endsWith('.creator.douyin.com')) {
    return;
  }

  if (window.douyinDownloaderInjected) return;
  window.douyinDownloaderInjected = true;

  // ==================== 立即注入 API 拦截脚本（使用外部文件以符合 CSP）====================
  // 使用 chrome.runtime.getURL 加载外部 inject.js，避免 CSP 违规
  const injectScript = document.createElement('script');
  injectScript.src = chrome.runtime.getURL('src/inject.js');
  (document.head || document.documentElement).appendChild(injectScript);


  // ==================== 视频元素监听（备用方案）====================
  // 当 API 拦截失败时，直接监听 video 元素的加载
  function setupVideoElementWatcher() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'VIDEO') {
            captureVideoElement(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(captureVideoElement);
          }
        });
      });
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // 立即处理已存在的 video
    document.querySelectorAll('video').forEach(captureVideoElement);
  }

  function captureVideoElement(videoEl) {
    if (!videoEl || videoEl.__doudouProcessed) return;
    videoEl.__doudouProcessed = true;

    // 监听 video 的 src 和 source 变化
    const checkSrc = () => {
      let url = videoEl.currentSrc || videoEl.src;
      if (url && url.startsWith('blob:')) {
        // blob URL 需要追踪其来源
        console.log('[豆豆] 发现 video blob:', url);
      } else if (url && (url.includes('douyinvod.com') || url.includes('bytecdn.cn'))) {
        console.log('[豆豆] 发现视频 URL:', url);
        // 从 URL 中提取 aweme_id（如果可能）
        const awemeId = extractAwemeIdFromContext(videoEl);
        if (awemeId) {
          window.__dyVideoMap[awemeId] = url;
          requestScan();
        }
      }
    };

    videoEl.addEventListener('loadstart', checkSrc);
    videoEl.addEventListener('loadedmetadata', checkSrc);
    checkSrc();
  }

  function extractAwemeIdFromContext(videoEl) {
    // 尝试从 video 元素的祖先节点中找到 aweme_id
    let el = videoEl;
    while (el && el !== document.body) {
      // 检查 data 属性
      if (el.dataset && el.dataset.awemeId) return el.dataset.awemeId;
      if (el.dataset && el.dataset.e2eTag) {
        const match = el.dataset.e2eTag.match(/video-(\d+)/);
        if (match) return match[1];
      }
      // 检查 class 中的 id
      if (el.className) {
        const match = el.className.match(/aweme[_-](\d+)/i);
        if (match) return match[1];
      }
      el = el.parentElement;
    }

    // 从 URL 中提取 modal_id
    const urlMatch = location.href.match(/modal_id=(\d+)/);
    return urlMatch ? urlMatch[1] : null;
  }

  // 启动监听
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupVideoElementWatcher);
  } else {
    setupVideoElementWatcher();
  }

  // ==================== 全局数据存储 ====================
  
  // 存储捕获到的视频 URL 和请求头
  window.__dyVideoData = window.__dyVideoData || {
    urls: [],
    currentUrl: null,
    headers: {}
  };

  // 存储捕获到的图文图片数据 (aweme_id -> [url1, url2])
  window.__dyNoteData = window.__dyNoteData || {};

  // 存储捕获到的视频播放地址 (aweme_id -> videoUrl)
  window.__dyVideoMap = window.__dyVideoMap || {};

  // 资源列表映射表 (id -> resourceObj)
  const resourceMap = new Map();
  let panelEl = null;
  let ballEl = null;
  let isCollapsed = false;
  let isDownloadingAll = false;
  const downloadingResources = new Set(); // 跟踪正在下载的资源 ID
  let hasUpdate = false;
  let updateUrl = "https://github.com/undsky/doudou-douyin-down";

  // ==================== 扫描调度（串行化 + 切换作品后重试） ====================

  // scanResources 是异步的，且一进入就会清空 resourceMap。
  // 早期各触发点写成 `scanResources(); renderList();`，渲染发生在扫描 await 之前，
  // 拿到的必然是刚被清空的列表 —— 这正是切换作品后面板永远显示"0 个资源"的原因。
  // 统一由这里调度：串行执行，扫完再渲染；扫描期间的新请求合并成一次补扫。
  let scanRunning = false;
  let scanPending = false;

  async function requestScan() {
    if (scanRunning) {
      scanPending = true;
      return;
    }
    scanRunning = true;
    const oldSize = resourceMap.size;
    try {
      do {
        scanPending = false;
        try {
          await scanResources();
        } catch (e) {
          console.warn('[豆豆] 扫描抖音资源失败:', e);
        }
        renderList();
      } while (scanPending);
    } finally {
      scanRunning = false;
      // 如果扫描后资源数量增加了，说明找到新资源
      if (resourceMap.size > oldSize) {
        console.log('[豆豆] 扫描完成，新增', resourceMap.size - oldSize, '个资源，总计', resourceMap.size, '个');
        // 如果正在探测中且找到了资源，立即停止探测
        if (isProbing) {
          stopProbe(false);
          renderList();
        }
      }
    }
  }

  // 切换作品后，接口响应与播放器 src 都是稍后才到达的，单次扫描大概率扑空。
  // 这里按递增延时重试，一旦扫到资源立即停止。
  // 增加重试次数和间隔，确保抖音 API 有足够时间返回数据
  const PROBE_DELAYS = [1000, 2000, 3000, 5000, 7000, 10000, 12000, 15000];
  let probeTimers = [];
  let isProbing = false;

  function stopProbe(render = false) {
    probeTimers.forEach(clearTimeout);
    probeTimers = [];
    isProbing = false;
    if (render) renderList();
  }

  function probeResources({ delays = PROBE_DELAYS, toastOnFail = false } = {}) {
    stopProbe();
    isProbing = true;
    renderList();

    console.log('[豆豆] 开始探测资源，共', delays.length, '次重试');

    delays.forEach((delay, i) => {
      probeTimers.push(setTimeout(async () => {
        console.log(`[豆豆] 第 ${i + 1}/${delays.length} 次探测，当前资源数:`, resourceMap.size);

        if (resourceMap.size > 0) {
          console.log('[豆豆] 已找到资源，停止探测');
          stopProbe(true);
          return;
        }

        await requestScan();

        if (resourceMap.size > 0) {
          console.log('[豆豆] 扫描成功，找到', resourceMap.size, '个资源');
          stopProbe(true);
        } else if (i === delays.length - 1) {
          console.log('[豆豆] 探测结束，未找到资源');
          stopProbe(true);
          if (toastOnFail) showToast('未发现资源，请播放视频或打开作品页面', 3000);
        }
      }, delay));
    });
  }

  // 作品切换（精选/推荐页只改 modal_id，不刷新页面）
  let lastSeenUrl = location.href;
  function handleUrlChange() {
    const currentUrl = location.href;
    if (currentUrl === lastSeenUrl) return;

    console.log('[豆豆] 检测到URL变化:', lastSeenUrl, '->', currentUrl);
    lastSeenUrl = currentUrl;

    // 上一条作品拦截到的播放地址必须整体丢弃，否则兜底逻辑会把旧视频
    // 挂到新作品下面，用户点下载拿到的是上一个视频
    window.__dyVideoData.currentUrl = null;
    window.__dyVideoData.urls = [];

    // 立即清空旧资源列表和缓存数据，避免探测时检测到旧资源就停止
    resourceMap.clear();
    renderList();
    console.log('[豆豆] 已清空旧资源列表，开始重新扫描...');

    probeResources();
  }

  // ==================== WASM 算法桥接封装 ====================

  async function checkIsVideoUrl(url) {
    if (!url) return false;
    await DouyinWasm.initWasm();
    return await DouyinWasm.isVideoUrl(url);
  }

  async function cleanVideoUrl(url) {
    if (!url) return "";
    await DouyinWasm.initWasm();
    return await DouyinWasm.cleanVideoUrl(url);
  }

  async function sanitizeFilename(name) {
    await DouyinWasm.initWasm();
    return await DouyinWasm.sanitizeFilename(name);
  }

  async function buildDownloadPath(type, mediaId, index = 0, ext = "") {
    try {
      if (typeof DouyinWasm !== "undefined" && DouyinWasm.initWasm) {
        await DouyinWasm.initWasm();
        return await DouyinWasm.buildDownloadPath(type, mediaId, index, ext);
      }
    } catch (e) {
      console.warn('[豆豆] WASM buildDownloadPath 异常，使用 JS 兜底:', e);
    }
    const isImage = String(type).includes('image') || String(type).includes('note');
    const idStr = String(mediaId || Date.now());
    let extStr = (ext || (isImage ? 'jpg' : 'mp4')).toLowerCase();
    if (extStr.startsWith('.')) extStr = extStr.substring(1);
    if (isImage) {
      const idxStr = index < 10 && index >= 0 ? `0${index}` : `${index}`;
      return `douyin_images/${idStr}_${idxStr}.${extStr}`;
    }
    return `douyin_video/${idStr}.${extStr}`;
  }

  // ==================== UI 工具函数 ====================

  function appendToBody(element) {
    if (!element) return;
    const parent = document.body || document.documentElement;
    if (parent) {
      parent.appendChild(element);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.body || document.documentElement).appendChild(element);
      }, { once: true });
    }
  }

  function showToast(message, duration = 3000) {
    const existing = document.querySelector('.douyin-downloader-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'douyin-downloader-toast';
    toast.textContent = message;
    appendToBody(toast);
    setTimeout(() => toast.remove(), duration);
  }

  function setButtonState(btn, state) {
    if (!btn) return;
    btn.classList.remove('loading', 'success', 'error');
    if (state) btn.classList.add(state);
    setTimeout(() => btn.classList.remove('success', 'error'), 2000);
  }

  function createProgress(title) {
    const existing = document.querySelector('.douyin-downloader-progress');
    if (existing) existing.remove();
    
    const progress = document.createElement('div');
    progress.className = 'douyin-downloader-progress';
    progress.innerHTML = `
      <div class="douyin-downloader-progress-title">${title}</div>
      <div class="douyin-downloader-progress-bar">
        <div class="douyin-downloader-progress-fill" style="width: 0%"></div>
      </div>
      <div class="douyin-downloader-progress-text">准备中...</div>
    `;
    appendToBody(progress);
    return {
      update: (current, total, text = '') => {
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        progress.querySelector('.douyin-downloader-progress-fill').style.width = `${percent}%`;
        progress.querySelector('.douyin-downloader-progress-text').textContent = text || `${current} / ${total}`;
      },
      close: () => {
        setTimeout(() => progress.remove(), 500);
      }
    };
  }

  // 图集图片 URL 特征检测
  function looksLikeDouyinImage(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('douyinpic.com') && !url.includes('byteimg.com')) return false;
    // 排除头像、图标、站点装饰图
    if (/aweme-avatar|100x100|avatar|emblem|ModalBg|obj\/douyin-pc-/i.test(url)) return false;
    return url.includes('aweme_images') ||
           url.includes('tplv-dy-aweme-images') ||
           url.includes('tplv-dy-watermark-free') ||
           url.includes('tos-cn-i-0813');
  }

  // 视口中心（modal / 播放器主视区）当前呈现的是视频还是图集。
  // 用 elementsFromPoint 取该点上的整条元素栈（自顶向下），谁在最上面就是用户正在
  // 看的东西：既能穿透播放器上方的透明手势层/控制条，又能天然排除 modal 背后的
  // 搜索结果列表 —— 那些封面图虽然在 DOM 里，却不在中心点的栈顶。
  function detectCenterMediaType() {
    if (typeof document.elementsFromPoint !== 'function') return 'unknown';

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return 'unknown';

    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.4], [0.5, 0.6]]) {
      const stack = document.elementsFromPoint(vw * fx, vh * fy) || [];
      for (const el of stack) {
        if (el.tagName === 'VIDEO') {
          if (el.currentSrc || el.src || el.readyState > 0) return 'video';
        } else if (el.tagName === 'IMG') {
          let src = el.getAttribute('src');
          if (src && src.startsWith('//')) src = 'https:' + src;
          if (looksLikeDouyinImage(src)) return 'note';
        }
      }
    }
    return 'unknown';
  }

  // 从 DOM 中智能解析高清图集（仅在接口数据缺失时兜底）。
  //
  // 不能直接全页扫图：搜索页 / 推荐页的结果列表里全是其它图文作品的封面，URL 特征
  // 与图集原图完全一致，modal 打开时它们仍在 DOM 中，会把视频作品误判成图文。
  // 所以先锚定"屏幕主视区里最大的一张图集图"——modal 里的当前图必然显著大于背景
  // 列表封面——再只从它所在的浏览容器内、按同等尺寸量级取图。
  function extractImagesFromReferenceDOM() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return [];

    const normalize = (src) => (src && src.startsWith('//') ? 'https:' + src : src);

    let anchor = null;
    let anchorArea = 0;
    document.querySelectorAll('img[src]').forEach((img) => {
      if (!looksLikeDouyinImage(normalize(img.getAttribute('src')))) return;
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) return;
      // 中心点必须落在视口内：列表中滚出屏幕的封面不参与竞争
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) return;
      const area = r.width * r.height;
      if (area > anchorArea) {
        anchorArea = area;
        anchor = img;
      }
    });

    // 达不到"主视区大图"体量（视口面积 10%）的，只能是列表封面
    if (!anchor || anchorArea < vw * vh * 0.1) return [];

    const panelSelector = [
      '.focusPanel',
      '[class*="focusPanel"]',
      '[class*="swiper"]',
      '[data-e2e="feed-image"]',
      '[data-e2e="note-image"]'
    ].join(',');

    // closest 取最内层容器：modal 自己的图片 swiper，而非外层的结果列表容器
    const container = anchor.closest(panelSelector) || anchor.parentElement;

    const images = [];
    const seen = new Set();
    const pushSrc = (src) => {
      src = normalize(src);
      if (!src || !looksLikeDouyinImage(src)) return;
      // 同一张图不同尺寸/签名参数视为同一张，按路径去重
      const key = src.split('?')[0].split('~')[0];
      if (seen.has(key)) return;
      seen.add(key);
      images.push(src);
    };

    if (container) {
      container.querySelectorAll('img[src]').forEach((img) => {
        const r = img.getBoundingClientRect();
        // 同组的其它张（含滑出可视区的相邻 slide）尺寸与锚点同量级；
        // 若容器不幸命中了外层列表，小尺寸封面会在这里被挡掉
        if (r.width * r.height >= anchorArea * 0.5) pushSrc(img.getAttribute('src'));
      });
    }
    if (images.length === 0) pushSrc(anchor.getAttribute('src'));

    return images;
  }

  // 触发浏览器保存一个 Blob
  function saveBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename.replace(/\//g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
  }

  // 根据响应的真实 MIME 修正文件扩展名（URL 后缀常与实际内容不一致）
  function fixExtByMime(filename, mime) {
    if (!mime) return filename;
    const map = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
      'image/heic': 'heic'
    };
    const ext = map[mime.split(';')[0].trim().toLowerCase()];
    if (!ext) return filename;
    return filename.replace(/\.[^.\/]+$/, '') + '.' + ext;
  }

  // 单张图片保存。
  // 默认直存服务端返回的原始字节，不做任何重编码 —— Canvas 重绘会剥离
  // EXIF、按 sRGB 重采样，且把 JPEG 转成体积数倍的 PNG，属于有损"升级"。
  // 仅当 fetch 被防盗链拦截时，才退化到 Image + Canvas 这条会重编码的路径。
  async function downloadImageFile(url, filename) {
    try {
      const response = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const sourceBlob = await response.blob();
      if (sourceBlob.type.includes('text/html') || sourceBlob.size < 500) {
        throw new Error('无效的图片响应数据');
      }

      // 原始字节直存，保持服务端下发的画质与格式
      saveBlob(sourceBlob, fixExtByMime(filename, sourceBlob.type));
      return { success: true, bytes: sourceBlob.size, type: sourceBlob.type };
    } catch (error) {
      console.warn('[豆豆] 直接下载失败，退化到 Canvas 重绘（会重编码为 PNG）:', error);
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            if (img.naturalWidth > 0 && (img.naturalWidth < 250 || img.naturalHeight < 250)) {
              resolve({ success: false, error: '图标图片被忽略' });
              return;
            }

            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            canvas.toBlob((blob) => {
              if (blob) {
                saveBlob(blob, fixExtByMime(filename, 'image/png'));
                resolve({ success: true, bytes: blob.size, reencoded: true });
              } else {
                resolve({ success: false, error: 'Canvas 转换失败' });
              }
            }, "image/png");
          } catch (e) {
            resolve({ success: false, error: e.message });
          }
        };
        img.onerror = () => resolve({ success: false, error: '图片加载失败' });
        img.src = url;
      });
    }
  }

  // 视频地址直接缓冲与内存保存
  async function downloadDirectUrl(url, filename) {
    try {
      showToast('正在缓冲无水印视频到内存，请稍候...', 12000);
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const blob = await response.blob();
      if (blob.type.includes('text/html') || blob.size < 1000) {
        const text = await blob.text();
        if (text.includes('<!DOCTYPE') || text.includes('<html')) {
          throw new Error('被防盗链拦截');
        }
      }

      showToast('缓冲完成，正在生成文件并保存...', 3000);

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename.replace(/\//g, '_'); 
      document.body.appendChild(a);
      a.click();
      a.remove();
      
      setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
      return { success: true };
    } catch (error) {
      console.error('[豆豆] 页面内 Fetch 失败:', error);
      showToast('缓冲失败，尝试后台服务下载...', 2000);
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'DOUDOU_DOWNLOAD_MEDIA',
          action: 'download',
          url: url,
          filename: filename
        }, (response) => {
          const err = chrome.runtime.lastError;
          if (err) console.warn('[豆豆] 后台下载响应异常:', err.message);
          resolve(response);
        });
      });
    }
  }

  // ==================== 资源扫描与解析逻辑 ====================

  function getCurrentAwemeId() {
    const urlParams = new URLSearchParams(window.location.search);
    let id = urlParams.get('modal_id');
    if (id) return id;

    const match = window.location.pathname.match(/\/(video|note)\/(\d+)/);
    if (match) return match[2];

    return null;
  }

  function getVideoFromElement() {
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.src && !video.src.startsWith('blob:')) return video.src;
      if (video.currentSrc && !video.currentSrc.startsWith('blob:')) return video.currentSrc;
    }
    return null;
  }

  async function fetchAwemeDetail(awemeId) {
    if (!awemeId) return null;
    
    if (window.__dyNoteData[awemeId] && window.__dyNoteData[awemeId].length > 0) {
      return {
        isNote: true,
        note: window.__dyNoteData[awemeId],
        video: window.__dyVideoMap[awemeId]
      };
    }

    try {
      const res = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&device_platform=webapp&aid=6383`);
      if (!res.ok) return null;
      // 无签名参数时抖音会返回反爬 HTML 而非 JSON，需先判别
      const text = await res.text();
      if (!text || !text.trim().startsWith('{')) {
        console.warn('[豆豆] detail 接口返回非 JSON（反爬拦截），改用页面拦截数据');
        return null;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return null;
      }
      const aweme = data?.aweme_detail;
      if (!aweme) return null;

      const rawImages = aweme.images ||
                        aweme.image_post_info?.images ||
                        aweme.image_post_info?.image_list ||
                        aweme.images_info ||
                        aweme.img_url_list ||
                        aweme.image_album;

      let noteImages = null;
      if (rawImages && Array.isArray(rawImages) && rawImages.length > 0) {
        const pick = (list) => {
          if (!Array.isArray(list) || list.length === 0) return null;
          const jpeg = list.find(u => typeof u === 'string' && (u.includes('.jpeg') || u.includes('.jpg')));
          return jpeg || list.find(u => typeof u === 'string') || null;
        };
        const list = rawImages.map(img => {
          if (typeof img === 'string') return img;
          // 优先级同 inject.js：url_list 才是无水印全分辨率原图，
          // download_url_list 反而是带水印的低分辨率版本，仅作兜底。
          let url = pick(img.watermark_free_download_url_list) ||
                    pick(img.watermarkFreeDownloadUrlList) ||
                    pick(img.url_list) ||
                    pick(img.urlList) ||
                    pick(img.display_image?.url_list) ||
                    pick(img.download_url_list) ||
                    pick(img.downloadUrlList) ||
                    pick(img.owner_watermark_image?.url_list);
          if (url && url.startsWith('//')) url = 'https:' + url;
          return url;
        }).filter(Boolean);

        if (list.length > 0) {
          noteImages = list;
          window.__dyNoteData[awemeId] = list;
        }
      }

      let videoUrl = null;
      if (aweme.video) {
        const video = aweme.video;
        const bitRateList = video.bitRateList || video.bit_rate_list;
        if (bitRateList && Array.isArray(bitRateList) && bitRateList.length > 0) {
          const sorted = [...bitRateList].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
          for (const item of sorted) {
            videoUrl = item.playAddr?.[0]?.src || item.play_addr?.url_list?.[0] || item.playAddrH265?.[0]?.src;
            if (videoUrl) break;
          }
        }
        if (!videoUrl) {
          videoUrl = video.playAddr?.[0]?.src || 
                     video.playAddrH265?.[0]?.src || 
                     video.play_addr?.url_list?.[0] || 
                     video.download_addr?.url_list?.[0];
        }
        if (videoUrl) {
          videoUrl = await cleanVideoUrl(videoUrl);
          window.__dyVideoMap[awemeId] = videoUrl;
        }
      }

      return {
        isNote: !!(noteImages && noteImages.length > 0),
        note: noteImages,
        video: videoUrl
      };
    } catch (e) {
      console.error('[豆豆] 主动 API 查询作品详情失败:', e);
    }
    return null;
  }

  async function scanResources() {
    const currentAwemeId = getCurrentAwemeId();

    console.log('[豆豆] 开始扫描资源，当前 aweme_id:', currentAwemeId);
    console.log('[豆豆] 缓存的图文数据:', Object.keys(window.__dyNoteData).length, '条');
    console.log('[豆豆] 缓存的视频数据:', Object.keys(window.__dyVideoMap).length, '条');

    // 每次扫描重建列表，避免切换作品后残留上一个作品的资源
    resourceMap.clear();

    // 1. 图文集扫描：API 拦截到的数据最完整，优先使用；DOM 仅作兜底
    let noteImages = null;
    let noteId = currentAwemeId;

    const apiNote = currentAwemeId ? window.__dyNoteData[currentAwemeId] : null;
    const apiVideo = currentAwemeId ? window.__dyVideoMap[currentAwemeId] : null;

    console.log('[豆豆] 当前作品 ID:', currentAwemeId);
    console.log('[豆豆] 从缓存获取图文:', apiNote ? `${apiNote.length} 张` : '无');
    console.log('[豆豆] 从缓存获取视频:', apiVideo ? '有' : '无');

    if (apiNote && apiNote.length > 0) {
      noteImages = apiNote;
      console.log('[豆豆] 使用 API 图文数据:', noteImages.length, '张');
    } else if (!apiVideo && detectCenterMediaType() !== 'video') {
      // 只有在"接口没给出当前作品的播放地址"且"主视区顶层不是视频"时才走 DOM 兜底。
      // 接口对同一个 aweme 会同时给出 images 与 video，图文作品必然先命中 apiNote；
      // 反过来，拿到了 apiVideo 却没有 apiNote，就说明这条是纯视频，绝不能再去扫图 ——
      // 否则会扫到 modal 背后搜索结果列表里其它图文作品的封面，把视频误判成图文。
      console.log('[豆豆] API 数据不足，尝试 DOM 兜底扫描');
      const domRefImages = extractImagesFromReferenceDOM();
      if (domRefImages && domRefImages.length > 0) {
        noteImages = domRefImages;
        noteId = currentAwemeId || `note_${Date.now()}`;
        console.log('[豆豆] 使用 DOM 兜底数据:', noteImages.length, '张');
      } else {
        console.log('[豆豆] DOM 兜底也未找到图片');
      }
    }

    if (noteImages && noteImages.length > 0) {
      // 图集与视频使用独立 key，避免同一作品下两者互相覆盖
      console.log('[豆豆] 添加图文资源:', noteId, noteImages.length, '张');
      resourceMap.set(`note_${noteId}`, {
        id: noteId,
        title: `抖音图集作品 (${noteImages.length} 张原图)`,
        type: 'note',
        images: noteImages,
        count: noteImages.length
      });
    }

    // 2. 视频资源扫描
    if (currentAwemeId) {
      let videoUrl = window.__dyVideoMap[currentAwemeId];
      if (!videoUrl && !noteImages) {
        const detail = await fetchAwemeDetail(currentAwemeId);
        if (detail?.isNote && detail.note?.length > 0) {
          resourceMap.set(`note_${currentAwemeId}`, {
            id: currentAwemeId,
            title: `抖音图集作品 (${detail.note.length} 张原图)`,
            type: 'note',
            images: detail.note,
            count: detail.note.length
          });
        }
        if (detail?.video) videoUrl = detail.video;
      }
      // 图集作品不再重复登记为视频（图文封面视频会误导用户）
      if (videoUrl && !noteImages) {
        videoUrl = await cleanVideoUrl(videoUrl);
        resourceMap.set(`video_${currentAwemeId}`, {
          id: currentAwemeId,
          title: `抖音高清无水印视频 (${currentAwemeId})`,
          type: 'video',
          url: videoUrl
        });
      }
    }

    // 3. 拦截到的视频 URL 兜底扫描（仅在完全没有资源时启用）
    if (resourceMap.size === 0) {
      const fallback = window.__dyVideoData.currentUrl ||
                       (window.__dyVideoData.urls.length > 0 ? window.__dyVideoData.urls[0].url : null);
      if (fallback) {
        const url = await cleanVideoUrl(fallback);
        const id = currentAwemeId || `video_${Date.now()}`;
        resourceMap.set(`video_${id}`, {
          id: id,
          title: `抖音捕获视频资源`,
          type: 'video',
          url: url
        });
      }
    }

    // 4. Video 元素 DOM 兜底
    const elUrl = getVideoFromElement();
    if (elUrl && resourceMap.size === 0) {
      const url = await cleanVideoUrl(elUrl);
      const id = currentAwemeId || `video_element_${Date.now()}`;
      resourceMap.set(id, {
        id: id,
        title: currentAwemeId ? `抖音高清视频 (${currentAwemeId})` : `页面播放器视频`,
        type: 'video',
        url: url
      });
    }

    updateBallCount();
  }

  // ==================== 下载面板 & 悬浮球 UI 管理 ====================

  function renderList() {
    if (!panelEl) return;
    const listEl = panelEl.querySelector(".doudou-douyin-list");
    const countEl = panelEl.querySelector(".doudou-douyin-count");
    if (!listEl) return;

    listEl.innerHTML = "";
    if (countEl) countEl.textContent = isProbing && resourceMap.size === 0
      ? "正在扫描资源..."
      : `共 ${resourceMap.size} 个资源`;

    if (resourceMap.size === 0) {
      listEl.innerHTML = isProbing
        ? `
        <div class="doudou-douyin-empty">
          正在扫描当前作品资源...<br>
          <span style="font-size:12px;color:#9ca3af;">切换作品后需等待抖音接口返回</span>
        </div>
      `
        : `
        <div class="doudou-douyin-empty">
          未发现可下载资源<br>
          <span style="font-size:12px;color:#9ca3af;">请播放视频或打开图集详情页后点击重试</span>
        </div>
      `;
      return;
    }

    resourceMap.forEach((res) => {
      const item = document.createElement("div");
      item.className = "doudou-douyin-item";

      const info = document.createElement("div");
      info.className = "doudou-douyin-item-info";

      const title = document.createElement("div");
      title.className = "doudou-douyin-item-title";
      title.textContent = res.title;

      const meta = document.createElement("div");
      meta.className = "doudou-douyin-item-meta";
      const isNote = res.type === 'note';
      const badgeClass = isNote ? "doudou-douyin-badge doudou-douyin-badge-note" : "doudou-douyin-badge doudou-douyin-badge-video";
      const badgeText = isNote ? "图集" : "视频";
      const metaDetail = isNote ? `包含 ${res.count || res.images?.length || 0} 张原图` : "高清无水印 1080P/4K";

      meta.innerHTML = `<span class="${badgeClass}">${badgeText}</span> <span>${metaDetail}</span>`;

      info.appendChild(title);
      info.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "doudou-douyin-btn";
      btn.textContent = "下载";

      // 构建资源唯一 ID
      const resourceKey = `${res.type}_${res.id}`;

      btn.addEventListener("click", () => downloadOne(res, btn, resourceKey));

      // 如果正在批量下载或该资源正在下载，保持按钮禁用状态
      if (isDownloadingAll || downloadingResources.has(resourceKey)) {
        btn.disabled = true;
        btn.setAttribute('disabled', 'disabled');
      }

      item.appendChild(info);
      item.appendChild(btn);
      listEl.appendChild(item);
    });
  }

  function createPanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement("div");
    panelEl.className = "doudou-douyin-panel";
    panelEl.innerHTML = `
      <div class="doudou-douyin-panel-header">
        <div>
          <div class="doudou-douyin-panel-title">资源下载</div>
          <a class="doudou-douyin-panel-subtitle" href="https://www.undsky.com" target="_blank" rel="noopener noreferrer">关于作者</a>
        </div>
        <div class="doudou-douyin-panel-actions">
          <button class="doudou-douyin-icon-btn" data-action="refresh" title="重新扫描">⟳</button>
          <button class="doudou-douyin-icon-btn" data-action="collapse" title="收起">—</button>
        </div>
      </div>
      <div class="doudou-douyin-list"></div>
      <div class="doudou-douyin-panel-footer">
        <span class="doudou-douyin-count">共 0 个资源</span>
        <button class="doudou-douyin-btn doudou-douyin-btn-send" data-action="download-all">全部下载</button>
      </div>
    `;

    panelEl
      .querySelector('[data-action="collapse"]')
      .addEventListener("click", () => collapsePanel());

    panelEl
      .querySelector('[data-action="refresh"]')
      .addEventListener("click", () => openPanel(true));

    panelEl
      .querySelector('[data-action="download-all"]')
      .addEventListener("click", () => downloadAll());

    renderUpdateBtn();

    appendToBody(panelEl);
    return panelEl;
  }

  function checkVersion() {
    fetch("https://www.undsky.com/v.json")
      .then((res) => res.json())
      .then((data) => {
        const info = data?.["doudou-douyin"];
        if (!info || !info.version) return;

        const currentVersion =
          (typeof chrome !== "undefined" &&
            chrome.runtime?.getManifest?.()?.version) ||
          "1.0.2";

        if (info.version !== currentVersion) {
          hasUpdate = true;
          if (info.url) updateUrl = info.url;
          renderUpdateBtn();
        }
      })
      .catch((err) => {
        console.warn("[豆豆] 版本检测失败:", err);
      });
  }

  function renderUpdateBtn() {
    if (!panelEl || !hasUpdate) return;
    const actionsEl = panelEl.querySelector(".doudou-douyin-panel-actions");
    if (!actionsEl) return;

    let updateBtn = actionsEl.querySelector('[data-action="update"]');
    if (!updateBtn) {
      const refreshBtn = actionsEl.querySelector('[data-action="refresh"]');
      updateBtn = document.createElement("button");
      updateBtn.className = "doudou-douyin-icon-btn";
      updateBtn.setAttribute("data-action", "update");
      updateBtn.title = "下载最新版本";
      updateBtn.innerHTML = "↓";
      updateBtn.addEventListener("click", () => {
        window.open(updateUrl, "_blank", "noopener,noreferrer");
      });
      if (refreshBtn) {
        actionsEl.insertBefore(updateBtn, refreshBtn);
      } else {
        actionsEl.appendChild(updateBtn);
      }
    }
  }

  function updateBallCount() {
    if (!ballEl) return;
    const countEl = ballEl.querySelector(".doudou-douyin-ball-count");
    if (countEl) countEl.textContent = resourceMap.size;
  }

  function showBall() {
    if (ballEl) {
      updateBallCount();
      return;
    }

    ballEl = document.createElement("div");
    ballEl.className = "doudou-douyin-ball";
    ballEl.title = "展开抖音资源下载面板";
    ballEl.innerHTML = `
      <span class="doudou-douyin-ball-icon">
        <svg viewBox="0 0 448 512" width="22" height="22" fill="currentColor">
          <path d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/>
        </svg>
      </span>
      <span class="doudou-douyin-ball-count">${resourceMap.size}</span>
    `;
    ballEl.addEventListener("click", () => expandPanel());
    appendToBody(ballEl);
    updateBallCount();
  }

  function hideBall() {
    if (!ballEl) return;
    ballEl.remove();
    ballEl = null;
  }

  function collapsePanel() {
    isCollapsed = true;
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    showBall();
  }

  function expandPanel() {
    isCollapsed = false;
    hideBall();
    createPanel();
    renderList();
  }

  async function openPanel(forceScan = false) {
    expandPanel();

    if (forceScan || resourceMap.size === 0) {
      console.log('[豆豆] openPanel 触发扫描，forceScan:', forceScan, 'resourceMap.size:', resourceMap.size);
      await requestScan();
      // 首屏/手动重试时资源可能还没加载出来，交给重试探测继续等
      if (resourceMap.size === 0) {
        console.log('[豆豆] 首次扫描未找到资源，启动探测重试');
        probeResources({ toastOnFail: true });
      } else {
        console.log('[豆豆] 首次扫描成功，找到', resourceMap.size, '个资源');
      }
    }
  }

  // 单资源下载入口
  async function downloadOne(res, btn, resourceKey) {
    if (!res) return;
    if (!btn) return;

    // 防止重复点击
    if (btn.disabled || downloadingResources.has(resourceKey)) {
      console.log('[豆豆] 按钮已禁用或资源正在下载，忽略点击');
      return;
    }

    console.log('[豆豆] 开始下载，禁用按钮，resourceKey:', resourceKey);
    downloadingResources.add(resourceKey); // 标记为正在下载
    btn.disabled = true;
    btn.setAttribute('disabled', 'disabled'); // 添加 HTML 属性

    setButtonState(btn, 'loading');

    try {
      if (res.type === 'note' && res.images?.length > 0) {
        await doDownloadImages(res.images, btn, res.id);
      } else if (res.type === 'video' && res.url) {
        await doDownloadVideo(btn, res.url, res.id);
      } else {
        showToast('无效的资源链接');
        setButtonState(btn, 'error');
      }
    } catch (err) {
      console.error('[豆豆] 下载资源异常:', err);
      setButtonState(btn, 'error');
    } finally {
      // 下载完成后恢复按钮
      console.log('[豆豆] 下载完成，恢复按钮，从 Set 中移除:', resourceKey);
      downloadingResources.delete(resourceKey); // 移除下载标记

      // 不直接操作 btn，而是重新渲染列表让按钮自动恢复
      renderList();
    }
  }

  // 全部下载入口
  async function downloadAll() {
    if (isDownloadingAll) {
      showToast("正在批量下载中，请稍候...");
      return;
    }

    if (resourceMap.size === 0) {
      showToast("无可下载资源");
      return;
    }

    // 禁用"全部下载"按钮
    const downloadAllBtn = panelEl?.querySelector('[data-action="download-all"]');
    if (downloadAllBtn) downloadAllBtn.disabled = true;

    // 禁用所有单个下载按钮
    const allDownloadBtns = panelEl?.querySelectorAll('.doudou-douyin-item .doudou-douyin-btn');
    if (allDownloadBtns) {
      allDownloadBtns.forEach(btn => btn.disabled = true);
    }

    isDownloadingAll = true;
    showToast(`开始依次下载 ${resourceMap.size} 个资源...`);

    try {
      const resources = Array.from(resourceMap.values());
      for (let i = 0; i < resources.length; i++) {
        const res = resources[i];
        if (res.type === 'note' && res.images?.length > 0) {
          await doDownloadImages(res.images, null, res.id);
        } else if (res.type === 'video' && res.url) {
          await doDownloadVideo(null, res.url, res.id);
        }
        await new Promise(r => setTimeout(r, 800));
      }

      showToast("所有资源下载任务完成！");
    } finally {
      isDownloadingAll = false;

      // 恢复"全部下载"按钮
      if (downloadAllBtn) downloadAllBtn.disabled = false;

      // 恢复所有单个下载按钮
      const allDownloadBtnsAfter = panelEl?.querySelectorAll('.doudou-douyin-item .doudou-douyin-btn');
      if (allDownloadBtnsAfter) {
        allDownloadBtnsAfter.forEach(btn => btn.disabled = false);
      }
    }
  }

  // ==================== 内部视频与图片保存管线 ====================

  async function doDownloadVideo(btn, presetUrl = null, mediaId = null) {
    let videoUrl = presetUrl;

    if (!videoUrl) {
      showToast('未找到视频资源，请播放视频后再试');
      setButtonState(btn, 'error');
      return;
    }

    showToast('开始处理视频资源...');
    videoUrl = await cleanVideoUrl(videoUrl);
    
    const id = mediaId || getCurrentAwemeId() || Date.now();
    const filename = await buildDownloadPath('video', id, 0, 'mp4');
    const result = await downloadDirectUrl(videoUrl, filename);
    
    if (result && result.success) {
      showToast('视频下载成功！');
      setButtonState(btn, 'success');
    } else {
      showToast('下载失败: ' + (result?.error || '请重试'));
      setButtonState(btn, 'error');
    }
  }

  async function doDownloadImages(images, btn, mediaId = null) {
    showToast(`开始下载 ${images.length} 张原图...`);
    
    const progress = createProgress('下载图片集');
    const id = mediaId || getCurrentAwemeId() || Date.now();
    let success = 0;

    for (let i = 0; i < images.length; i++) {
      progress.update(i + 1, images.length, `保存第 ${i + 1} / ${images.length} 张`);
      
      let imgUrl = images[i];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

      // 先按 URL 猜一个扩展名，真实扩展名由响应 MIME 在保存前修正
      const m = imgUrl.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif|heic)$/i);
      const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
      const filename = await buildDownloadPath('image', id, i + 1, ext);

      const result = await downloadImageFile(imgUrl, filename);
      if (result && result.success) success++;
      
      await new Promise(r => setTimeout(r, 300));
    }

    progress.close();
    showToast(`成功下载 ${success}/${images.length} 张图片`);
    setButtonState(btn, success > 0 ? 'success' : 'error');
  }

  // ==================== 网络请求与事件监听 ====================

  window.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'DOUDOU_DY_URL_CHANGED') {
      console.log('[豆豆 Content Script] 收到URL变化通知:', event.data.url);
      handleUrlChange();
      return;
    }

    if (event.data.type === 'DOUDOU_DY_MEDIA_DATA' || event.data.type === 'DOUDOU_DY_NOTE_DATA') {
      let hasNewData = false;

      if (event.data.notes) {
        const notes = event.data.notes;
        for (const id in notes) {
          window.__dyNoteData[id] = notes[id];
          console.log('[豆豆] API捕获图文数据:', id, notes[id].length, '张图片');
          hasNewData = true;
        }
      }
      if (event.data.videos) {
        const videos = event.data.videos;
        for (const id in videos) {
          window.__dyVideoMap[id] = videos[id];
          console.log('[豆豆] API捕获视频地址:', id, videos[id]);
          hasNewData = true;
        }
      }

      if (hasNewData) {
        console.log('[豆豆] 检测到新的API数据，立即重新扫描并更新面板');
        const oldSize = resourceMap.size;
        requestScan().then(() => {
          // 如果扫描后发现新资源，且面板正在探测中，停止探测
          if (resourceMap.size > oldSize && isProbing) {
            console.log('[豆豆] API 数据到达后找到新资源，停止探测');
            stopProbe(true);
          }
        });
      }
    }
  });

  function interceptXHR() {
    const XHR = XMLHttpRequest.prototype;
    const originalOpen = XHR.open;
    const originalSend = XHR.send;
    const originalSetRequestHeader = XHR.setRequestHeader;

    XHR.open = function(method, url) {
      this._url = url;
      this._method = method;
      this._headers = {};
      return originalOpen.apply(this, arguments);
    };

    XHR.setRequestHeader = function(name, value) {
      this._headers[name] = value;
      return originalSetRequestHeader.apply(this, arguments);
    };

    XHR.send = function() {
      const url = this._url;
      checkIsVideoUrl(url).then(isVideo => {
        if (isVideo) {
          const videoData = {
            url: url,
            headers: this._headers || {},
            timestamp: Date.now()
          };
          if (!window.__dyVideoData.urls.find(u => u.url === url)) {
            window.__dyVideoData.urls.unshift(videoData);
            if (window.__dyVideoData.urls.length > 10) {
              window.__dyVideoData.urls.pop();
            }
          }
          window.__dyVideoData.currentUrl = url;
          window.__dyVideoData.headers = this._headers;
          requestScan();
        }
      });
      return originalSend.apply(this, arguments);
    };
  }

  function interceptFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
      const urlString = typeof url === 'string' ? url : url?.url || '';
      const headers = options?.headers || {};
      
      const isVideo = await checkIsVideoUrl(urlString);
      if (isVideo) {
        const videoData = {
          url: urlString,
          headers: headers,
          timestamp: Date.now()
        };
        if (!window.__dyVideoData.urls.find(u => u.url === urlString)) {
          window.__dyVideoData.urls.unshift(videoData);
          if (window.__dyVideoData.urls.length > 10) {
            window.__dyVideoData.urls.pop();
          }
        }
        window.__dyVideoData.currentUrl = urlString;
        window.__dyVideoData.headers = headers;
        requestScan();
      }
      
      return originalFetch.apply(this, arguments);
    };
  }

  function isStandaloneMediaPage() {
    const pathname = location.pathname;
    const nonStandalonePaths = ['/search', '/user', '/channel', '/discover', '/vs', '/challenge', '/music', '/collection'];
    return !nonStandalonePaths.some(p => pathname.includes(p));
  }

  function openStandaloneMediaPage(awemeId) {
    const targetUrl = `https://www.douyin.com/jingxuan?modal_id=${awemeId}&doudou_auto_download=1`;
    showToast('当前非独立播放页，正在打开精选页自动下载...', 3000);
    try {
      chrome.runtime.sendMessage({ type: "OPEN_TAB", url: targetUrl }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) window.open(targetUrl, '_blank');
      });
    } catch (e) {
      window.open(targetUrl, '_blank');
    }
  }

  function checkAutoDownload() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('doudou_auto_download') === '1') {
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('doudou_auto_download');
        window.history.replaceState({}, '', cleanUrl.toString());
      } catch (e) {}

      showToast('自动下载准备就绪...', 3000);
      setTimeout(() => {
        openPanel(true);
      }, 1500);
    }
  }

  // ==================== 初始化与事件绑定 ====================

  function init() {
    if (!location.hostname.includes('douyin.com')) return;
    
    checkVersion();
    
    // 初始化 WASM 核心模块
    if (typeof DouyinWasm !== "undefined" && DouyinWasm.initWasm) {
      DouyinWasm.initWasm().catch(err => {
        console.warn("[豆豆] WASM 初始化等待:", err);
      });
    }

    // inject.js 已在开头注入，此处删除重复代码

    // 消息监听
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'downloadDouyinMediaAction') {
        openPanel(true);
        sendResponse({ success: true });
      }
      return true;
    });

    window.addEventListener('DOUDOU_TRIGGER_MEDIA_DOWNLOAD', () => {
      openPanel(true);
    });
    
    interceptXHR();
    interceptFetch();

    // MutationObserver 只作兜底，主路径是 Main World 注入脚本发来的
    // DOUDOU_DY_URL_CHANGED（隔离世界 hook 不到页面的 history）
    new MutationObserver(() => handleUrlChange()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // 页面加载完成后展示悬浮球与下载面板
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        // 延迟一点，确保抖音的初始化代码执行完毕
        setTimeout(() => {
          openPanel(true);
        }, 500);
      });
    } else {
      // 页面已加载完成（可能是动态路由切换）
      setTimeout(() => {
        openPanel(true);
      }, 500);
    }

    checkAutoDownload();
  }

  init();
  console.log('[豆豆] 抖音视频/图集下载助手 (WASM 增强版 + 资源面板 UI) 已成功注入');

})();
