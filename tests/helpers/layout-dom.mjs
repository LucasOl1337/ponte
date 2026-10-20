// A small DOM for tests/mobile-control-layout.test.mjs: tree edits, capture and
// bubble phases with stopImmediatePropagation, simple selectors, and boxes that
// follow style.left/top once an element is position:fixed (the way the module
// places them). Sizes and default positions are given per element.
class Node {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.attrs = {}; this.listeners = []; this.style = {}; this._text = ''; this.hidden = false;
    this.box = { left: 0, top: 0, width: 0, height: 0 };
  }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = String(value); }
  get id() { return this.attrs.id || ''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node === this.ownerDocument.root; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return name in this.attrs; }
  appendChild(child) { child.parentElement?.removeChild(child); child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentElement?.removeChild(child);
    child.parentElement = this; this.children.splice(this.children.indexOf(ref), 0, child); return child;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; return child; }
  remove() { this.parentElement?.removeChild(this); }
  get nextSibling() { const list = this.parentElement?.children || []; return list[list.indexOf(this) + 1] || null; }
  contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const tag = /^[a-z]+/i.exec(part); if (tag && tag[0].toUpperCase() !== this.tagName) return false;
      for (const match of part.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(match[1])) return false;
      for (const match of part.matchAll(/#([\w-]+)/g)) if (this.id !== match[1]) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)) if (!(match[1] in this.attrs) || (match[2] !== undefined && this.attrs[match[1]] !== match[2])) return false;
      return true;
    });
  }
  querySelectorAll(selector) { const out = []; const visit = node => node.children.forEach(child => { if (child.matches(selector)) out.push(child); visit(child); }); visit(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node && node.tagName !== '#DOCUMENT'; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  addEventListener(type, handler, options) { this.listeners.push({ type, handler, capture: options === true || !!options?.capture }); }
  removeEventListener(type, handler, options) { const capture = options === true || !!options?.capture; this.listeners = this.listeners.filter(entry => !(entry.type === type && entry.handler === handler && entry.capture === capture)); }
  getBoundingClientRect() {
    const fixed = this.style.position === 'fixed' && this.style.left;
    const left = fixed ? parseFloat(this.style.left) : this.box.left, top = fixed ? parseFloat(this.style.top) : this.box.top;
    const visible = !this.hidden && this.isConnected;
    return { left, top, width: visible ? this.box.width : 0, height: visible ? this.box.height : 0 };
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
}
export function makeLayoutDom({ width = 390, height = 844 } = {}) {
  const document = new Node(null, '#document');
  document.ownerDocument = document; document.root = document;
  document.body = document.appendChild(new Node(document, 'body'));
  document.createElement = tag => new Node(document, tag);
  document.createComment = () => new Node(document, '#comment');
  document.activeElement = document.body;
  const window = { innerWidth: width, innerHeight: height, listeners: [], frames: [],
    addEventListener(type, handler) { this.listeners.push({ type, handler }); }, removeEventListener(type, handler) { this.listeners = this.listeners.filter(entry => entry.handler !== handler); },
    matchMedia: query => ({ matches: /coarse|max-width/.test(query) }),
    getComputedStyle: () => ({ paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0' }),
    requestAnimationFrame(callback) { this.frames.push(callback); return this.frames.length; },
    flush() { while (this.frames.length) this.frames.shift()(); },
    resize(w, h) { this.innerWidth = w; this.innerHeight = h; this.listeners.filter(entry => entry.type === 'resize').forEach(entry => entry.handler({ type: 'resize' })); this.flush(); } };
  return { document, window };
}
export function el(document, tag, attrs = {}, box = null, parent = document.body) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (box) node.box = { ...box };
  parent.appendChild(node);
  return node;
}
// Dispatches like a browser: capture from the document down, then bubble up.
export function fire(target, type, init = {}) {
  const path = []; for (let node = target; node; node = node.parentElement) path.unshift(node);
  const event = { type, target, defaultPrevented: false, stopped: false, immediate: false, ...init,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
  const run = (node, capture) => { for (const entry of [...node.listeners]) { if (entry.type !== type || entry.capture !== capture) continue; entry.handler(event); if (event.immediate) return; } };
  for (const node of path) { run(node, true); if (event.stopped) return event; }
  for (const node of path.reverse()) { run(node, false); if (event.stopped) return event; }
  return event;
}
