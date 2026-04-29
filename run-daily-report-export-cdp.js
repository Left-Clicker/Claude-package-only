const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const XLSX = require("xlsx");

function configurePlaywrightBrowserPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;

  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "playwright-core", ".local-browsers")
      : "",
    path.join(__dirname, "node_modules", "playwright-core", ".local-browsers"),
    path.join(process.cwd(), "node_modules", "playwright-core", ".local-browsers"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = p;
      break;
    }
  }
}

class AbortError extends Error {
  constructor() {
    super("任务已取消");
    this.name = "AbortError";
  }
}

function ensureNotAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    ensureNotAborted(signal);
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sanitizeFilePart(text) {
  return String(text).replace(/[\\/:*?"<>|]/g, "_").trim();
}

function monthDayLabel(dateObj) {
  return `${dateObj.getMonth() + 1}.${dateObj.getDate()}`;
}

function parseMonthDayToken(token) {
  const t = String(token || "").trim();
  const m = t.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = new Date().getFullYear();
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function listDatesFromInput(inputText) {
  const text = String(inputText || "").trim();
  if (!text) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return [d];
  }

  const tokens = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const result = [];
  for (const token of tokens) {
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-").map((s) => s.trim());
      const start = parseMonthDayToken(startRaw);
      const end = parseMonthDayToken(endRaw);
      if (!start || !end) {
        throw new Error(`日期范围格式错误: ${token}，应为如 4.28-4.30`);
      }
      if (start.getTime() > end.getTime()) {
        throw new Error(`日期范围起止顺序错误: ${token}`);
      }
      const cursor = new Date(start);
      while (cursor.getTime() <= end.getTime()) {
        result.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      const d = parseMonthDayToken(token);
      if (!d) throw new Error(`日期格式错误: ${token}，应为如 4.28`);
      result.push(d);
    }
  }

  // 去重并按时间升序
  const uniq = new Map();
  for (const d of result) {
    uniq.set(formatDate(d), d);
  }
  return Array.from(uniq.values()).sort((a, b) => a.getTime() - b.getTime());
}

function buildOutputWorkbookPath(dateLabel) {
  const safeLabel = sanitizeFilePart(dateLabel || "unknown");
  return path.join(process.cwd(), `英文黑道每日数据模板_${safeLabel}.xlsx`);
}

function buildRawExportPath(baseDir, dateLabel, label) {
  const safeDate = sanitizeFilePart(dateLabel);
  return path.join(baseDir, `CDP_运营报表_${safeDate}_${label}.xlsx`);
}

function ensureDateOutputDir(dateLabel) {
  const dir = path.join(process.cwd(), `每日数据${sanitizeFilePart(dateLabel)}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function importToWorkbook(sourceFile, targetWorkbook, targetSheet) {
  const srcWb = XLSX.readFile(sourceFile, { raw: true });
  const srcFirstSheet = srcWb.SheetNames[0];
  if (!srcFirstSheet) throw new Error(`源文件无可用 sheet: ${sourceFile}`);
  const srcRows = XLSX.utils.sheet_to_json(srcWb.Sheets[srcFirstSheet], {
    header: 1,
    raw: true,
    defval: null,
  });

  const tgtWb = XLSX.readFile(targetWorkbook, {
    cellFormula: true,
    cellStyles: true,
    cellNF: true,
    cellDates: true,
  });
  if (!tgtWb.SheetNames.includes(targetSheet)) {
    throw new Error(`目标 sheet 不存在: ${targetSheet}`);
  }
  tgtWb.Sheets[targetSheet] = XLSX.utils.aoa_to_sheet(srcRows);
  XLSX.writeFile(tgtWb, targetWorkbook);
}

async function clickIfVisible(locator, signal) {
  ensureNotAborted(signal);
  if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
    await locator.click();
    return true;
  }
  return false;
}

async function loginIfNeeded(page, options) {
  const { loginUser, loginPass, signal } = options;
  ensureNotAborted(signal);
  const jump = page.getByRole("link", { name: "点击此处" }).first();
  await clickIfVisible(jump, signal);

  const user = page
    .locator(
      "input[placeholder*='账号'], input[name='username'], input[name='email'], input[placeholder*='企业邮箱']"
    )
    .first();
  const pass = page.locator("input[placeholder*='密码'], input[type='password']").first();
  if ((await user.count()) === 0 || (await pass.count()) === 0) return;

  await user.fill(loginUser);
  await pass.fill(loginPass);
  // 登录页遮罩较多，优先用回车提交，避免点击被遮挡。
  await pass.press("Enter").catch(() => {});
  await sleep(2800, signal);
}

async function waitPageReady(page, options) {
  const { signal } = options;
  for (let i = 0; i < 15; i += 1) {
    ensureNotAborted(signal);
    const ready =
      (await page.getByRole("button", { name: "快捷填充" }).count()) > 0 &&
      (await page.getByRole("button", { name: "搜索" }).count()) > 0;
    if (ready) return;
    await loginIfNeeded(page, options);
    await sleep(1000, signal);
  }
  throw new Error("运营报表页面未就绪。");
}

async function applyTemplate(page, signal) {
  ensureNotAborted(signal);
  await page.getByRole("button", { name: "快捷填充" }).first().click();
  await sleep(300, signal);
  await page.getByPlaceholder("请输入关键字").first().fill("英文每日数据模板");
  await sleep(250, signal);
  await page.getByText("英文每日数据模板", { exact: false }).first().click();
  await sleep(150, signal);

  // 模板面板中的确认
  const panelConfirm = page.getByRole("button", { name: "确认" }).last();
  await clickIfVisible(panelConfirm, signal);
  await sleep(250, signal);

  // 二次“应用模板”确认弹窗（如果出现）
  const applyDialogConfirm = page.locator("div:has-text('应用模板') button:has-text('确认')").last();
  await clickIfVisible(applyDialogConfirm, signal);
  await sleep(500, signal);
}

async function setDateAndConfirm(page, dateText, signal) {
  ensureNotAborted(signal);
  const dateInput = page.getByPlaceholder("选择日期").first();
  await dateInput.click();
  await sleep(100, signal);
  await dateInput.fill(dateText);
  await dateInput.press("Enter").catch(() => {});

  const confirmBtn = page.getByRole("button", { name: "确认" }).last();
  if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible().catch(() => false))) {
    await confirmBtn.click();
  }
  await sleep(350, signal);
}

async function exportOnce(page, label, outputWorkbook, dateLabel, outputDir, searchWaitMs, signal, logger) {
  ensureNotAborted(signal);
  await page.getByRole("button", { name: "搜索" }).first().click();
  await sleep(searchWaitMs, signal);
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.getByRole("button", { name: "导出" }).first().click();
  const download = await downloadPromise;
  const savePath = buildRawExportPath(outputDir, dateLabel, label);
  if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
  await download.saveAs(savePath);
  logger(`导出完成: ${savePath}`);

  const sheetName = label === "美国" ? "美国数据" : "粘贴原始数据";
  await importToWorkbook(savePath, outputWorkbook, sheetName);
  logger(`已写入目标文件: ${outputWorkbook} -> ${sheetName}`);
}

async function selectUS(page, signal) {
  ensureNotAborted(signal);
  const country = page
    .locator("xpath=//*[contains(normalize-space(.),'国家/地区')]/following::div[contains(@class,'cascaderWrapper')][1]")
    .first();

  const filter = page.getByPlaceholder("请输入筛选内容").first();
  // 只触发一次展开，然后明确等待面板出现，避免“点太快就结束”
  await country.click();
  await filter.waitFor({ state: "visible", timeout: 5000 });
  await sleep(500, signal);

  const selectVisibleUs = async () => {
    const clicked = await page.evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
      };
      const labels = Array.from(document.querySelectorAll(".nodeLabel"))
        .filter((el) => isVisible(el) && /US:美国|美国/.test((el.textContent || "").trim()));
      if (!labels.length) return false;

      // 优先点最右列，避开左侧层级列
      labels.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      labels[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    return clicked;
  };

  // 方案A：悬停常用，再搜美国
  let selected = false;
  const commonLabel = page.locator(".nodeLabel").filter({ hasText: "常用" }).first();
  if ((await commonLabel.count()) > 0 && (await commonLabel.isVisible().catch(() => false))) {
    await commonLabel.hover().catch(() => {});
    await sleep(200, signal);
  }
  await filter.fill("美国").catch(() => {});
  await sleep(200, signal);
  selected = await selectVisibleUs();

  // 方案B：点击常用（文字）-> 清除 -> 搜美国 -> 选美国
  if (!selected) {
    if ((await commonLabel.count()) > 0 && (await commonLabel.isVisible().catch(() => false))) {
      await commonLabel.click().catch(() => {});
      await sleep(120, signal);
    }
    const clearBtn = page.getByRole("button", { name: "清除" }).first();
    if ((await clearBtn.count()) > 0 && (await clearBtn.isVisible().catch(() => false))) {
      await clearBtn.click();
      await sleep(120, signal);
    }
    await filter.fill("美国").catch(() => {});
    await sleep(200, signal);
    selected = await selectVisibleUs();
  }

  if (!selected) {
    throw new Error("未找到国家地区选项：美国");
  }

  await page.keyboard.press("Escape").catch(() => {});
  await sleep(100, signal);

  const countryText = (await country.innerText().catch(() => "")).trim();
  if (!countryText.includes("美国")) {
    throw new Error(`国家地区未生效，当前值: ${countryText || "<empty>"}`);
  }
}

async function runDailyReportExport(options = {}) {
  configurePlaywrightBrowserPath();
  const {
    loginUser = process.env.EB_LOGIN_USER || "",
    loginPass = process.env.EB_LOGIN_PASS || "",
    dateInput = process.env.EB_DATE_INPUT || "",
    waitSeconds = Number(process.env.EB_WAIT_SECONDS || "35"),
    runMode = process.env.EB_RUN_MODE || "visible",
    signal,
    logger = (msg) => console.log(msg),
  } = options;

  if (!loginUser || !loginPass) {
    throw new Error("缺少账号密码，请通过环境变量 EB_LOGIN_USER / EB_LOGIN_PASS 传入。");
  }
  ensureNotAborted(signal);
  const targetUrl = "https://eastblue.xinyoudi.com/home/#/data-report/daily";
  const templateWorkbook = path.join(__dirname, "英文黑道每日数据模板.xlsx");
  const waitNum = Number(waitSeconds);
  const searchWaitMs = Number.isFinite(waitNum) && waitNum > 0 ? Math.floor(waitNum * 1000) : 35000;
  const runHeadless = String(runMode).toLowerCase() === "headless";

  if (!fs.existsSync(templateWorkbook)) {
    throw new Error(`未找到模板文件: ${templateWorkbook}`);
  }

  const dates = listDatesFromInput(dateInput);
  if (!dates.length) throw new Error("未解析到有效日期。");

  logger(`本次执行日期: ${dates.map((d) => monthDayLabel(d)).join(", ")}`);
  logger(`搜索等待: ${Math.floor(searchWaitMs / 1000)} 秒，浏览器模式: ${runHeadless ? "后台" : "可见"}`);
  const browser = await chromium.launch({ headless: runHeadless, slowMo: runHeadless ? 0 : 70 });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitPageReady(page, { loginUser, loginPass, signal });

    for (const d of dates) {
      ensureNotAborted(signal);
      const dateLabel = monthDayLabel(d);
      const targetDate = formatDate(d);
      const outputDir = ensureDateOutputDir(dateLabel);
      const outputWorkbook = path.join(outputDir, path.basename(buildOutputWorkbookPath(dateLabel)));
      fs.copyFileSync(templateWorkbook, outputWorkbook);
      logger(`已创建结果文件: ${outputWorkbook}`);

      await applyTemplate(page, signal);
      await setDateAndConfirm(page, targetDate, signal);
      await exportOnce(page, "全地区", outputWorkbook, dateLabel, outputDir, searchWaitMs, signal, logger);
      await selectUS(page, signal);
      await exportOnce(page, "美国", outputWorkbook, dateLabel, outputDir, searchWaitMs, signal, logger);

      logger(`单日完成: ${targetDate}，输出目录=${outputDir}`);
    }

    logger("全部日期流程完成。");
  } finally {
    await browser.close();
  }
}

module.exports = { runDailyReportExport, AbortError };

if (require.main === module) {
  runDailyReportExport()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
