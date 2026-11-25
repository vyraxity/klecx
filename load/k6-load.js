// Step 10.4 — load test (k6, https://k6.io). Run against a test-mode build
// (fake AI, fake Creem, test inbox): `npm run e2e:build`, start it with the
// e2e environment, then `k6 run load/k6-load.js` (or the "load" workflow).
//
// What it checks (guide 10.4):
// - 50 AI answers at the same time on the fake provider (10 Pro owners × 5,
//   Pro's concurrency limit), all answered;
// - 20 sessions spending ONE owner's balance at once: requests may be refused
//   (429 limits, 402 no credits) but never fail (5xx);
// - afterwards every account adds up: balance = sum of its ledger rows, and
//   no balance ever went below zero (`/api/test/ledger-check`);
// - non-AI endpoints stay fast under that load: p95 < 300 ms.
import http from "k6/http";
import { check, fail, sleep } from "k6";
import exec from "k6/execution";

const BASE = __ENV.BASE_URL || "http://localhost:3100";
const OWNERS = 10;
const PASSWORD = "A-long-load-test-passphrase-42";
const COOKIE = "better-auth.session_token";

export const options = {
  setupTimeout: "180s",
  scenarios: {
    concurrent_answers: {
      executor: "per-vu-iterations",
      vus: 50,
      iterations: 1,
      maxDuration: "90s",
      exec: "concurrentAnswer",
    },
    same_balance: {
      executor: "constant-vus",
      vus: 20,
      duration: "30s",
      startTime: "20s",
      exec: "spendSameBalance",
    },
    api_reads: {
      executor: "constant-arrival-rate",
      rate: 15,
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: 20,
      startTime: "5s",
      exec: "readApi",
    },
  },
  thresholds: {
    "http_req_duration{kind:api}": ["p(95)<300"],
    "checks{check:no_server_errors}": ["rate==1"],
    "checks{check:answered}": ["rate==1"],
    "checks{check:ledger}": ["rate==1"],
  },
};

const json = (body) => ({ headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });

function signUp(i) {
  const email = `load_${Date.now().toString(36)}_${i}@example.com`;
  const jar = http.cookieJar();
  jar.clear(BASE);
  const res = http.post(`${BASE}/api/auth/sign-up/email`, JSON.stringify({ email, password: PASSWORD, name: `Load ${i}`, callbackURL: "/workspaces" }), json({}));
  if (res.status !== 200) fail(`sign-up ${res.status}`);
  const mail = http.get(`${BASE}/api/test/emails?to=${encodeURIComponent(email)}`).json("data.emails.0");
  const link = (mail?.links || []).find((l) => l.includes("/verify-email"));
  if (!link) fail("no verification email");
  http.get(link, { redirects: 5 });
  const cookie = jar.cookiesForURL(BASE)[COOKIE];
  if (!cookie || !cookie[0]) fail("no session cookie after verification");
  const session = cookie[0];
  const headers = { cookie: `${COOKIE}=${session}`, origin: BASE, "content-type": "application/json" };
  http.put(`${BASE}/api/v1/me/username`, JSON.stringify({ username: `load_${Date.now().toString(36)}${i}` }), { headers });
  const sub = http.post(`${BASE}/api/test/subscribe`, JSON.stringify({ email, plan: "PRO" }), json({}));
  if (sub.status !== 200) fail(`subscribe ${sub.status}`);
  const ws = http.post(`${BASE}/api/v1/workspaces`, JSON.stringify({ title: `Load ${i}` }), { headers });
  if (ws.status !== 200) fail(`workspace ${ws.status}`);
  jar.clear(BASE);
  return { email, headers, workspaceId: ws.json("data.id") };
}

export function setup() {
  const owners = [];
  for (let i = 0; i < OWNERS; i++) owners.push(signUp(i));
  return { owners };
}

function generate(owner, tag) {
  const res = http.post(
    `${BASE}/api/v1/workspaces/${owner.workspaceId}/generations`,
    JSON.stringify({ idempotencyKey: `${tag}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`, prompt: "Load test question" }),
    { headers: owner.headers, tags: { kind: "ai" }, timeout: "120s" }
  );
  check(res, { no_server_errors: (r) => r.status < 500 });
  return res;
}

// 50 at once: iteration n (0-49, unique in this scenario) uses owner n % 10,
// so each owner runs exactly its 5 allowed. (VU ids are numbered across all
// scenarios, so they can't be used for this.)
export function concurrentAnswer(data) {
  const owner = data.owners[exec.scenario.iterationInTest % OWNERS];
  const res = generate(owner, "concurrent");
  check(res, { answered: (r) => r.status === 200 && r.body.includes("A closing sentence ends the answer.") });
  if (res.status !== 200 || !res.body.includes("A closing sentence ends the answer.")) {
    console.warn(`concurrent answer not completed: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
  }
}

// 20 sessions on owner 0's balance: limits may refuse, nothing may break.
export function spendSameBalance(data) {
  const res = generate(data.owners[0], "same");
  check(res, { "refused cleanly or answered": (r) => [200, 402, 409, 429].includes(r.status) });
  sleep(0.2);
}

// Non-AI endpoints under load (spread over owners 1-9 to stay under each person's rate limit).
export function readApi(data) {
  const owner = data.owners[1 + (exec.scenario.iterationInTest % (OWNERS - 1))];
  const paths = ["/api/v1/workspaces", "/api/v1/me", "/api/v1/me/usage/summary?period=current", `/api/v1/workspaces/${owner.workspaceId}`];
  const res = http.get(`${BASE}${paths[exec.scenario.iterationInTest % paths.length]}`, { headers: owner.headers, tags: { kind: "api" } });
  check(res, { no_server_errors: (r) => r.status < 500 });
}

export function teardown(data) {
  for (const owner of data.owners) {
    const out = http.get(`${BASE}/api/test/ledger-check?email=${encodeURIComponent(owner.email)}`).json("data");
    // The check's name is its `check` tag (what the threshold filters on).
    check(out, { ledger: (o) => Boolean(o && o.consistent === true && o.neverNegative === true) });
  }
}
