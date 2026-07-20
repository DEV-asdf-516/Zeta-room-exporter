export async function downloadExport(payload, roomId, format) {
  const safeRoomId = roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const isText = format === 'txt';
  const content = isText ? toText(payload.messages) : JSON.stringify(payload, null, 2);
  const mimeType = isText ? 'text/plain' : 'application/json';
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(`\uFEFF${content}`)}`;
  await chrome.downloads.download({
    url: dataUrl,
    filename: `room_${safeRoomId}.${isText ? 'txt' : 'json'}`,
    saveAs: false,
  });
}

function toText(messages) {
  const lines = [];
  let previousSpeaker = null;
  for (const message of messages) {
    const contents = Array.isArray(message.contents) ? message.contents : [message.contents];
    for (const content of contents) {
      if (!content || typeof content.text !== 'string') {
        continue;
      }
      const speaker = content.speakerName || 'Unknown';
      if (previousSpeaker !== null && previousSpeaker !== speaker) {
        lines.push('');
      }
      lines.push(`@${speaker}: ${content.text}`);
      previousSpeaker = speaker;
    }
  }
  return lines.join('\n');
}
