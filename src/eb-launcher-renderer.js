const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const dateInputEl = document.getElementById("dateInput");
const waitSecondsEl = document.getElementById("waitSeconds");
const runModeEl = document.getElementById("runMode");
const rememberInput = document.getElementById("remember");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const logsEl = document.getElementById("logs");

function appendLog(text) {
  logsEl.textContent += text;
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function init() {
  const creds = await window.ebLauncher.readCreds();
  if (creds.username) {
    usernameInput.value = creds.username;
    rememberInput.checked = true;
  }
  if (creds.password) passwordInput.value = creds.password;

  const d = new Date();
  d.setDate(d.getDate() - 1);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  dateInputEl.value = `${m}.${day}`;
  waitSecondsEl.value = "35";
  runModeEl.value = "visible";
}

startBtn.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const dateInput = dateInputEl.value.trim();
  const waitSeconds = waitSecondsEl.value.trim();
  const runMode = runModeEl.value;
  const remember = rememberInput.checked;

  startBtn.disabled = true;
  statusEl.textContent = "启动中...";
  logsEl.textContent = "";

  const result = await window.ebLauncher.startScript({
    username,
    password,
    remember,
    dateInput,
    waitSeconds,
    runMode,
  });
  if (!result.ok) {
    statusEl.textContent = result.message;
    startBtn.disabled = false;
    return;
  }

  statusEl.textContent = "运行中...";
});

stopBtn.addEventListener("click", async () => {
  const result = await window.ebLauncher.stopScript();
  statusEl.textContent = result.message;
  if (result.ok) appendLog("\n🛑 已请求停止脚本\n");
});

window.ebLauncher.onLog((text) => appendLog(text));
window.ebLauncher.onDone(({ code, message }) => {
  statusEl.textContent = message;
  startBtn.disabled = false;
  appendLog(`\n${code === 0 ? "✅" : "❌"} ${message}\n`);
});

init();
