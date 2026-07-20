const API_ORIGIN = 'https://api.zeta-ai.io';
const CLIENT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'x-client-type': 'web',
  'x-client-version': '3.41.0',
  'x-client-native-version': '3.41.0',
  'x-device-type': 'pc_web',
  'x-user-language': 'KOREAN',
};

export async function exportRoom(roomId) {
  const cookie = await chrome.cookies.get({
    url: 'https://zeta-ai.io',
    name: 'TOKEN',
  });
  const token = cookie?.value;
  if (!token) throw new Error('Zeta에 로그인해 주세요.');

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const retryableStatus = new Set([429, 500, 502, 503, 504]);

  async function request(path) {
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      let response;
      try {
        response = await fetch(`${API_ORIGIN}${path}`, {
          method: 'GET',
          headers: { ...CLIENT_HEADERS, authorization: `Bearer ${token}` },
        });
      }
      catch (error) {
        if (attempt === 4) throw error;
        await delay(1000 * (2 ** attempt));
        continue;
      }
      finally {
        // Every request is followed by the required one-second pacing delay.
        await delay(1500);
      }

      if (response.ok) {
        return response.json();
      }
      if (response.status === 401) {
        throw new Error('Zeta 페이지를 새로고침한 뒤 다시 시도해 주세요.');
      }
      if (!retryableStatus.has(response.status) || attempt === 4) {
        throw new Error(`Zeta API 요청에 실패했습니다 (${response.status}).`);
      }

      if (response.status === 429) {
        await delay(5000 + Math.floor(Math.random() * 5001));
      }
      else {
        await delay(1000 * (2 ** attempt));
      }
    }
  }

  const safeRoomId = encodeURIComponent(roomId);
  const messages = [];
  let cursor = null;

  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) {
      query.set('cursor', cursor);
    }
    const page = await request(`/v1/rooms/${safeRoomId}/messages?${query}`);
    if (!Array.isArray(page.messages)) throw new Error('메시지 목록 응답 형식이 올바르지 않습니다.');
    messages.push(...page.messages);
    cursor = page.nextCursor ?? null;
  } while (cursor);

  // Cursor pages can be returned in different directions; normalize by messageTime.
  messages.sort((left, right) => {
    const leftTime = typeof left.messageTime === 'number'
      ? left.messageTime
      : Date.parse(left.messageTime || '');
    const rightTime = typeof right.messageTime === 'number'
      ? right.messageTime
      : Date.parse(right.messageTime || '');
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });

  const exportedMessages = messages.map((message) => ({
      contents: message.contents ?? message.content ?? null,
      messageTime: message.messageTime ?? null,
      snapshotImage: message.snapshotImage ?? null,
      bookmarkId: message.bookmarkId ?? null,
      sender: message.sender ?? null,
      roomId: message.roomId ?? null,
      id: message.id ?? null,
    }));

  return { messages: exportedMessages };
}
