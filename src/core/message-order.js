const PRECISE_UTC_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

export function messageOrderKey(value) {
  if (typeof value === 'string') {
    const match = value.match(PRECISE_UTC_TIME);
    if (match) {
      return `${match[1]}.${(match[2] || '').padEnd(9, '0').slice(0, 9)}Z`;
    }
  }
  const milliseconds = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  try {
    const iso = new Date(milliseconds).toISOString();
    return iso.replace(/\.(\d{3})Z$/, '.$1000000Z');
  } catch {
    return null;
  }
}

export function messageTuple(message) {
  return [messageOrderKey(message?.messageTime), String(message?.id ?? '')];
}

export function compareMessageTuples(left, right) {
  if (left[0] !== right[0]) {
    if (left[0] === null) {
      return -1;
    }
    if (right[0] === null) {
      return 1;
    }
    return left[0] < right[0] ? -1 : 1;
  }
  return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
}
