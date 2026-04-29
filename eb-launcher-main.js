const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { runDailyReportExport, AbortError } = require("./run-daily-report-export-cdp");

const CREDS_FILE = "eb-credentials.json";
let runningTask = null;

function stopRunningProcess() {
  if (!runningTask) return false;
  runningTask.abortController.abort();
  return true;
}

function getCredsPath() {
  return path.join(app.getPath("userData"), CREDS_FILE);
}

function readCreds() {
  try {
    const raw = fs.readFileSync(getCredsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      username: typeof parsed.username === "string" ? parsed.username : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
    };
  } catch {
    return { username: "", password: "" };
  }
}

function writeCreds(username, password) {
  fs.writeFileSync(getCredsPath(), JSON.stringify({ username, password }, null, 2), "utf8");
}

function clearCreds() {
  try {
    fs.unlinkSync(getCredsPath());
  } catch {
    // ignore
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 460,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "eb-launcher-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "src", "eb-launcher.html"));
}

ipcMain.handle("eb:read-creds", async () => readCreds());

ipcMain.handle("eb:start-script", async (_evt, payload) => {
  const { username, password, remember, dateInput, waitSeconds, runMode } = payload || {};
  if (!username || !password) {
    return { ok: false, message: "账号和密码不能为空。" };
  }
  if (!dateInput || !String(dateInput).trim()) {
    return { ok: false, message: "请填写日期（支持 4.28 / 4.28,4.30 / 4.28-4.30）。" };
  }
  const waitNum = Number(waitSeconds);
  if (!Number.isFinite(waitNum) || waitNum <= 0) {
    return { ok: false, message: "等待秒数必须是大于 0 的数字。" };
  }
  const normalizedMode = runMode === "headless" ? "headless" : "visible";
  if (runningTask) {
    return { ok: false, message: "脚本正在运行中，请稍后再试。" };
  }

  if (remember) writeCreds(username, password);
  else clearCreds();

  const sendLog = (text) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("eb:log", `${text}\n`));
  };
  const abortController = new AbortController();
  runningTask = { abortController };
  runDailyReportExport({
    loginUser: username,
    loginPass: password,
    dateInput: String(dateInput).trim(),
    waitSeconds: waitNum,
    runMode: normalizedMode,
    signal: abortController.signal,
    logger: sendLog,
  })
    .then(() => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("eb:done", { code: 0, message: "脚本执行完成。" }));
    })
    .catch((error) => {
      if (error instanceof AbortError || error?.name === "AbortError") {
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send("eb:done", { code: 130, message: "脚本已停止。" })
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send("eb:done", { code: 1, message: `脚本执行失败: ${message}` })
      );
    })
    .finally(() => {
      runningTask = null;
    });

  return { ok: true, message: "脚本已启动。" };
});

ipcMain.handle("eb:stop-script", async () => {
  if (!runningTask) {
    return { ok: false, message: "当前没有运行中的脚本。" };
  }
  stopRunningProcess();
  return { ok: true, message: "已发送停止信号。" };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopRunningProcess();
  // On macOS, force full quit so it does not stay in Dock.
  app.quit();
});
