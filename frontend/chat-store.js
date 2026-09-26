/* ==========================================================================
   Octix AI — chat storage & schema migration module  (frontend/chat-store.js)
   --------------------------------------------------------------------------
   Single owner of the two LOCALSTORAGE KEYS (names are a backward-compat
   contract and must NEVER be renamed):

       aetherChats        -> JSON array of chat objects
       aetherActiveChatId -> string id of the open chat

   Schema (v: 2), written alongside the legacy fields — never instead of them:

       {
         id, title,
         v: 2,
         createdAt, savedAt,
         messages: [{ id, role, content, contentHtml, attachments,
                      model, status, error, createdAt, updatedAt }],
         html   // ALWAYS kept: legacy rendering path + rollback safety
       }

   Migration is LAZY and PER-CHAT: an old entry is only upgraded when it is
   loaded or saved. Nothing is bulk-migrated at startup, no entry is ever
   deleted, and if parsing fails the original entry is kept untouched so the
   legacy `html` rendering path still works.

   Loading style: UMD — browser gets `window.OctixChatStore`, Node gets
   module.exports (so the normalization/migration logic is unit-testable
   without a DOM; the DOM parser itself is injectable for tests).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OctixChatStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHATS_KEY = 'aetherChats';
  var ACTIVE_KEY = 'aetherActiveChatId';
  var SCHEMA_VERSION = 2;

  // ---- storage ----------------------------------------------------------
  function getStorage(preferred) {
    if (preferred) return preferred;
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) {}
    return null;
  }

  // Returns [] on anything unexpected. Never throws. On corrupt JSON the
  // stored string is left untouched (we only read) and the failure is logged.
  function loadChats(storage) {
    var s = getStorage(storage);
    if (!s) return [];
    var raw;
    try { raw = s.getItem(CHATS_KEY); } catch (e) {
      console.error('chat-store: could not read chat history (storage blocked).', e);
      return [];
    }
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      console.error('chat-store: chat history is unreadable (invalid JSON). ' +
        'Stored value left untouched — nothing was deleted.', e);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.error('chat-store: chat history has an unexpected shape (not an array). Stored value left untouched.');
      return [];
    }
    return parsed;
  }

  // Returns true on success. On failure (e.g. QuotaExceededError) the PREVIOUS
  // stored value is preserved by the browser, and the failure is surfaced via
  // console.error + a returned false (never silently swallowed).
  function saveChats(chats, storage) {
    var s = getStorage(storage);
    if (!s) {
      console.error('chat-store: no localStorage available — chat history was NOT saved.');
      return false;
    }
    var payload;
    try { payload = JSON.stringify(chats); } catch (e) {
      console.error('chat-store: chat history could not be serialized — nothing was written.', e);
      return false;
    }
    try {
      s.setItem(CHATS_KEY, payload);
      return true;
    } catch (e) {
      var isQuota = (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22));
      console.error(isQuota
        ? 'chat-store: storage quota exceeded — chat history was NOT updated (previous history preserved). Free up browser storage or delete old chats.'
        : 'chat-store: could not save chat history (previous history preserved).', e);
      return false;
    }
  }

  function loadActiveId(storage) {
    var s = getStorage(storage);
    if (!s) return null;
    try { return s.getItem(ACTIVE_KEY); } catch (e) { return null; }
  }

  function saveActiveId(id, storage) {
    var s = getStorage(storage);
    if (!s) { console.error('chat-store: no localStorage available — active chat id was NOT saved.'); return false; }
    try { s.setItem(ACTIVE_KEY, String(id)); return true; } catch (e) {
      console.error('chat-store: could not save active chat id (previous value preserved).', e);
      return false;
    }
  }

  function createChatId() { return 'chat-' + Date.now(); }

  // ---- schema helpers ---------------------------------------------------
  function isCurrent(chat) {
    return !!chat && typeof chat === 'object' && chat.v === SCHEMA_VERSION && Array.isArray(chat.messages);
  }

  function needsMigration(chat) { return !isCurrent(chat); }

  function hasClass(el, name) {
    var cls = (el && el.className != null) ? String(el.className) : '';
    return (' ' + cls + ' ').indexOf(' ' + name + ' ') !== -1;
  }

  function safeAttr(el, name) {
    if (!el) return null;
    if (typeof el.getAttribute === 'function') { var v = el.getAttribute(name); return v; }
    return null;
  }

  // Build messages[] from a DOM root: either the LIVE #messages element (on
  // save) or a DETACHED <template>.content (when migrating an old chat.html).
  // Returns null when the root is unusable, so callers keep the chat as-is.
  function extractMessages(root, defaults) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    var rows;
    try { rows = root.querySelectorAll('.msg'); } catch (e) { return null; }
    if (!rows || typeof rows.length !== 'number') return null;
    defaults = defaults || {};
    var fallbackTs = (typeof defaults.createdAt === 'number') ? defaults.createdAt : (typeof defaults.now === 'number' ? defaults.now : Date.now());
    var now = (typeof defaults.now === 'number') ? defaults.now : Date.now();
    var out = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row.querySelector !== 'function') continue;
      var textEl = row.querySelector('.msg-text');
      var tagEl = row.querySelector('.msg-model-tag');
      var tag = tagEl ? String(tagEl.textContent || '').trim() : '';
      var isUser = hasClass(row, 'user');

      var tsRaw = safeAttr(row, 'data-ts');
      var ts = tsRaw ? parseInt(tsRaw, 10) : NaN;
      if (!isFinite(ts)) ts = fallbackTs;

      var content = textEl ? String(textEl.textContent || '') : '';
      var contentHtml = textEl && typeof textEl.innerHTML === 'string' ? textEl.innerHTML : null;

      // attachments: inline <img> + "file" chips ("📄 name")
      var attachments = [];
      if (textEl && typeof textEl.querySelectorAll === 'function') {
        var imgs = textEl.querySelectorAll('img');
        for (var k = 0; imgs && k < imgs.length; k++) {
          var src = imgs[k] && (typeof imgs[k].getAttribute === 'function' ? imgs[k].getAttribute('src') : null);
          if (src) attachments.push({ type: 'image', src: src });
        }
        var divs = textEl.querySelectorAll('div');
        for (var d = 0; divs && d < divs.length; d++) {
          var t = String((divs[d] && divs[d].textContent) || '').trim();
          // U+1F4C4 "page facing up" is a surrogate PAIR in UTF-16, so compare
          // both code units (charAt(0) alone would only see the high surrogate).
          if (t.slice(0, 2) === '\uD83D\uDCC4') attachments.push({ type: 'file', name: t.slice(2).trim() });
        }
      }

      var status = 'complete';
      if (typeof row.querySelector === 'function' && row.querySelector('.typing-dots')) status = 'streaming';

      out.push({
        id: 'msg-' + ts.toString(36) + '-' + i + '-' + now.toString(36),
        role: isUser ? 'user' : (tag === 'system' ? 'system' : 'assistant'),
        content: content,
        contentHtml: contentHtml,
        attachments: attachments,
        model: (tag && tag !== 'system') ? { label: tag } : null,
        status: status,
        error: null,
        createdAt: ts,
        updatedAt: null
      });
    }
    return out;
  }

  // Browser path: parse old chat.html in a DETACHED <template> (no rendering,
  // images do not load). Returns null when there is no DOM or nothing parses.
  function htmlToMessages(html) {
    if (typeof html !== 'string' || !html) return null;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var tpl;
    try {
      tpl = document.createElement('template');
      tpl.innerHTML = html;
    } catch (e) { return null; }
    var root = (tpl.content && typeof tpl.content.querySelectorAll === 'function') ? tpl.content : tpl;
    var msgs = extractMessages(root, null);
    if (!msgs || !msgs.length) return null;
    return msgs;
  }

  // Lazy per-chat migration. Returns the SAME chat object when nothing was
  // done, a NEW object (original fields + v/messages/createdAt) on success,
  // and the ORIGINAL object untouched when parsing fails.
  function migrateChat(chat, deps) {
    if (!chat || typeof chat !== 'object') return chat;      // malformed entry: keep
    if (isCurrent(chat)) return chat;                         // already current
    if (typeof chat.html !== 'string' || !chat.html) return chat; // nothing to parse: keep

    var parse = (deps && typeof deps.htmlToMessages === 'function') ? deps.htmlToMessages : htmlToMessages;
    var messages = null;
    try { messages = parse(chat.html); } catch (e) {
      console.error('chat-store: could not parse an old chat — keeping it in its original format.', e);
      messages = null;
    }
    if (!messages || !messages.length) return chat;           // parse failed: keep original

    var migrated = {};
    for (var key in chat) {
      if (Object.prototype.hasOwnProperty.call(chat, key)) migrated[key] = chat[key];
    }
    migrated.v = SCHEMA_VERSION;
    if (typeof migrated.createdAt !== 'number') {
      migrated.createdAt = (typeof chat.savedAt === 'number') ? chat.savedAt : Date.now();
    }
    migrated.messages = messages;
    // html intentionally untouched — legacy rendering + rollback keep working
    return migrated;
  }

  // On save: stamp v:2 + messages[] built from the LIVE message element.
  // Never removes existing fields (html/title/id/savedAt are managed outside).
  function toCurrent(chat, root, now) {
    if (!chat || typeof chat !== 'object') return chat;
    now = (typeof now === 'number') ? now : Date.now();
    if (typeof chat.createdAt !== 'number') {
      chat.createdAt = (typeof chat.savedAt === 'number') ? chat.savedAt : now;
    }
    var msgs = null;
    try { msgs = extractMessages(root, { createdAt: chat.createdAt, now: now }); } catch (e) { msgs = null; }
    if (msgs) {
      chat.v = SCHEMA_VERSION;
      chat.messages = msgs;
    } else {
      console.error('chat-store: could not build structured messages for this chat — html was still saved.');
    }
    return chat;
  }

  return {
    CHATS_KEY: CHATS_KEY,
    ACTIVE_KEY: ACTIVE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    loadChats: loadChats,
    saveChats: saveChats,
    loadActiveId: loadActiveId,
    saveActiveId: saveActiveId,
    createChatId: createChatId,
    isCurrent: isCurrent,
    needsMigration: needsMigration,
    extractMessages: extractMessages,
    htmlToMessages: htmlToMessages,
    migrateChat: migrateChat,
    toCurrent: toCurrent
  };
});
