/* 관리자 미션 생성 API. 암호 보관, 요청 보내기, 경로 열둘.
   모든 경로는 /api/admin/mission-generation 아래다. 암호는 요청 머리 x-api-token으로 보낸다.
   실패하면 AdminApiError를 던진다(서버의 { error: { code, message, details? } }를 그대로 담는다). */

export const TOKEN_KEY = "jobsim:admin_api_token";   // 옛 관리자 화면과 같은 이름. sessionStorage에 둔다

const BASE = "/api/admin/mission-generation";

export class AdminApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = "AdminApiError";
    this.status = status;     // HTTP 상태. 서버에 닿지 못했으면 0
    this.code = code;         // 서버의 error.code. JSON이 아니면 HTTP_<상태>, 닿지 못했으면 NETWORK_ERROR
    this.details = details;   // 서버의 error.details(없으면 undefined)
  }
}

// sessionStorage를 못 쓰는 창(막힌 설정 등)에서도 멈추지 않게 감싼다.
// 메모리에도 한 벌 둔다. 보관소를 못 쓰면 이 페이지가 열려 있는 동안은 메모리의 것을 쓴다(새로고침하면 다시 묻는다)
let memoryToken = "";

export function getToken() {
  let stored = "";
  try {
    stored = sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (_) {
    stored = "";
  }
  return stored || memoryToken;
}

export function setToken(value) {
  memoryToken = String(value ?? "");
  try {
    sessionStorage.setItem(TOKEN_KEY, memoryToken);
  } catch (_) {
    /* 보관소에 못 두어도 메모리의 것으로 이번 화면은 쓴다 */
  }
}

export function clearToken() {
  memoryToken = "";
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* 없으면 그만이다 */
  }
}

// 요청이 401을 받았을 때 부를 함수. main.js가 한 번 정한다(암호를 지우고 암호 화면으로 간다).
// 화면 코드는 401을 따로 처리하지 않아도 된다.
let authLostHandler = null;
export function setAuthLostHandler(fn) {
  authLostHandler = typeof fn === "function" ? fn : null;
}

// 암호를 바꾸는 요청이 가는 동안에는 다른 요청의 401로 암호 화면에 보내지 않는다
// (서버는 이미 새 암호인데 이 탭은 아직 예전 암호를 들고 있는 짧은 틈).
let changingPassword = false;

async function request(method, path, { body, token = getToken(), silent = false, base = BASE } = {}) {
  const headers = {};
  if (token) headers["x-api-token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new AdminApiError(0, "NETWORK_ERROR", err?.message || "network error");
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;   // JSON이 아닌 응답(프록시 오류 화면 등)
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? data.error : null;
    const code = typeof error?.code === "string" && error.code ? error.code : `HTTP_${response.status}`;
    const failure = new AdminApiError(response.status, code, error?.message || `HTTP ${response.status}`, error?.details);
    // 늦게 온 401: 이 요청을 보낸 뒤 암호가 바뀌었으면(다시 넣었거나 로그아웃) 지금 암호를 건드리지 않는다
    if (response.status === 401 && !silent && !changingPassword && token === getToken()) {
      clearToken();
      if (authLostHandler) authLostHandler(failure);
    }
    throw failure;
  }
  return data;
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const runPath = (runId) => `/runs/${encodeURIComponent(String(runId))}`;

// 돌려주는 값은 서버 응답 본문 그대로다(api-samples/*.json과 같은 모양).
export const adminApi = {
  status: () => request("GET", "/status"),                                                  // 상태 객체
  jobs: () => request("GET", "/jobs"),                                                      // { jobs, total }
  sentences: (jobCode) => request("GET", `/jobs/${encodeURIComponent(String(jobCode))}/sentences`),   // { job, sentences }
  materialTypes: ({ jobCode, execJobId, unitKey, difficulty }) =>
    request("GET", `/material-types${query({ jobCode, execJobId, unitKey, difficulty })}`),
  startRun: ({ jobCode, execJobId, unitKey, difficulty, review, fast }) =>
    // fast는 켰을 때만 싣는다(이 칸을 모르는 예전 서버에서도 보통 속도 생성은 그대로 된다)
    request("POST", "/runs", { body: { jobCode, execJobId, unitKey, difficulty, review: Boolean(review), ...(fast ? { fast: true } : {}) } }),   // 202, { run }
  runs: (limit) => request("GET", `/runs${query({ limit })}`),                              // { runs }
  run: (runId) => request("GET", runPath(runId)),                                           // { run }
  rerunReview: (runId) => request("POST", `${runPath(runId)}/review`),                     // { run }
  addToCatalog: (runId) => request("POST", `${runPath(runId)}/catalog`),                   // { run }
  deleteRun: (runId) => request("DELETE", runPath(runId)),                                  // { ok, runId }
  catalog: () => request("GET", "/catalog"),                                                // { jobs, total }
  removeFromCatalog: (missionKey) => request("DELETE", `/catalog/${encodeURIComponent(String(missionKey))}`)   // { ok, ... }
};

// 관리자 암호 바꾸기. 되면 이 탭이 들고 있는 암호를 새 암호로 바꾼다.
export async function changePassword(currentPassword, newPassword) {
  changingPassword = true;
  let failure = null;
  try {
    await request("POST", "/password", { body: { currentPassword, newPassword }, base: "/api/admin" });
    setToken(newPassword);
  } catch (err) {
    failure = err;
  } finally {
    changingPassword = false;
  }
  if (!failure) return;
  // 이 탭이 들고 있던 암호가 더는 맞지 않는다(다른 곳에서 먼저 바꿨다). 암호 화면으로 보낸다
  if (failure.status === 401) {
    clearToken();
    if (authLostHandler) authLostHandler(failure);
  }
  throw failure;
}

// 암호가 맞는지 본다. 결과는 { ok, status }(ok가 거짓이면 틀린 암호). 그 밖의 실패는 AdminApiError로 던진다.
// - GET /status가 401이면 틀린 것이다.
// - 조회 전용 열기(adminDemoUnlockEnabled)에서는 GET이 늘 200이라 알 수 없으므로, 없는 실행에 POST /runs/-/review를
//   그 암호로 한 번 보낸다. 401이면 틀린 것, 404면 맞는 것이다(없는 실행이라 서버에서 아무 일도 일어나지 않는다).
// knownStatus를 주면 /status를 다시 부르지 않는다(시작할 때 이미 받은 경우).
export async function verifyToken(token, { knownStatus } = {}) {
  let status = knownStatus;
  if (!status) {
    try {
      status = await request("GET", "/status", { token, silent: true });
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) return { ok: false, status: null };
      throw err;
    }
  }
  if (!status?.adminDemoUnlockEnabled) return { ok: true, status };
  try {
    await request("POST", "/runs/-/review", { token, silent: true });
    return { ok: true, status };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    if (err.status === 401) return { ok: false, status };
    if (err.status === 404) return { ok: true, status };
    throw err;
  }
}
