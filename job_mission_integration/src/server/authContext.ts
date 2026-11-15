import type express from "express";
import type { Owner } from "../lib/db/repos.js";
import { ANON_COOKIE, newToken } from "../lib/auth/session.js";
import type { ServerConfig } from "./config.js";
import { parseCookies, setCookie } from "./http.js";

// 로그인 기능은 없다. 체험 기록은 브라우저 식별 쿠키로만 본인 것을 가린다.
export interface RequestAuth {
  anonId: string | null;
  cookies: Record<string, string>;
}

export function getAuth(res: express.Response): RequestAuth {
  return (res.locals.auth as RequestAuth | undefined) ?? { anonId: null, cookies: {} };
}

export function ownerOf(res: express.Response): Owner {
  return { userId: null, anonId: getAuth(res).anonId };
}

// 모든 요청에 브라우저 식별자를 붙인다.
export function loadAuth(): express.RequestHandler {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const anonRaw = cookies[ANON_COOKIE];
    res.locals.auth = {
      anonId: anonRaw && /^[A-Za-z0-9_-]{16,64}$/.test(anonRaw) ? anonRaw : null,
      cookies
    } satisfies RequestAuth;
    next();
  };
}

// 체험 기록을 묶을 브라우저 식별자. 필요할 때만 만든다.
export function ensureAnonId(res: express.Response, config: ServerConfig) {
  const auth = getAuth(res);
  if (auth.anonId) return auth.anonId;
  const anonId = newToken(18);
  setCookie(res, ANON_COOKIE, anonId, {
    secure: config.cookieSecure,
    maxAgeSec: config.auth.anonymousRetentionHours * 60 * 60
  });
  auth.anonId = anonId;
  return anonId;
}
