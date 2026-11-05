import { describe, expect, test } from 'bun:test';
import { bridgeSource } from './bridge';

test('the bridge is plain script that only talks to the editor origin', () => {
  const source = bridgeSource('http://localhost:3000');
  expect(() => new Function(source)).not.toThrow();
  expect(source).toContain('var EDITOR = "http://localhost:3000"');
  expect(source).toContain('e.origin !== EDITOR');
  // An origin can't break out of its string.
  expect(bridgeSource('http://x"; alert(1); "')).toContain('var EDITOR = "http://x\\"; alert(1); \\""');
});

type Listener = (event: Record<string, unknown>) => void;

/** Just enough of a page to run the bridge: listeners, attributes, and text. No layout, no browser. */
function fakePage() {
  const location = { pathname: '/about', search: '', hash: '' };
  const timers: Array<() => void> = [];
  const elements: Array<{ isConnected: boolean; hasAttribute: (name: string) => boolean; getAttribute: (name: string) => string | null; children: unknown[]; style: Record<string, string> }> = [];
  let mutations: ((records: Array<{ target: unknown }>) => void) | null = null;
  const listeners = (store: Map<string, Listener[]>) => ({
    addEventListener: (type: string, fn: Listener) => { store.set(type, [...(store.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: Listener) => { store.set(type, (store.get(type) ?? []).filter((l) => l !== fn)); },
  });
  const element = (tagName: string, attrs: Record<string, string>, textContent: string) => {
    const own = new Map<string, Listener[]>();
    const fire = (type: string) => { for (const fn of own.get(type) ?? []) fn({}); };
    const el = {
      nodeType: 1, tagName, textContent, parentElement: null, children: [] as unknown[], isConnected: true,
      style: { outline: '', outlineOffset: '', cssText: '', display: '' },
      get contentEditable() { return attrs.contenteditable ?? 'inherit'; },
      hasAttribute: (name: string) => name in attrs,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => { attrs[name] = value; },
      removeAttribute: (name: string) => { delete attrs[name]; },
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 }),
      contains: (other: unknown): boolean => other === el,
      appendChild: (child: unknown) => { el.children.push(child); },
      focus: () => undefined,
      blur: () => fire('blur'),
      fire,
      ...listeners(own),
    };
    elements.push(el);
    return el;
  };
  const doc = new Map<string, Listener[]>();
  const win = new Map<string, Listener[]>();
  const sent: Array<Record<string, unknown>> = [];
  const document = {
    ...listeners(doc), documentElement: element('html', {}, ''), createElement: () => element('div', {}, ''),
    querySelector: (selector: string) => {
      const match = /^\[(data-nl-(?:src|inst))="(.*)"\]$/.exec(selector);
      return match ? elements.find(el => el.isConnected && el.getAttribute(match[1]!) === match[2]) ?? null : null;
    },
    querySelectorAll: () => elements.filter(el => el.isConnected && (el.hasAttribute('data-nl-src') || el.hasAttribute('data-nl-inst'))),
  };
  const window = {
    ...listeners(win),
    parent: { postMessage: (message: Record<string, unknown>) => { sent.push(message); } },
    getComputedStyle: (el: { css?: Record<string, string> }) => el.css ?? {},
  };
  class Observer {
    constructor(callback: (records: Array<{ target: unknown }>) => void) { mutations = callback; }
    observe() {}
  }
  new Function('window', 'document', 'location', 'setInterval', 'MutationObserver', bridgeSource('http://editor.test'))(window, document, location, (callback: () => void) => timers.push(callback), Observer);
  return {
    sent,
    element,
    mutate: () => { mutations?.([{ target: document.documentElement }]); },
    outline: () => {
      const box = elements.find(el => el.hasAttribute('data-neat-overlay'));
      const label = box?.children[0];
      return { display: box?.style.display, left: box?.style.left, width: box?.style.width, height: box?.style.height, label: label && typeof label === 'object' && 'textContent' in label ? label.textContent : null };
    },
    last: () => sent.at(-1)!,
    dom: (type: string, extra: Record<string, unknown>) => {
      const e = { prevented: false, preventDefault: () => { e.prevented = true; }, stopPropagation: () => undefined, ...extra };
      for (const fn of doc.get(type) ?? []) fn(e);
      return e;
    },
    fromEditor: (data: Record<string, unknown>, origin = 'http://editor.test') => { for (const fn of win.get('message') ?? []) fn({ origin, data }); },
    resize: () => { for (const fn of win.get('resize') ?? []) fn({}); },
    navigate: (path: string) => { const next = new URL(path, 'http://preview.test'); location.pathname = next.pathname; location.search = next.search; location.hash = next.hash; },
    tick: () => { for (const callback of timers) callback(); },
  };
}

describe('locked selection', () => {
  test('reports a full preview URL while keeping inspection scope on the pathname', () => {
    const page = fakePage();
    page.navigate('/about?view=compact#team');
    page.fromEditor({ type: 'neat:hello' });
    expect(page.last()).toEqual({ type: 'neat:ready', route: '/about', url: '/about?view=compact#team' });
    page.tick();
    expect(page.last()).toEqual({ type: 'neat:route', route: '/about', url: '/about?view=compact#team' });
    page.navigate('/about?view=wide#people');
    page.tick();
    expect(page.last()).toEqual({ type: 'neat:route', route: '/about', url: '/about?view=wide#people' });
  });

  test('redraws the selected outline when the preview viewport changes', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    page.dom('click', { target: heading });
    expect(page.outline()).toMatchObject({ width: '10px', height: '10px' });
    heading.getBoundingClientRect = () => ({ x: 20, y: 40, left: 20, top: 40, width: 280, height: 80 });
    page.resize();
    expect(page.outline()).toMatchObject({ left: '20px', width: '280px', height: '80px', label: 'h1  page.tsx:1:1' });
  });

  test('answers a readiness handshake only from the editor origin', () => {
    const page = fakePage();
    const count = page.sent.length;
    page.fromEditor({ type: 'neat:hello' }, 'https://other.example');
    expect(page.sent.length).toBe(count);
    page.fromEditor({ type: 'neat:hello' });
    expect(page.sent.slice(count)).toEqual([{ type: 'neat:ready', route: '/about', url: '/about' }]);
  });

  test('keeps the clicked outline while hovering another element, until Escape releases it', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    const neighbor = page.element('DIV', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Neighbor');
    page.dom('mousemove', { target: neighbor });
    expect(page.outline().label).toBe('div  page.tsx:2:1');
    page.dom('click', { target: heading });
    page.dom('mousemove', { target: neighbor });
    expect(page.outline()).toMatchObject({ display: 'block', label: 'h1  page.tsx:1:1' });
    page.dom('keydown', { key: 'Escape', target: heading });
    expect(page.last()).toEqual({ type: 'neat:deselect' });
    page.dom('mousemove', { target: neighbor });
    expect(page.outline().label).toBe('div  page.tsx:2:1');
  });

  test('ignores new selections while a source change is saving', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    const neighbor = page.element('DIV', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Neighbor');
    page.dom('click', { target: heading });
    page.fromEditor({ type: 'neat:busy', busy: true });
    page.dom('click', { target: neighbor });
    expect(page.last()).toMatchObject({ type: 'neat:select', target: { src: 'app/page.tsx:1:1' } });
    page.fromEditor({ type: 'neat:busy', busy: false });
    page.dom('click', { target: neighbor });
    expect(page.last()).toMatchObject({ type: 'neat:select', target: { src: 'app/page.tsx:2:1' } });
  });
});

