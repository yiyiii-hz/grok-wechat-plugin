import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const MAX_LOCAL_TOKENS = 10;

export function homeDir() {
  const raw = process.env.GROK_WECHAT_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".grok-wechat");
}

export function paths() {
  const home = homeDir();
  return {
    home,
    state: path.join(home, "account.json"),
    inbox: path.join(home, "inbox.jsonl"),
    pid: path.join(home, "monitor.pid"),
    media: path.join(home, "media"),
    log: path.join(home, "monitor.log"),
  };
}

export function emptyAccount() {
  return {
    token: "",
    baseUrl: DEFAULT_BASE,
    ilinkBotId: "",
    ilinkUserId: "",
    getUpdatesBuf: "",
    contextTokens: {},
    typingTickets: {},
    wake: null,
    dedicatedAssistant: null,
  };
}

export function emptyState() {
  return {
    accounts: [],
    pendingQrs: [],
    allowFrom: [],
  };
}

function ensureHome() {
  const { home, media } = paths();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(media, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // ignore
  }
}

/** 原子写入且权限 600：先写临时文件并收紧权限，再 rename 覆盖。 */
function writeFileSecure(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function migrateLegacyState(raw) {
  if (Array.isArray(raw.accounts)) return raw;
  const state = emptyState();
  if (raw.token) {
    state.accounts.push({
      ...emptyAccount(),
      token: raw.token,
      baseUrl: raw.baseUrl || DEFAULT_BASE,
      ilinkBotId: raw.ilinkBotId || "",
      ilinkUserId: raw.ilinkUserId || "",
      getUpdatesBuf: raw.getUpdatesBuf || "",
      contextTokens: raw.contextTokens || {},
      typingTickets: raw.typingTickets || {},
    });
  }
  if (raw.pendingQr?.qrcode) {
    state.pendingQrs.push(raw.pendingQr);
  }
  state.allowFrom = raw.allowFrom || [];
  return state;
}

export function loadState() {
  ensureHome();
  const { state } = paths();
  if (!fs.existsSync(state)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(state, "utf8"));
    return { ...emptyState(), ...migrateLegacyState(raw) };
  } catch {
    return emptyState();
  }
}

export function saveState(next) {
  ensureHome();
  writeFileSecure(paths().state, JSON.stringify(next, null, 2));
}

export function updateState(mutator) {
  const current = loadState();
  const next = mutator(current) ?? current;
  saveState(next);
  return next;
}

export function listAccounts(state = loadState()) {
  return state.accounts.filter((a) => a.token);
}

export function findAccount(state, { ilink_bot_id, ilink_user_id, token } = {}) {
  if (ilink_bot_id) {
    const hit = state.accounts.find((a) => a.ilinkBotId === ilink_bot_id);
    if (hit) return hit;
  }
  if (ilink_user_id) {
    const hit = state.accounts.find((a) => a.ilinkUserId === ilink_user_id);
    if (hit) return hit;
  }
  if (token) {
    const hit = state.accounts.find((a) => a.token === token);
    if (hit) return hit;
  }
  return null;
}

export function requireAccount(state, { ilink_bot_id, ilink_user_id } = {}) {
  if (ilink_bot_id || ilink_user_id) {
    const account = findAccount(state, { ilink_bot_id, ilink_user_id });
    if (!account?.token) {
      throw new Error(`未找到账号 ilink_bot_id=${ilink_bot_id || ""} ilink_user_id=${ilink_user_id || ""}`);
    }
    return account;
  }
  const accounts = listAccounts(state);
  if (!accounts.length) throw new Error("未登录。先 wechat_login_start 出码，立即 wechat_login_wait 至 logged_in=true");
  if (accounts.length === 1) return accounts[0];
  throw new Error("已绑定多个微信账号，请指定 ilink_bot_id");
}

export function localTokenList(state = loadState()) {
  return listAccounts(state)
    .map((a) => a.token)
    .slice(0, MAX_LOCAL_TOKENS);
}

export function upsertAccount(state, account) {
  const idx = state.accounts.findIndex((a) =>
  (account.ilinkBotId && a.ilinkBotId === account.ilinkBotId)
  || (account.token && a.token === account.token));
  if (idx >= 0) {
    state.accounts[idx] = { ...state.accounts[idx], ...account };
    const [updated] = state.accounts.splice(idx, 1);
    state.accounts.unshift(updated);
  } else {
    state.accounts.unshift(account);
  }
  return state;
}

