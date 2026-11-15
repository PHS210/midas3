import { api, esc, formatWon, getSession, renderFooter, renderHeader } from "./common/site.js";
import { filterJobs, suggestWhenEmpty } from "./common/jobSearch.js";
import { clearRecent, readRecent } from "./common/recent.js";
import { jobImage } from "./common/jobImages.js";

const PAGE = 30;
const STATE_KEY = "jobsim:explore-state:v1";
let allJobs = [];
let shown = PAGE;

const $ = (id) => document.getElementById(id);

// 탐색 상태 유지(U04-1): 검색어·필터는 주소에, 펼친 개수·스크롤은 세션 저장소에 둔다.
function readState() {
  const params = new URLSearchParams(location.search);
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "{}");
  } catch (_) {
    saved = {};
  }
  const sameQuery = saved.query === location.search;
  return {
    q: params.get("q") || "",
    field: params.get("field") || "",
    exp: params.get("exp") === "1",
    shown: sameQuery && saved.shown ? saved.shown : PAGE,
    scrollY: sameQuery ? saved.scrollY || 0 : 0
  };
}

function writeState() {
  const params = new URLSearchParams();
  if ($("q").value.trim()) params.set("q", $("q").value.trim());
  if ($("field").value) params.set("field", $("field").value);
  if ($("exp").checked) params.set("exp", "1");
  const query = params.toString() ? `?${params}` : "";
  history.replaceState(null, "", `${location.pathname}${query}`);
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ query, shown, scrollY: window.scrollY }));
  } catch (_) {
    // 저장소를 못 쓰면 상태 유지만 빠진다.
  }
}

// 로그인했으면 관심 저장한 직무 코드 → 메모
let interestMap = new Map();

async function loadInterests() {
  try {
    const session = await getSession();
    if (!session.authenticated) return;
    const data = await api("GET", "/api/me/interests");
    interestMap = new Map(data.interests.map((row) => [row.job_code, row.memo || ""]));
  } catch (_) {
    interestMap = new Map();
  }
}

function card(job) {
  return `<article class="card job-card">
    <div class="top">
      ${jobImage(job, { height: 52 })}
      <div>
        <a class="name" href="/job.html?code=${esc(job.code)}">${esc(job.name)}</a>
        <div class="mdcl">${esc(job.lrcl)} · ${esc(job.mdcl)}</div>
      </div>
    </div>
    <div class="sum">${esc(job.summary)}</div>
    ${interestMap.get(job.code) ? `<div class="memo-text" title="내 메모">메모: ${esc(interestMap.get(job.code))}</div>` : ""}
    <div class="foot">
      <div class="chips">
        ${interestMap.has(job.code) ? `<span class="chip chip-interest">관심 저장됨</span>` : ""}
        ${job.experienceable ? `<span class="chip chip-ok">체험 가능</span>` : ""}
        ${job.salary_p50 ? `<span class="chip">중위 임금 ${formatWon(job.salary_p50)}</span>` : ""}
      </div>
    </div>
  </article>`;
}

function renderEmpty(filters) {
  const s = suggestWhenEmpty(allJobs, filters);
  const parts = [];
  if (s.withoutField) parts.push(`<button class="btn btn-sm" type="button" data-action="clear-field">분야를 ‘전체’로 바꾸면 ${s.withoutField}개</button>`);
  if (s.withoutExperienceable) parts.push(`<button class="btn btn-sm" type="button" data-action="clear-exp">체험 가능만 끄면 ${s.withoutExperienceable}개</button>`);
  return `<div class="empty" style="grid-column:1/-1">
    <p><strong>‘${esc(filters.q || "")}’에 해당하는 직무가 없습니다.</strong></p>
    ${parts.length ? `<div class="btn-row">${parts.join("")}</div>` : ""}
    ${s.similarNames.length ? `<p style="margin-top:12px">혹시 이 직무를 찾으셨나요? ${s.similarNames.map((j) => `<a href="/job.html?code=${esc(j.code)}">${esc(j.name)}</a>`).join(", ")}</p>` : ""}
    <p style="margin-top:12px">이런 표현으로도 검색해 보세요: ${s.examples.map((w) => `<button class="btn btn-sm" type="button" data-example="${esc(w)}">${esc(w)}</button>`).join(" ")}</p>
  </div>`;
}

function render() {
  const filters = { q: $("q").value, field: $("field").value, experienceableOnly: $("exp").checked };
  const results = filterJobs(allJobs, filters);
  $("count").textContent = `${results.length}개 직무`;
  $("results").innerHTML = results.length ? results.slice(0, shown).map(card).join("") : renderEmpty(filters);
  $("more").hidden = results.length <= shown;
  $("more").textContent = `더 보기 (${results.length - shown}개 남음)`;
  renderRecent();
  writeState();
}

function renderRecent() {
  const recent = readRecent();
  $("recent").innerHTML = recent.length
    ? `<span class="small muted">최근 본 직무</span>${recent.map((item) => `<a class="chip" href="/job.html?code=${esc(item.code)}">${esc(item.name)}</a>`).join("")}<button class="btn btn-sm" type="button" data-action="clear-recent">지우기</button>`
    : "";
}

async function main() {
  renderHeader("jobs");
  renderFooter();
  const state = readState();
  $("q").value = state.q;
  $("exp").checked = state.exp;
  shown = state.shown;
  try {
    const res = await fetch("/api/jobs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allJobs = data.jobs;
    $("total").textContent = String(data.total);
    $("field").innerHTML = `<option value="">전체 분야</option>${data.fields.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("")}`;
    $("field").value = state.field;
  } catch (error) {
    $("results").innerHTML = `<div class="notice notice-err" style="grid-column:1/-1">직무 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`;
    return;
  }
  await loadInterests();
  render();
  if (state.scrollY) requestAnimationFrame(() => window.scrollTo(0, state.scrollY));

  let timer = null;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { shown = PAGE; render(); }, 120);
  });
  $("field").addEventListener("change", () => { shown = PAGE; render(); });
  $("exp").addEventListener("change", () => { shown = PAGE; render(); });
  $("more").addEventListener("click", () => { shown += PAGE; render(); });
  window.addEventListener("scroll", () => {
    clearTimeout(window.__exploreScroll);
    window.__exploreScroll = setTimeout(writeState, 150);
  }, { passive: true });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const action = target.closest("[data-action]")?.dataset.action;
    if (action === "clear-field") { $("field").value = ""; render(); }
    if (action === "clear-exp") { $("exp").checked = false; render(); }
    if (action === "clear-recent") { clearRecent(); renderRecent(); }
    const example = target.closest("[data-example]");
    if (example) { $("q").value = example.dataset.example; shown = PAGE; render(); }
  });
}

main();
