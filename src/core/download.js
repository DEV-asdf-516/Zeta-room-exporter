import { assembleExportParts } from './assembly.js';

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadContent(content, mimeType, filename) {
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(`\uFEFF${content}`)}`;
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

export async function downloadExportJob(store, job, onPart = async () => {}) {
  const safeRoomId = safeName(job.roomId);
  const manifestParts = [];
  let isLarge = false;
  for await (const part of assembleExportParts(store, job)) {
    isLarge ||= part.large;
    const number = String(part.index).padStart(3, '0');
    const filename = part.large
      ? `room_${safeRoomId}_part-${number}.${part.extension}`
      : `room_${safeRoomId}.${part.extension}`;
    await downloadContent(part.content, part.mimeType, filename);
    manifestParts.push({
      filename,
      order: part.index,
      messageCount: part.messageCount,
      firstMessageId: part.firstMessageId,
      lastMessageId: part.lastMessageId,
    });
    await onPart({ part: part.index, messageCount: part.messageCount });
  }

  if (isLarge) {
    const manifest = {
      version: 1,
      roomId: job.roomId,
      format: job.format,
      totalMessages: job.messageCount,
      parts: manifestParts,
    };
    await downloadContent(
      JSON.stringify(manifest, null, 2),
      'application/json',
      `room_${safeRoomId}_manifest.json`,
    );
  }
  return { fileCount: manifestParts.length + (isLarge ? 1 : 0) };
}

export async function downloadDiagnosticLog(log) {
  const roomId = safeName(log.job.roomId);
  await downloadContent(
    JSON.stringify(log, null, 2),
    'application/json',
    `room_${roomId}_diagnostic.json`,
  );
}
