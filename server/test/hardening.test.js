// node --test server/test  （零依赖，Node >= 20）
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wechat-test-"));
process.env.GROK_WECHAT_HOME = HOME;

const store = await import("../store.js");
const { safeMediaName, mediaFilePath } = await import("../ilink.js");

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const mode = (p) => fs.statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resetHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
}

function seedAccount(baseUrl) {
  store.saveState({
    ...store.emptyState(),
    accounts: [{ ...store.emptyAccount(), token: "tok", baseUrl, ilinkBotId: "bot1", ilinkUserId: "owner" }],
  });
}

describe("入站文件名不能写出 media 目录", () => {
  for (const name of ["../../.bashrc", "../../../../home/box/.profile", "a/../../b", "..", ".", "", "x\0y", "..\\..\\evil"]) {
    test(JSON.stringify(name), () => {
      const dir = path.join(HOME, "media");
      const file = mediaFilePath(dir, name);
      assert.equal(path.dirname(file), path.resolve(dir));
      assert.ok(!path.basename(file).includes("/"));
    });
  }
  test("正常文件名保留", () => {
    assert.equal(safeMediaName("报告.pdf"), "报告.pdf");
  });
});

describe("allowlist", () => {
  before(() => { resetHome(); seedAccount("http://127.0.0.1:1"); });
  test("空 allowlist 只放行扫码本人", () => {
    const s = store.loadState();
    assert.equal(store.isAllowed(s, "owner"), true);
    assert.equal(store.isAllowed(s, "stranger"), false);
    assert.equal(store.isAllowed(s, ""), false);
  });
  test("非空 allowlist 只放行名单内", () => {
    const s = { ...store.loadState(), allowFrom: ["friend"] };
    assert.equal(store.isAllowed(s, "friend"), true);
    assert.equal(store.isAllowed(s, "owner"), false);
  });
});

describe("凭据文件权限", () => {
  before(resetHome);
  test("account.json / wake.json 反复写入后仍是 600，目录 700", () => {
    seedAccount("http://127.0.0.1:1");
    for (let i = 0; i < 3; i++) store.updateState((s) => { s.accounts[0].getUpdatesBuf = String(i); return s; });
    store.saveGlobalWake("http://x", "crsr_k");
    store.saveGlobalWake("http://y", "crsr_k2");
    assert.equal(mode(store.paths().state), 0o600);
    assert.equal(mode(store.fallbackWakePath()), 0o600);
    assert.equal(mode(HOME), 0o700);
  });
});

describe("inbox 取出", () => {
  before(resetHome);
  test("取出后新写入的消息不丢，崩溃遗留的 .draining 会被回收", () => {
    store.appendInbox([{ n: 1 }, { n: 2 }]);
    assert.deepEqual(store.drainInbox().map((m) => m.n), [1, 2]);
    store.appendInbox([{ n: 3 }]);
    fs.writeFileSync(`${store.paths().inbox}.1-1.draining`, `${JSON.stringify({ n: 0 })}\n`);
    assert.deepEqual(store.drainInbox().map((m) => m.n).sort(), [0, 3]);
    assert.deepEqual(store.drainInbox(), []);
  });
});

describe("monitor 端到端（假 iLink + 假 webhook）", { timeout: 90_000 }, () => {
  let server;
  let child;
  const wakes = [];
  let expired = false;
  let polls = 0;

  before(async () => {
    resetHome();
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
        if (req.url === "/wake") {
          wakes.push({ auth: req.headers.authorization, body: JSON.parse(body) });
          if (wakes.length === 1) { res.statusCode = 500; return res.end("boom"); }
          return json({ success: true, runUuid: `run-${wakes.length}` });
        }
        if (req.url === "/ilink/bot/getupdates") {
          polls += 1;
          if (expired) return json({ ret: -14, errcode: -14, errmsg: "session timeout" });
          if (polls === 1) {
            return json({
              ret: 0,
              get_updates_buf: "b1",
              msgs: [
                { message_type: 1, message_state: 2, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "你好" } }] },
                { message_type: 1, message_state: 2, from_user_id: "stranger", context_token: "ctx2", item_list: [{ type: 1, text_item: { text: "spam" } }] },
              ],
            });
          }
          await sleep(300);
          return json({ ret: 0, msgs: [], get_updates_buf: "b1" });
        }
        return json({ ret: 0 });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    seedAccount(base);
    store.saveGlobalWake(`${base}/wake`, "crsr_test");
    child = spawn(process.execPath, [INDEX, "--monitor"], {
      env: { ...process.env, GROK_WECHAT_HOME: HOME },
      stdio: "ignore",
    });
  });

  after(() => {
    child?.kill("SIGKILL");
    server?.close();
    resetHome();
  });

  test("只收本人消息；webhook 失败后自动重试成功", async () => {
    const deadline = Date.now() + 20_000;
    while (wakes.length < 2 && Date.now() < deadline) await sleep(200);
    assert.ok(wakes.length >= 2, `wake 次数 ${wakes.length}`);
    assert.equal(wakes[0].auth, "Bearer crsr_test");
    for (const w of wakes) assert.deepEqual(w.body.from_user_ids, ["owner"]);
    const inbox = store.drainInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].text, "你好");
    // 唤醒成功后不再重复唤醒
    const n = wakes.length;
    await sleep(3_000);
    assert.equal(wakes.length, n);
  });

  test("没有 MCP 进程超过 30s 也不会自我卸载", async () => {
    await sleep(36_000);
    assert.equal(child.exitCode, null, "monitor 不应退出");
    assert.ok(fs.existsSync(store.paths().state), "account.json 不应被删");
    assert.ok(fs.existsSync(store.fallbackWakePath()), "wake.json 不应被删");
  });

  test("登录过期只通知一次", async () => {
    const before = wakes.length;
    expired = true;
    const deadline = Date.now() + 10_000;
    while (wakes.length === before && Date.now() < deadline) await sleep(200);
    const notices = wakes.slice(before).filter((w) => w.body.event === "session_expired");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.ilink_bot_id, "bot1");
  });
});
