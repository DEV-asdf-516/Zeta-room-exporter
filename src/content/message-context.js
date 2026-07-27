(function registerMessageContext(globalObject) {
  const MESSAGE_ID = /MESSAGE-[A-Za-z0-9_-]+/;

  function messageIdFromString(value) {
    if (typeof value !== 'string') {
      return null;
    }
    return value.match(MESSAGE_ID)?.[0] || null;
  }

  function messageIdFromValue(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) {
      return null;
    }
    seen.add(value);
    for (const key of ['messageId', 'id']) {
      const found = messageIdFromString(value[key]);
      if (found) {
        return found;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'children' || Array.isArray(child)) {
        continue;
      }
      const found = messageIdFromValue(child, depth + 1, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function messageIdFromNode(node) {
    if (!node || typeof node !== 'object') {
      return null;
    }
    for (const attribute of node.attributes || []) {
      const found = messageIdFromString(attribute.value);
      if (found) {
        return found;
      }
    }
    for (const key of Object.keys(node)) {
      if (!key.startsWith('__reactProps$') && !key.startsWith('__reactFiber$')) {
        continue;
      }
      const source = key.startsWith('__reactFiber$') ? node[key]?.memoizedProps : node[key];
      const found = messageIdFromValue(source);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function findMessageId(path) {
    for (const node of path || []) {
      const found = messageIdFromNode(node);
      if (found) {
        return found;
      }
    }
    return null;
  }

  globalObject.ZetaMessageContext = {
    findMessageId,
    messageIdFromString,
    messageIdFromValue,
  };
}(globalThis));
