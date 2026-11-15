/* JOBSIM 공통 모듈: 헤더, API 호출(CSRF 포함), 로그인 상태, 작은 UI 도우미 */

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function currentPath() {
  return `${location.pathname}${location.search}`;
}

export class ApiRequestError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, data?.error?.code || "HTTP_ERROR", data?.error?.message || `요청이 실패했어 (HTTP ${response.status})`, data?.error?.details);
  }
  return data;
}

export function toast(message, ms = 2600) {
  const node = document.createElement("div");
  node.className = "toast";
  node.setAttribute("role", "status");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

export function formatDate(iso, withTime = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {})
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")}${withTime ? ` ${get("hour")}:${get("minute")}` : ""}`;
}

export function formatWon(manwon) {
  if (manwon === null || manwon === undefined) return "자료 없음";
  return `${Number(manwon).toLocaleString("ko-KR")}만원`;
}

const NAV = [
  { key: "jobs", href: "/jobs.html", label: "직무 탐색" },
  { key: "experience", href: "/index.html#simulation", label: "체험" }
];

// 모든 새 페이지 상단 헤더. activeKey는 NAV의 key.
export function renderHeader(activeKey) {
  const host = document.getElementById("site-header");
  if (!host) return;
  host.innerHTML = `<nav class="site-nav" aria-label="주 메뉴">
    <a class="site-logo" href="/index.html">JOB<span>SIM</span></a>
    <div class="site-links">
      ${NAV.map((item) => `<a href="${item.href}"${item.key === activeKey ? " aria-current=\"page\"" : ""}>${item.label}</a>`).join("")}
    </div>
  </nav>`;
}

export function renderFooter() {
  const host = document.getElementById("site-footer");
  if (!host) return;
  host.innerHTML = `<footer class="site-foot">
    <span>© JOBSIM · 직업 정보: 한국고용정보원 KNOW</span>
    <a href="/terms.html">이용약관</a>
    <a href="/privacy.html">개인정보 처리방침</a>
  </footer>`;
}