describe('following source tags through hot reload', () => {
  test('waits for the selected element instead of outlining its old neighbor', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    const neighbor = page.element('DIV', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Neighbor');
    page.dom('click', { target: heading });
    page.fromEditor({ type: 'neat:reselect', tag: 'app/page.tsx:2:1' });
    expect(page.outline().display).toBe('none');
    heading.setAttribute('data-nl-src', 'app/page.tsx:2:1');
    neighbor.setAttribute('data-nl-src', 'app/page.tsx:3:1');
    page.mutate();
    expect(page.outline()).toMatchObject({ display: 'block', label: 'h1  page.tsx:2:1' });
  });

  test('retains the confirmed tag when hot reload replaces a node after the response', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    page.dom('click', { target: heading });
    page.fromEditor({ type: 'neat:reselect', tag: 'app/page.tsx:1:1' });
    heading.isConnected = false;
    const replacement = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Updated heading');
    replacement.getBoundingClientRect = () => ({ x: 80, y: 40, left: 80, top: 40, width: 10, height: 10 });
    page.mutate();
    expect(page.outline()).toMatchObject({ display: 'block', left: '80px', label: 'h1  page.tsx:1:1' });
  });

  test('keeps the same node when tags change before the editor responds', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    const neighbor = page.element('DIV', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Neighbor');
    page.dom('click', { target: heading });
    heading.setAttribute('data-nl-src', 'app/page.tsx:2:1');
    neighbor.setAttribute('data-nl-src', 'app/page.tsx:1:1');
    page.mutate();
    expect(page.outline()).toMatchObject({ display: 'block', label: 'h1  page.tsx:2:1' });
    page.fromEditor({ type: 'neat:reselect', tag: 'app/page.tsx:2:1' });
    page.mutate();
    expect(page.outline()).toMatchObject({ display: 'block', label: 'h1  page.tsx:2:1' });
  });

  test('does not bind a detached node to its neighbor before a response', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    const neighbor = page.element('DIV', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Neighbor');
    page.dom('click', { target: heading });
    heading.isConnected = false;
    neighbor.setAttribute('data-nl-src', 'app/page.tsx:1:1');
    page.element('H1', { 'data-nl-src': 'app/page.tsx:2:1' }, 'Updated heading');
    page.mutate();
    expect(page.outline().display).toBe('none');
    page.fromEditor({ type: 'neat:reselect', tag: 'app/page.tsx:2:1' });
    expect(page.outline()).toMatchObject({ display: 'block', label: 'h1  page.tsx:2:1' });
  });

  test('clearing a pending selection prevents its later return', () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': 'app/page.tsx:1:1' }, 'Heading');
    page.dom('click', { target: heading });
    page.fromEditor({ type: 'neat:reselect', tag: 'app/page.tsx:2:1' });
    page.fromEditor({ type: 'neat:clear' });
    heading.setAttribute('data-nl-src', 'app/page.tsx:2:1');
    page.mutate();
    expect(page.outline().display).toBe('none');
  });
});