export function removeAccount(state, { ilink_bot_id, ilink_user_id } = {}) {
  state.accounts = state.accounts.filter((a) => {
    if (ilink_bot_id && a.ilinkBotId === ilink_bot_id) return false;
    if (ilink_user_id && a.ilinkUserId === ilink_user_id) return false;
    return true;
  });
  return state;
}

export function rememberContext(state, account, userId, contextToken) {
  if (!account || !userId || !contextToken) return state;
  account.contextTokens[userId] = { token: contextToken, at: Date.now() };
  return state;
}

export function contextFor(account, userId) {
  const entry = account?.contextTokens?.[userId];
  return entry?.token || "";
}

export function accountsWithContext(state, userId) {
  return listAccounts(state).filter((a) => contextFor(a, userId));
}

export function resolveAccountForPeer(state, { to_user_id, ilink_bot_id } = {}) {
  if (ilink_bot_id) return requireAccount(state, { ilink_bot_id });
  if (!to_user_id) throw new Error("没有目标用户。传入 to_user_id，或等对方先发一条微信");
  const matches = accountsWithContext(state, to_user_id);
  if (!matches.length) {
    throw new Error("还没有该用户的 context_token。对方需要先从微信给你发一条消息，会话通道才会建立");
  }
  if (matches.length > 1) {
    throw new Error(`多个账号都能回复 ${to_user_id}，请指定 ilink_bot_id`);
  }
  return matches[0];
}

/** allowlist 为空时只接收扫码绑定者本人的私信；非空则只处理名单内用户。 */
export function isAllowed(state, userId) {
  if (!userId) return false;
  if (state.allowFrom?.length) return state.allowFrom.includes(userId);
  return listAccounts(state).some((a) => a.ilinkUserId === userId);
}

export function appendInbox(messages) {
  if (!messages.length) return;
  ensureHome();
  const { inbox } = paths();
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  fs.appendFileSync(inbox, lines, { mode: 0o600 });
}

/**
 * 先把 inbox 原子 rename 走再读，期间 monitor 新写入的消息落进新文件，不会被清掉。
 * 上次中途崩溃遗留的 *.draining 也一并取出。
 */
export function drainInbox() {
  const { home, inbox } = paths();
  if (fs.existsSync(inbox)) {
    fs.renameSync(inbox, `${inbox}.${Date.now()}-${process.pid}.draining`);
  }
  if (!fs.existsSync(home)) return [];
  const prefix = `${path.basename(inbox)}.`;
  const files = fs.readdirSync(home)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".draining"))
    .sort();
  let raw = "";
  for (const f of files) {
    const file = path.join(home, f);
    raw += fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function peekInboxCount() {
  const { inbox } = paths();
  if (!fs.existsSync(inbox)) return 0;
  return fs
    .readFileSync(inbox, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
}

export function writePid(pid) {
  ensureHome();
  fs.writeFileSync(paths().pid, String(pid));
}

export function readPid() {
  const { pid } = paths();
  if (!fs.existsSync(pid)) return 0;
  const n = Number(fs.readFileSync(pid, "utf8").trim());
  return Number.isFinite(n) ? n : 0;
}

export function clearPid() {
  const { pid } = paths();
  if (fs.existsSync(pid)) fs.unlinkSync(pid);
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function monitorRunning() {
  const pid = readPid();
  if (isPidAlive(pid)) return pid;
  if (pid) clearPid();
  return 0;
}

export function fallbackWakePath() {
  return path.join(homeDir(), "wake.json");
}

export function loadFallbackWake() {
  const wakeFile = fallbackWakePath();
  if (!fs.existsSync(wakeFile)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(wakeFile, "utf8"));
    if (cfg.url && cfg.key) return { url: cfg.url, key: cfg.key };
  } catch {
    // ignore
  }
  return null;
}

export function saveGlobalWake(url, key) {
  ensureHome();
  writeFileSecure(fallbackWakePath(), JSON.stringify({ url, key }, null, 2));
}

export function hasGlobalWake() {
  return Boolean(loadFallbackWake());
}

export function resolveWakeForAccount(account) {
  if (account?.wake?.url && account?.wake?.key) return account.wake;
  return loadFallbackWake();
}

export function hasAccountWake(account) {
  return hasGlobalWake() || Boolean(account?.wake?.url && account?.wake?.key);
}

export function saveStateSecure(next) {
  saveState(next);
  try {
    fs.chmodSync(paths().state, 0o600);
  } catch {
    // ignore
  }
}
