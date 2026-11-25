// DOM 注入引擎 —— chrome.scripting.executeScript 会把 func 序列化后在页面隔离世界执行，
// 因此 actionFn / evalFn 必须【完全自包含】：不能引用任何外部变量，参数一律走 args。
// CDP 备用通路（server/cdp-backend.mjs）会 String(actionFn) 复用同一份逻辑。

export function actionFn(job) {
  // job.action: refs | extract | click | type | fill | focusOf | submitFrom | rectOf | scroll | key | viewport | wait
  const W = window;

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function resolve(loc) {
    let el = null;
    if (loc.ref) el = (W.__zcodeRefs && W.__zcodeRefs.get(loc.ref)) || null;
    if (!el && loc.selector) {
      try { el = document.querySelector(loc.selector); } catch (e) { throw new Error("invalid selector: " + e.message); }
    }
    if (!el && loc.text) {
      const needle = String(loc.text).trim().toLowerCase();
      const cands = document.querySelectorAll(
        'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary, ' +
        'input[type="button"], input[type="submit"], input[type="reset"], [onclick]'
      );
      for (const c of cands) {
        const t = ((c.innerText || c.textContent || "") + " " + (c.value || "") + " " + (c.getAttribute("aria-label") || "")).trim().toLowerCase();
        if (t.includes(needle) && c.getBoundingClientRect().width > 0) { el = c; break; }
      }
    }
    if (!el) {
      throw new Error("target not found" + (loc.ref ? " (ref=" + loc.ref + " — refs 可能已过期，请重新调用 page.refs)" : ""));
    }
    return el;
  }

  function ensureShown(el) {
    if (!(el instanceof Element)) throw new Error("target is not an element");
    if (!(el.getBoundingClientRect().width > 0)) el.scrollIntoView({ block: "center" });
  }

  function describe(el) {
    let ref;
    if (W.__zcodeRefs) for (const [k, v] of W.__zcodeRefs) if (v === el) { ref = k; break; }
    const o = { ref, tag: el.tagName.toLowerCase() };
    if (el.id) o.id = el.id;
    const t = ((el.innerText || el.value || "") + "").trim().slice(0, 80);
    if (t) o.text = t;
    if (el.value !== undefined) o.value = String(el.value).slice(0, 120);
    return o;
  }

  // React/Vue 兼容输入：用原型 setter 绕过被框架劫持的 value，再补 input/change 事件
  function typeInto(el, text, clear) {
    ensureShown(el);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      if (clear !== false) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, "value");
        if (d && d.set) d.set.call(el, ""); else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      if (clear !== false) el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } else if (el instanceof HTMLSelectElement) {
      const want = String(text);
      const opts = Array.from(el.options);
      const hit = opts.find((o) => o.value === want)
        || opts.find((o) => o.text.trim() === want)
        || opts.find((o) => o.text.trim().includes(want));
      if (!hit) throw new Error("select option not found: " + want);
      el.value = hit.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      throw new Error("element is not typeable: " + el.tagName.toLowerCase());
    }
    return describe(el);
  }

  function collectRefs(max) {
    W.__zcodeRefs = W.__zcodeRefs || new Map();
    W.__zcodeRefs.clear();
    const out = [];
    const core = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], [contenteditable=""], [contenteditable="true"]';
    const nodes = Array.from(document.querySelectorAll(core + ', [tabindex]')).slice(0, Math.max(max, 50) * 3);
    let seq = 0;
    for (const el of nodes) {
      if (out.length >= max) break;
      if (!(el instanceof Element)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === "input" && el.type === "hidden") continue;
      const isCore = el.matches(core);
      const vis = visible(el);
      if (!isCore && !vis) continue; // 纯 tabindex 容器不可见则跳过
      const r = el.getBoundingClientRect();
      const item = {
        ref: "e" + (++seq),
        tag,
        visible: vis,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
      if (tag === "input" || tag === "textarea") {
        item.inputType = el.type || "text";
        if (el.placeholder) item.placeholder = el.placeholder;
        if (el.value) item.value = String(el.value).slice(0, 120);
        if (el.disabled) item.disabled = true;
        if (el.name) item.name = el.name;
      } else if (tag === "select") {
        item.inputType = "select";
        item.optionCount = el.options ? el.options.length : 0;
        if (el.value) item.value = String(el.value).slice(0, 120);
        if (el.disabled) item.disabled = true;
        if (el.name) item.name = el.name;
      }
      const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (txt) item.text = txt;
      if (el.id) item.id = el.id;
      const aria = el.getAttribute("aria-label"); if (aria) item.ariaLabel = aria;
      const role = el.getAttribute("role"); if (role) item.role = role;
      const title = el.getAttribute("title"); if (title) item.title = title;
      if (tag === "a" && el.href) item.href = el.href;
      W.__zcodeRefs.set(item.ref, el);
      out.push(item);
    }
    return { count: out.length, url: location.href, title: document.title, refs: out };
  }

  function toMarkdown(root) {
    const out = [];
    function abs(u) { try { return new URL(u, location.href).href; } catch { return u; } }
    function tableMd(table) {
      const rows = Array.from(table.querySelectorAll("tr")).slice(0, 50).map((tr) =>
        Array.from(tr.children).map((td) => td.innerText.trim().replace(/\|/g, "\\|").replace(/\n/g, " ")));
      if (!rows.length) return "";
      const cols = Math.max.apply(null, rows.map((r) => r.length));
      const line = (r) => "| " + Array.from({ length: cols }, (_, i) => r[i] || "").join(" | ") + " |";
      return "\n" + line(rows[0]) + "\n|" + Array.from({ length: cols }, () => " --- ").join("|") + "|\n" + rows.slice(1).map(line).join("\n") + "\n";
    }
    (function walk(node) {
      for (const el of node.children) {
        const tag = el.tagName.toLowerCase();
        if (/^(script|style|noscript|svg|template)$/i.test(tag)) continue;
        if (/^h[1-6]$/.test(tag)) { out.push("\n" + "#".repeat(+tag[1]) + " " + (el.innerText || "").trim() + "\n"); }
        else if (tag === "ul" || tag === "ol") {
          for (const li of el.children) if (li.tagName.toLowerCase() === "li") out.push((tag === "ol" ? "1. " : "- ") + li.innerText.trim().replace(/\n+/g, " "));
        }
        else if (tag === "a") { const href = el.getAttribute("href"); const t = (el.innerText || "").trim(); if (href && t) out.push("[" + t + "](" + abs(href) + ")"); else if (t) out.push(t); }
        else if (tag === "img") { out.push("![" + (el.getAttribute("alt") || "") + "](" + abs(el.getAttribute("src") || "") + ")"); }
        else if (tag === "table") { out.push(tableMd(el)); }
        else if (tag === "button") { const t = (el.innerText || "").trim(); if (t) out.push("[按钮] " + t); }
        else if (tag === "input" || tag === "textarea" || tag === "select") {
          const ph = el.placeholder || el.name || el.type || tag;
          out.push("[输入框 " + ph + (el.value ? " = " + el.value : "") + "]");
        }
        else if (tag === "br") out.push("");
        else if (el.children.length) walk(el);
        else if (el.innerText && el.innerText.trim()) out.push(el.innerText.trim());
      }
    })(root);
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  try {
    switch (job.action) {
      case "refs":
        return collectRefs(Math.min(Math.max(job.max || 400, 1), 2000));

      case "extract": {
        const format = job.format || "text";
        const root = job.selector ? document.querySelector(job.selector) : (document.body || document.documentElement);
        if (!root) throw new Error("selector not found: " + job.selector);
        let payload;
        if (format === "html") payload = root.outerHTML;
        else if (format === "markdown") payload = toMarkdown(root);
        else payload = (root.innerText || root.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
        const bytes = new Blob([payload]).size;
        let truncated = false;
        const maxBytes = job.maxBytes || 400000;
        if (bytes > maxBytes) { payload = payload.slice(0, maxBytes); truncated = true; }
        return { url: location.href, title: document.title, format, bytes, truncated, content: payload };
      }

      case "click": {
        if (!job.ref && !job.selector && !job.text) {
          // 无定位参数：点击当前焦点元素
          const a = document.activeElement;
          if (!a || a === document.body) throw new Error("input.click 需要 ref / selector / text 之一");
          a.click();
          return describe(a);
        }
        const el = resolve(job);
        ensureShown(el);
        el.click();
        return describe(el);
      }

      case "type": {
        let el;
        if (!job.ref && !job.selector) {
          el = document.activeElement && document.activeElement !== document.body
            ? document.activeElement
            : (document.querySelector('input, textarea') || null);
          if (!el) throw new Error("无定位参数且页面无焦点输入框");
        } else {
          el = resolve(job);
        }
        typeInto(el, String(job.text), job.clear !== false);
        if (job.submit) {
          const form = el.closest && el.closest("form");
          if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
          else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
        return describe(el);
      }

      case "fill": {
        const fields = job.fields || [];
        const results = [];
        for (const f of fields) {
          const el = resolve(f);
          typeInto(el, String(f.value == null ? "" : f.value), f.clear !== false);
          results.push({ ref: describe(el).ref, tag: el.tagName.toLowerCase(), id: el.id || undefined, value: String(f.value == null ? "" : f.value).slice(0, 120) });
        }
        return { filled: results.length, results };
      }

      case "focusOf": {
        const el = resolve(job);
        ensureShown(el);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable || el instanceof HTMLSelectElement) {
          el.focus();
          if (job.clear && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const d = Object.getOwnPropertyDescriptor(proto, "value");
            if (d && d.set) d.set.call(el, ""); else el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return describe(el);
        }
        throw new Error("element is not focusable/input: " + el.tagName.toLowerCase());
      }

      case "submitFrom": {
        const el = resolve(job);
        const form = el.closest && el.closest("form");
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { submitted: true }; }
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return { submitted: "enter-key" };
      }

      case "markForUpload": {
        // file.upload 辅助：给目标元素打一次性标记属性，返回唯一 CSS 选择器
        // （CDP DOM.querySelector 只认选择器；page.refs 的 ref 在隔离世界，无法直接给 CDP 用）
        const el = resolve(job);
        ensureShown(el);
        const key = "zcode-up-" + Math.random().toString(36).slice(2, 10);
        el.setAttribute("data-" + key, "1");
        return { selector: "[data-" + key + '="1"]', attributeName: "data-" + key, tag: el.tagName.toLowerCase() };
      }

      case "cleanupMark": {
        // 上传完成后移除一次性标记属性，不污染页面 DOM
        const el = document.querySelector(job.selector);
        if (el && job.attributeName) el.removeAttribute(job.attributeName);
        return { cleaned: !!(el && job.attributeName) };
      }

      case "iframeRect": {
        // 跨 frame 可信点击辅助：在父 frame 里找到 src 匹配目标 frame URL 的 iframe，
        // 将其滚动到视口中央并返回其 viewport 偏移（与子 frame 内元素坐标叠加即为主 viewport 坐标）
        const want = String(job.url || "").split("#")[0];
        const frames = Array.from(document.querySelectorAll("iframe, frame"));
        const hit = frames.find((f) => {
          try { return f.src && f.src.split("#")[0] === want && f.getBoundingClientRect().width > 0; } catch { return false; }
        }) || frames.find((f) => { try { return f.src === String(job.url); } catch { return false; } });
        if (!hit) throw new Error("父 frame 未找到与目标 frame URL 匹配的 iframe（src=" + job.url + "）");
        hit.scrollIntoView({ block: "center", inline: "center" });
        const r = hit.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      }

      case "rectOf": {
        const el = resolve(job);
        ensureShown(el);
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 80) };
      }

      case "scroll": {
        if (job.ref || job.selector) {
          const el = resolve(job);
          el.scrollIntoView({ block: "center", inline: "center" });
          return { scrolled: "into-view", tag: el.tagName.toLowerCase() };
        }
        window.scrollBy(job.dx || 0, job.dy || 0);
        return { scrolled: { x: window.scrollX, y: window.scrollY } };
      }

      case "key": {
        const map = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
        const key = job.key;
        const kc = map[key] != null ? map[key] : (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.documentElement;
        const init = { key, code: key, keyCode: kc, which: kc, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        if (key.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return { dispatched: key, focused: target.tagName.toLowerCase() };
      }

      case "viewport":
        return { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio };

      case "wait": {
        // 单次同步探测（SW 侧负责轮询注入，因为本 Edge 版本 executeScript 不支持 awaitPromise）
        const selector = job.selector, text = job.text;
        let matched = null;
        if (selector && document.querySelector(selector)) matched = "selector";
        if (!matched && text && document.body && document.body.innerText.indexOf(text) >= 0) matched = "text";
        return { hit: !!matched, matched, elapsedMs: 0 };
      }

      default:
        return { error: "unknown action: " + job.action };
    }
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

// 说明：page.eval 原实现（executeScript + eval）在 MV3 下不可行——
// 扩展 CSP 禁止字符串 eval（含 ISOLATED world），且 Edge 157 的 injection
// 校验拒绝 awaitPromise 属性。现实现见 commands/write.js（chrome.debugger
// Runtime.evaluate）。本文件保留 DOM 交互注入引擎 actionFn。
