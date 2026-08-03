/**
 * 抖音下载助手 - Background Service Worker
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OPEN_TAB' || request.action === 'openTab') {
    chrome.tabs.create({ url: request.url }, (tab) => {
      sendResponse({ success: true, tabId: tab ? tab.id : null });
    });
    return true;
  }

  if (request.type === 'DOUDOU_DOWNLOAD_MEDIA' || request.action === 'download') {
    const { url, filename } = request;
    if (!url) {
      sendResponse({ success: false, error: '缺少下载 URL' });
      return true;
    }

    chrome.downloads.download({
      url: url,
      filename: filename || `douyin_media/${Date.now()}.mp4`,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[Background] 下载任务失败:', err.message);
        sendResponse({ success: false, error: err.message });
      } else {
        console.log('[Background] 下载任务建立成功, ID:', downloadId);
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true;
  }
});
