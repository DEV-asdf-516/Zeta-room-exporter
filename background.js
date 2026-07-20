import { exportRoom } from './exporter.js';
import { downloadExport } from './download.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'EXPORT_CURRENT_ROOM') return;

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        throw new Error('현재 탭을 찾을 수 없습니다.');
      }

      const roomId = getRoomId(tab.url);
      if (!roomId) {
        throw new Error('현재 페이지 URL에서 Room ID를 찾을 수 없습니다. Zeta 대화방을 연 뒤 다시 시도하세요.');
      }

      const format = message.format === 'txt' ? 'txt' : 'json';
      const payload = await exportRoom(roomId);
      await downloadExport(payload, roomId, format);
      sendResponse({ ok: true, format, messageCount: payload.messages.length });
    } catch (error) {
      console.error('Zeta export failed:', error);
      sendResponse({ ok: false, error: error.message || '내보내기에 실패했습니다.' });
    }
  })();

  return true;
});

function getRoomId(urlString) {
  const url = new URL(urlString);
  for (const key of ['roomId', 'room_id', 'room']) {
    const value = url.searchParams.get(key);
    if (value) {
      return value;
    }
  }

  const match = url.pathname.match(/\/(?:rooms?|chat)\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}
