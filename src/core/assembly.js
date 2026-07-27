const LARGE_MESSAGE_COUNT = 5000;
const LARGE_ESTIMATED_BYTES = 8 * 1024 * 1024;
const PART_TARGET_BYTES = 3 * 1024 * 1024;
const PART_MESSAGE_LIMIT = 1000;

function byteLength(value) {
  return new Blob([value]).size;
}

function serializeJsonMessage(message) {
  return JSON.stringify(message, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function toExportMessage(message) {
  return {
    contents: message.contents ?? message.content ?? null,
    messageTime: message.messageTime ?? null,
    snapshotImage: message.snapshotImage ?? null,
    bookmarkId: message.bookmarkId ?? null,
    sender: message.sender ?? null,
    roomId: message.roomId ?? null,
    id: message.id ?? null,
  };
}

function messageToText(message, previousSpeaker) {
  const lines = [];
  let speakerBefore = previousSpeaker;
  const contents = Array.isArray(message.contents) ? message.contents : [message.contents];
  for (const content of contents) {
    if (!content || typeof content.text !== 'string') {
      continue;
    }
    const speaker = content.speakerName || 'Unknown';
    if (speakerBefore !== null && speakerBefore !== speaker) {
      lines.push('');
    }
    lines.push(`@${speaker}: ${content.text}`);
    speakerBefore = speaker;
  }
  return { text: lines.join('\n'), lastSpeaker: speakerBefore };
}

async function* storedMessages(store, jobId) {
  let afterKey;
  do {
    const chunk = await store.readMessages(jobId, { afterKey, limit: 250 });
    for (const message of chunk.messages) yield toExportMessage(message);
    afterKey = chunk.nextKey;
  } while (afterKey);
}

export async function* assembleExportParts(store, job) {
  const large = job.messageCount >= LARGE_MESSAGE_COUNT
    || job.estimatedBytes >= LARGE_ESTIMATED_BYTES;
  const maxBytes = large ? PART_TARGET_BYTES : Number.POSITIVE_INFINITY;
  const maxMessages = large ? PART_MESSAGE_LIMIT : Number.POSITIVE_INFINITY;
  let partIndex = 1;
  let messageCount = 0;
  let firstId = null;
  let lastId = null;
  let jsonItems = [];
  let textItems = [];
  let contentBytes = 0;
  let previousSpeaker = null;

  function finishPart() {
    if (messageCount === 0) {
      return null;
    }
    const content = job.format === 'txt'
      ? textItems.join('\n')
      : `{\n  "messages": [\n${jsonItems.join(',\n')}\n  ]\n}`;
    const part = {
      index: partIndex,
      content,
      messageCount,
      firstMessageId: firstId,
      lastMessageId: lastId,
      extension: job.format === 'txt' ? 'txt' : 'json',
      mimeType: job.format === 'txt' ? 'text/plain' : 'application/json',
      large,
    };
    partIndex += 1;
    messageCount = 0;
    firstId = null;
    lastId = null;
    jsonItems = [];
    textItems = [];
    contentBytes = 0;
    previousSpeaker = null;
    return part;
  }

  for await (const message of storedMessages(store, job.jobId)) {
    let serialized;
    let nextSpeaker = previousSpeaker;
    if (job.format === 'txt') {
      const result = messageToText(message, previousSpeaker);
      serialized = result.text;
      nextSpeaker = result.lastSpeaker;
    } else {
      serialized = serializeJsonMessage(message);
    }
    let itemBytes = byteLength(serialized) + (messageCount ? 1 : 0);
    if (messageCount > 0 && (messageCount >= maxMessages || contentBytes + itemBytes > maxBytes)) {
      yield finishPart();
      if (job.format === 'txt') {
        const result = messageToText(message, null);
        serialized = result.text;
        nextSpeaker = result.lastSpeaker;
      }
      itemBytes = byteLength(serialized);
    }

    if (job.format === 'txt') {
      if (serialized) {
        textItems.push(serialized);
      }
      previousSpeaker = nextSpeaker;
    }
    else {
      jsonItems.push(serialized);
    }
    contentBytes += itemBytes;
    messageCount += 1;
    firstId ??= message.id;
    lastId = message.id;
  }

  if (messageCount > 0) {
    yield finishPart();
  }
  if (partIndex === 1) {
    yield {
      index: 1,
      content: job.format === 'txt' ? '' : '{\n  "messages": []\n}',
      messageCount: 0,
      firstMessageId: null,
      lastMessageId: null,
      extension: job.format === 'txt' ? 'txt' : 'json',
      mimeType: job.format === 'txt' ? 'text/plain' : 'application/json',
      large: false,
    };
  }
}

export const exportLimits = {
  LARGE_MESSAGE_COUNT,
  LARGE_ESTIMATED_BYTES,
  PART_TARGET_BYTES,
  PART_MESSAGE_LIMIT,
};
