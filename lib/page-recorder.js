// A short memory of what just happened on the page, kept only so a diagnostic entry can answer "what
// led to this?" after the fact — without it, an odd moment (a captcha that arrives already showing an
// error) can only be guessed at. Two feeds, each a small ring buffer:
//  - clicks / submits / Enter presses, with `isTrusted`: a person's input is trusted, the bot's
//    programmatic click() is not, so the log shows who did what without any bookkeeping in the flows;
//  - the page's own network requests (path, status, duration — never bodies or query strings).
// Only ever read through recentActivity(); nothing here influences behavior.

// sized for a whole captcha episode (minutes of a person typing), since the log goes to a server and no
// longer has to be small
const BUFFER_SIZE = 400;
const TARGET_TEXT_LENGTH = 60;

const activity = [];

function record(at, line) {
  activity.push({ at, line });
  if (activity.length > BUFFER_SIZE) activity.shift();
}

function describeTarget(target) {
  const qa = target?.closest?.('[data-qa]')?.getAttribute('data-qa') ?? '-';
  const text = (target?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, TARGET_TEXT_LENGTH);
  return text ? `${qa} "${text}"` : qa;
}

function isInteresting(entry, path) {
  return entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest' || path.includes('captcha');
}

// TEMPORARY (24.11.2026, see captcha-net-probe.js): what hh.ru's page sent and got back around a captcha
const NET_BUFFER_SIZE = 60;
const net = [];

function recordNet(entry) {
  net.push(entry);
  if (net.length > NET_BUFFER_SIZE) net.shift();
  const sent = entry.sent ? JSON.stringify(entry.sent).slice(0, 200) : '-';
  const response = String(entry.response ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  record(entry.endedAt, `net ${entry.method} ${entry.path} status=${entry.status} sent=${sent} response="${response}"`);
}

let started = false;

export function startPageRecorder() {
  if (started) return; // several entries can share one document, one set of listeners is enough
  started = true;

  // capture phase: sees the event before any handler on the page can stop it. Press and release are
  // recorded on their own, with the pointer position — a click that lands on something other than what
  // was pressed (the dialog under the cursor closing between the two) is only visible that way.
  for (const type of ['pointerdown', 'pointerup', 'click', 'submit']) {
    document.addEventListener(
      type,
      (event) => {
        const { clientX: x, clientY: y } = event;
        const position = x === undefined ? '' : ` at=${Math.round(x)},${Math.round(y)}`;
        record(Date.now(), `${type} trusted=${event.isTrusted}${position} ${describeTarget(event.target)}`);
      },
      true,
    );
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') record(Date.now(), `Enter trusted=${event.isTrusted} ${describeTarget(event.target)}`);
    },
    true,
  );

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'hhaa-captcha-net-probe') return;
    recordNet(event.data.entry);
  });

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const url = new URL(entry.name);
      if (!url.hostname.endsWith('hh.ru') || !isInteresting(entry, url.pathname)) continue;
      const at = Math.round(performance.timeOrigin + entry.responseEnd);
      const took = Math.round(entry.duration);
      record(at, `${entry.initiatorType} ${url.pathname} status=${entry.responseStatus} ${took}ms`);
    }
  }).observe({ type: 'resource', buffered: false });
}

// the last `sinceMs` of activity, oldest first, each line stamped with how long before now it happened
export function recentActivity(sinceMs, limit = 40) {
  const now = Date.now();
  const lines = activity
    .filter((item) => item.at >= now - sinceMs)
    .sort((a, b) => a.at - b.at)
    .slice(-limit)
    .map((item) => `-${((now - item.at) / 1000).toFixed(2)}s ${item.line}`);
  return lines.length > 0 ? lines.join(' ; ') : 'none';
}

// TEMPORARY (see captcha-net-probe.js): the page's captcha and response requests that ended in the last `sinceMs`
export function recentNet(sinceMs) {
  const from = Date.now() - sinceMs;
  return net.filter((entry) => entry.endedAt >= from);
}

// TEMPORARY: when hh.ru last handed out a captcha (its /captcha request ended), null if not seen in this document
export function lastCaptchaIssuedAt() {
  const issued = net.filter((entry) => /\/captcha$/.test(entry.path));
  return issued.length > 0 ? issued[issued.length - 1].endedAt : null;
}