describe('editing text in place', () => {
  const KEY = 'app/about/page.tsx:9:9';
  const start = () => {
    const page = fakePage();
    const heading = page.element('H1', { 'data-nl-src': KEY }, 'Four people, one studio');
    page.dom('dblclick', { target: heading });
    return { page, heading };
  };

  test('a double-click asks the editor first, and typing starts only when the editor says the text is editable', () => {
    const { page, heading } = start();
    expect(page.last()).toMatchObject({ type: 'neat:text-request', route: '/about', target: { src: KEY, element: 'h1' } });
    expect(heading.hasAttribute('contenteditable')).toBe(false);

    page.fromEditor({ type: 'neat:text-edit', key: KEY }, 'http://elsewhere.test');
    page.fromEditor({ type: 'neat:text-edit', key: 'app/other.tsx:1:1' });
    expect(heading.hasAttribute('contenteditable')).toBe(false);

    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    expect(heading.getAttribute('contenteditable')).toBe('plaintext-only');
  });

  test('a source save invalidates delayed text approval and cancels active typing', () => {
    const { page, heading } = start();
    page.fromEditor({ type: 'neat:busy', busy: true });
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    page.fromEditor({ type: 'neat:busy', busy: false });
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    expect(heading.hasAttribute('contenteditable')).toBe(false);
    page.dom('dblclick', { target: heading });
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    expect(heading.getAttribute('contenteditable')).toBe('plaintext-only');
    heading.textContent = 'Unsaved typing';
    page.fromEditor({ type: 'neat:busy', busy: true });
    expect(heading.textContent).toBe('Four people, one studio');
    expect(heading.hasAttribute('contenteditable')).toBe(false);
    expect(page.last()).toMatchObject({ type: 'neat:text-cancel', key: KEY });
  });

  test('Enter commits the typed text with its whitespace tidied', () => {
    const { page, heading } = start();
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    heading.textContent = '  Five people,\n one   studio ';
    const enter = page.dom('keydown', { key: 'Enter', target: heading });
    expect(enter.prevented).toBe(true);
    expect(page.last()).toEqual({ type: 'neat:text-commit', key: KEY, text: 'Five people, one studio', route: '/about' });
    expect(heading.hasAttribute('contenteditable')).toBe(false);
    expect(heading.textContent).toBe('Five people, one studio');
    // Nothing more is sent when the element then loses focus.
    const count = page.sent.length;
    heading.fire('blur');
    expect(page.sent.length).toBe(count);
  });

  test('leaving the element commits too', () => {
    const { page, heading } = start();
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    heading.textContent = 'Five people';
    heading.fire('blur');
    expect(page.last()).toMatchObject({ type: 'neat:text-commit', text: 'Five people' });
  });

  test('Escape cancels and puts the original text back', () => {
    const { page, heading } = start();
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    heading.textContent = 'Something else';
    page.dom('keydown', { key: 'Escape', target: heading });
    expect(page.last()).toEqual({ type: 'neat:text-cancel', key: KEY, reason: 'unchanged' });
    expect(heading.textContent).toBe('Four people, one studio');
    expect(heading.hasAttribute('contenteditable')).toBe(false);
  });

  test('unchanged or emptied text is not committed', () => {
    const same = start();
    same.page.fromEditor({ type: 'neat:text-edit', key: KEY });
    same.page.dom('keydown', { key: 'Enter', target: same.heading });
    expect(same.page.last()).toMatchObject({ type: 'neat:text-cancel', reason: 'unchanged' });

    const emptied = start();
    emptied.page.fromEditor({ type: 'neat:text-edit', key: KEY });
    emptied.heading.textContent = '   ';
    emptied.page.dom('keydown', { key: 'Enter', target: emptied.heading });
    expect(emptied.page.last()).toMatchObject({ type: 'neat:text-cancel', reason: 'empty' });
    expect(emptied.heading.textContent).toBe('Four people, one studio');
  });

  test('a refused edit is put back when the editor says so', () => {
    const { page, heading } = start();
    page.fromEditor({ type: 'neat:text-edit', key: KEY });
    heading.textContent = 'Five people';
    page.dom('keydown', { key: 'Enter', target: heading });
    page.fromEditor({ type: 'neat:text-revert', key: KEY });
    expect(heading.textContent).toBe('Four people, one studio');
  });

  test('text that keeps its spaces and line breaks is never made editable, so its formatting is not rewritten', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['PRE', {}],
      ['P', { whiteSpace: 'pre' }],
      ['P', { whiteSpace: 'pre-wrap' }],
      ['P', { whiteSpace: 'pre-line' }],
      ['P', { whiteSpace: 'break-spaces' }],
      // Browsers that report the longhand instead of the shorthand.
      ['P', { whiteSpace: 'normal', whiteSpaceCollapse: 'preserve' }],
      ['P', { whiteSpaceCollapse: 'preserve-breaks' }],
    ];
    for (const [tagName, css] of cases) {
      const page = fakePage();
      const block = Object.assign(page.element(tagName, { 'data-nl-src': KEY }, 'npm install\n  --save   orbit'), { css });
      page.dom('dblclick', { target: block });
      expect(page.last()).toEqual({ type: 'neat:text-cancel', key: KEY, reason: 'preformatted' });
      // Even if the editor answered, there is nothing waiting to be edited.
      page.fromEditor({ type: 'neat:text-edit', key: KEY });
      expect(block.hasAttribute('contenteditable')).toBe(false);
      expect(block.textContent).toBe('npm install\n  --save   orbit');
    }
    // Ordinary wrapping text still goes to the editor.
    const page = fakePage();
    page.dom('dblclick', { target: Object.assign(page.element('P', { 'data-nl-src': KEY }, 'Plain'), { css: { whiteSpace: 'normal', whiteSpaceCollapse: 'collapse' } }) });
    expect(page.last()).toMatchObject({ type: 'neat:text-request' });
    page.dom('dblclick', { target: Object.assign(page.element('P', { 'data-nl-src': KEY }, 'Plain'), { css: { whiteSpace: 'nowrap' } }) });
    expect(page.last()).toMatchObject({ type: 'neat:text-request' });
  });

  test('an element with child elements is never made editable', () => {
    const page = fakePage();
    const row = page.element('DIV', { 'data-nl-src': 'app/page.tsx:12:9' }, 'Start a project See our work');
    row.children.push(page.element('A', {}, 'Start a project'));
    page.dom('dblclick', { target: row });
    page.fromEditor({ type: 'neat:text-edit', key: 'app/page.tsx:12:9' });
    expect(row.hasAttribute('contenteditable')).toBe(false);
    expect(page.last()).toEqual({ type: 'neat:text-cancel', key: 'app/page.tsx:12:9', reason: 'mixed' });
  });
});
