// TEMPORARY debugging telemetry (24.11.2026) — remove once the captcha rejections are explained.
//
// What hh.ru's own page sends and gets back around a captcha, which nothing else can see: the content scripts
// live in an isolated world and see only that a request happened (page-recorder.js), never what was in it.
// This runs in the page's MAIN world (background.js injects it) and wraps XMLHttpRequest and fetch for the
// captcha's requests and the response submit that carries the answer. Each one goes to the isolated world as
// a window message: method, path, the fields sent (captcha fields with their values, the rest only with their
// length), status, the head of the response body, and when it started and ended. page-recorder.js collects them.
//
// Self-contained on purpose: chrome.scripting serializes the function, nothing outside it exists in the page.
export function installCaptchaNetProbe() {
  if (window.__hhaaCaptchaNetProbe) return;
  window.__hhaaCaptchaNetProbe = true;

  const WATCHED_PATH = /captcha|\/applicant\/vacancy_response/;
  const BODY_HEAD = 800;
  const VALUE_HEAD = 200;

  const pathOf = (url) => {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return String(url);
    }
  };

  const summarizeValue = (name, value) => {
    const text = typeof value === 'string' ? value : value instanceof Blob ? `[blob ${value.size}]` : String(value);
    return /captcha/i.test(name) ? text.slice(0, VALUE_HEAD) : `len:${text.length}`;
  };

  // the fields of a request body: values only for the captcha's own fields
  const summarizeBody = (body) => {
    if (body == null) return null;
    try {
      if (body instanceof FormData || body instanceof URLSearchParams) {
        return Object.fromEntries([...body.entries()].map(([name, value]) => [name, summarizeValue(name, value)]));
      }
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{')) {
          const parsed = JSON.parse(trimmed);
          return Object.fromEntries(
            Object.entries(parsed).map(([name, value]) => [
              name,
              summarizeValue(name, typeof value === 'string' ? value : JSON.stringify(value)),
            ]),
          );
        }
        return Object.fromEntries(
          [...new URLSearchParams(trimmed).entries()].map(([name, value]) => [name, summarizeValue(name, value)]),
        );
      }
      return { type: Object.prototype.toString.call(body) };
    } catch (error) {
      return { unreadable: error.message };
    }
  };

  const post = (entry) => window.postMessage({ source: 'hhaa-captcha-net-probe', entry }, location.origin);

  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  OriginalXhr.prototype.open = function (method, url, ...rest) {
    this.__hhaaProbe = WATCHED_PATH.test(pathOf(url)) ? { method, path: pathOf(url) } : null;
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXhr.prototype.send = function (body) {
    const probe = this.__hhaaProbe;
    if (probe) {
      const startedAt = Date.now();
      const sent = summarizeBody(body);
      this.addEventListener('loadend', () => {
        let response = '';
        try {
          response =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : JSON.stringify(this.response);
        } catch (error) {
          response = `[unreadable: ${error.message}]`;
        }
        post({
          via: 'xhr',
          ...probe,
          sent,
          status: this.status,
          response: String(response ?? '').slice(0, BODY_HEAD),
          startedAt,
          endedAt: Date.now(),
        });
      });
    }
    return originalSend.call(this, body);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const path = pathOf(url);
    if (!WATCHED_PATH.test(path)) return originalFetch.call(this, input, init);

    const startedAt = Date.now();
    const method = init?.method ?? input?.method ?? 'GET';
    const sent = summarizeBody(init?.body);
    const result = await originalFetch.call(this, input, init);
    result
      .clone()
      .text()
      .then((text) => text.slice(0, BODY_HEAD))
      .catch((error) => `[unreadable: ${error.message}]`)
      .then((response) =>
        post({ via: 'fetch', method, path, sent, status: result.status, response, startedAt, endedAt: Date.now() }),
      );
    return result;
  };
}
