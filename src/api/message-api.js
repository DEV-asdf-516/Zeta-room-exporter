import { ApiRequestError } from './api-errors.js';

export function createMessageApi(request) {
  return {
    async getMessagesPage(roomId, requestCursor = null, limit = 100) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (typeof requestCursor === 'string' && requestCursor) {
        query.set('cursor', requestCursor);
      }
      else if (requestCursor?.value) {
        const parameter = requestCursor.parameter === 'prevCursor' ? 'prevCursor' : 'cursor';
        query.set(parameter, requestCursor.value);
      }
      return request(`/v1/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
    },

    async getBookmarks(roomId) {
      const bookmarks = [];
      let cursor = null;
      const seen = new Set();
      do {
        const query = new URLSearchParams();
        if (cursor) {
          query.set('cursor', cursor);
        }
        const suffix = query.size ? `?${query}` : '';
        const page = await request(`/v1/rooms/${encodeURIComponent(roomId)}/bookmarks${suffix}`);
        const pageBookmarks = Array.isArray(page) ? page : page.items ?? page.bookmarks;
        if (!Array.isArray(pageBookmarks)) {
          throw new ApiRequestError('북마크 목록 응답 형식이 올바르지 않습니다.', {
            code: 'INVALID_BOOKMARKS',
          });
        }
        bookmarks.push(...pageBookmarks);
        cursor = Array.isArray(page) ? null : page.nextCursor ?? null;
        if (cursor && seen.has(cursor)) {
          throw new ApiRequestError('북마크 cursor가 반복되어 조회를 중단했습니다.', {
            code: 'REPEATED_CURSOR',
          });
        }
        if (cursor) {
          seen.add(cursor);
        }
      } while (cursor);
      return bookmarks;
    },

    async createBookmark(roomId, messageId) {
      return request(`/v1/rooms/${encodeURIComponent(roomId)}/bookmarks`, {
        method: 'POST',
        body: { roomId, messageId },
      });
    },
  };
}
