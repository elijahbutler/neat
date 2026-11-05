/**
 * The script the preview runs so the editor can see what's under the pointer. It's written into the sandbox copy as
 * Next's `instrumentation-client.js`, so it loads on every page without touching the app's own files.
 *
 * Messages are only sent to, and only accepted from, the editor's origin.
 */
export function bridgeSource(editorOrigin: string): string {
  return `// Written by Neat Labs into the sandbox copy only. Never committed.
(function () {
  if (typeof window === 'undefined' || window.parent === window) return;
  var EDITOR = ${JSON.stringify(editorOrigin)};
  var selecting = true;
  var busy = false;
  var confirmedTag = null;
  var box = null;
  var label = null;
  var selected = null;
  var wantedTag = null;
  var waitingNode = null;
  var waitingKey = null;
  // In-place text editing. \`asked\` is the element whose text the editor is checking, \`editing\` the one being typed
  // in, and \`committed\` the last one sent, kept so a refused edit can be put back.
  var asked = null;
  var editing = null;
  var committed = null;

  function send(message) { window.parent.postMessage(message, EDITOR); }

  function tagged(el) {
    while (el && el.nodeType === 1) {
      if (el.hasAttribute('data-nl-src') || el.hasAttribute('data-nl-inst')) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Tagged ancestors, nearest first, each with the index of its element child that contains the selection. The worker
  // uses this to find which JSX instance rendered a component that doesn't pass its source tag through to the DOM.
  function ancestry(el) {
    var out = [];
    for (var child = el, node = el.parentElement; node && out.length < 12; child = node, node = node.parentElement) {
      if (node.hasAttribute('data-nl-src') || node.hasAttribute('data-nl-inst')) {
        out.push({ src: node.getAttribute('data-nl-src'), inst: node.getAttribute('data-nl-inst'), childIndex: Array.prototype.indexOf.call(node.children, child) });
      }
    }
    return out;
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    return {
      ancestors: ancestry(el),
      src: el.getAttribute('data-nl-src'),
      inst: el.getAttribute('data-nl-inst'),
      element: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 80),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }

  function overlay() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('data-neat-overlay', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:1.5px solid #01ea40;background:rgba(1,234,64,0.06);transition:all 60ms ease-out;display:none';
    label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:-1.5px;top:-20px;font:500 11px/18px ui-monospace,Menlo,monospace;background:#01ea40;color:#000;padding:0 6px;white-space:nowrap';
    box.appendChild(label);
    document.documentElement.appendChild(box);
  }

  function show(el, name) {
    overlay();
    if (!el) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    label.textContent = name;
    label.style.top = r.top < 22 ? '100%' : '-20px';
  }

  function nameOf(el) {
    var inst = el.getAttribute('data-nl-inst');
    var src = el.getAttribute('data-nl-src');
    var tag = inst || src || '';
    return el.tagName.toLowerCase() + '  ' + tag.split('/').pop();
  }

  function keyOf(el) { return el.getAttribute('data-nl-inst') || el.getAttribute('data-nl-src'); }

  function restoreSelection(confirmed) {
    if (!selecting || editing) return;
    // Before the editor confirms a new tag, keep the node's identity. Its old tag may already name a neighbor.
    if (!wantedTag && selected && !selected.isConnected && confirmedTag) wantedTag = confirmedTag;
    if (!wantedTag) {
      if (selected) show(selected.isConnected ? selected : null, selected.isConnected ? nameOf(selected) : '');
      return;
    }
    // The new tag can still name a neighbor in the old DOM. Wait until the selected node changes or leaves it.
    if (waitingNode && waitingNode.isConnected && keyOf(waitingNode) === waitingKey && wantedTag !== waitingKey) {
      show(null, '');
      return;
    }
    if (waitingNode && waitingNode.isConnected) {
      selected = waitingNode;
      confirmedTag = wantedTag;
      wantedTag = null;
      waitingNode = null;
      waitingKey = null;
      show(selected, nameOf(selected));
      return;
    }
    if (!confirmed && wantedTag === waitingKey) { show(null, ''); return; }
    var key = wantedTag;
    var nodes = document.querySelectorAll('[data-nl-inst], [data-nl-src]');
    var next = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-nl-inst') === key || nodes[i].getAttribute('data-nl-src') === key) { next = nodes[i]; break; }
    }
    if (!next) { show(null, ''); return; }
    waitingNode = null;
    waitingKey = null;
    wantedTag = null;
    selected = next;
    confirmedTag = key;
    show(selected, nameOf(selected));
  }

  function clearSelection() {
    selected = null;
    confirmedTag = null;
    wantedTag = null;
    waitingNode = null;
    waitingKey = null;
    show(null, '');
  }

  function clean(text) { return String(text || '').replace(/\\s+/g, ' ').trim(); }

  // Whether the element shows its spaces and line breaks as written, as a <pre> or white-space: pre-wrap does.
  // Typed text is tidied to single spaces before it is saved, and JSX text can't hold line breaks anyway, so
  // editing such text in place would rewrite formatting the person never touched.
  function keepsWhitespace(el) {
    if (el.tagName === 'PRE' || el.tagName === 'TEXTAREA') return true;
    if (!window.getComputedStyle) return false;
    var style = window.getComputedStyle(el);
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(style.whiteSpace || '')
      || /^(preserve|preserve-breaks|preserve-spaces|break-spaces)$/.test(style.whiteSpaceCollapse || '');
  }

  function startEditing(el) {
    // Only text that is the element's whole content can be typed over without disturbing what React rendered.
    if (el.children.length > 0) { send({ type: 'neat:text-cancel', key: keyOf(el), reason: 'mixed' }); return; }
    editing = { el: el, key: keyOf(el), original: el.textContent, outline: el.style.outline, offset: el.style.outlineOffset };
    show(null, '');
    el.setAttribute('contenteditable', 'plaintext-only');
    if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
    el.style.outline = '1.5px solid #01ea40';
    el.style.outlineOffset = '2px';
    el.addEventListener('blur', onBlur);
    el.focus();
    if (window.getSelection && document.createRange) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  // Enter and leaving the element commit; Escape cancels. Either way the element goes back to how React left it,
  // with the new text shown at once so the page doesn't flicker while the source file is written.
  function finishEditing(commit) {
    if (!editing) return;
    var edit = editing;
    editing = null;
    var el = edit.el;
    // textContent, not innerText: innerText applies CSS such as uppercase, which must not reach the source.
    var text = clean(el.textContent);
    el.removeEventListener('blur', onBlur);
    el.removeAttribute('contenteditable');
    el.style.outline = edit.outline;
    el.style.outlineOffset = edit.offset;
    if (commit && text && text !== clean(edit.original)) {
      el.textContent = text;
      committed = edit;
      send({ type: 'neat:text-commit', key: edit.key, text: text, route: location.pathname });
    } else {
      el.textContent = edit.original;
      send({ type: 'neat:text-cancel', key: edit.key, reason: commit && !text ? 'empty' : 'unchanged' });
    }
    if (el.blur) el.blur();
    restoreSelection(false);
  }

  function onBlur() { finishEditing(true); }

  document.addEventListener('keydown', function (e) {
    if (!editing) {
      if (e.key === 'Escape' && selected && !busy) { clearSelection(); send({ type: 'neat:deselect' }); }
      return;
    }
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finishEditing(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEditing(false); }
  }, true);

  document.addEventListener('dblclick', function (e) {
    if (!selecting || editing || busy) return;
    var el = tagged(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (keepsWhitespace(el)) { asked = null; send({ type: 'neat:text-cancel', key: keyOf(el), reason: 'preformatted' }); return; }
    asked = el;
    send({ type: 'neat:text-request', target: describe(el), route: location.pathname });
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!selecting || editing || busy || selected) return;
    var el = tagged(e.target);
    show(el, el ? nameOf(el) : '');
  }, true);

  document.addEventListener('click', function (e) {
    if (!selecting) return;
    if (busy) { e.preventDefault(); e.stopPropagation(); return; }
    if (editing) {
      // A click in the text places the caret; it must not follow a link, press a button, or change the selection.
      if (editing.el.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    var el = tagged(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    selected = el;
    confirmedTag = null;
    wantedTag = null;
    waitingNode = null;
    waitingKey = null;
    show(el, nameOf(el));
    send({ type: 'neat:select', target: describe(el), route: location.pathname });
  }, true);

  window.addEventListener('scroll', function () { if (selected && selecting && !editing) show(selected, nameOf(selected)); }, true);

  window.addEventListener('message', function (e) {
    if (e.origin !== EDITOR || !e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'neat:busy') { busy = !!e.data.busy; if (busy) { confirmedTag = null; asked = null; finishEditing(false); } }
    if (e.data.type === 'neat:mode') {
      selecting = !!e.data.selecting;
      if (!selecting) { finishEditing(false); clearSelection(); }
    }
    // The editor answers a double-click once the worker has confirmed the text is written in the JSX.
    if (e.data.type === 'neat:text-edit' && selecting && !busy && asked && asked.isConnected && keyOf(asked) === e.data.key && !editing) startEditing(asked);
    if (e.data.type === 'neat:text-revert' && committed && committed.key === e.data.key) {
      committed.el.textContent = committed.original;
      committed = null;
    }
    if (e.data.type === 'neat:clear') clearSelection();
    if (e.data.type === 'neat:reselect') {
      if (selected) { waitingNode = selected; waitingKey = keyOf(selected); }
      wantedTag = typeof e.data.tag === 'string' ? e.data.tag : null;
      if (wantedTag) restoreSelection(true);
      else clearSelection();
    }
  });

  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        // Drawing the outline changes its own text node. Ignore those mutations to avoid observing our own redraws.
        var target = records[i].target;
        if (box && box.contains(target)) continue;
        if (wantedTag || (selected && (!selected.isConnected || target === document.documentElement || selected.contains(target) || target.contains(selected)))) { restoreSelection(false); break; }
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-nl-src', 'data-nl-inst', 'class'] });
  }

  var last = '';
  setInterval(function () {
    if (location.pathname !== last) { last = location.pathname; send({ type: 'neat:route', route: last }); }
  }, 300);
  send({ type: 'neat:ready', route: location.pathname });
})();
`;
}
