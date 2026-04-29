const { chromium } = require("playwright");

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count === 0) continue;
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function runLogin({ username, password, url }) {
  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // 该站点在部分会话先展示“请先登录...点击此处”的跳转提示。
    const jumpToLogin = await firstVisible(page, [
      "a:has-text('点击此处')",
      "a:has-text('点击')",
    ]);
    if (jumpToLogin) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        jumpToLogin.click(),
      ]);
      await page.waitForTimeout(1500);
    }

    const usernameSelectors = [
      "input[placeholder*='账号']",
      "input[placeholder*='用户名']",
      "input[name='username']",
      "input[name='account']",
      "input[type='text']",
    ];
    const passwordSelectors = [
      "input[placeholder*='密码']",
      "input[name='password']",
      "input[type='password']",
    ];
    const submitSelectors = [
      "button:has-text('登录')",
      "button:has-text('登 录')",
      "button[type='submit']",
      ".el-button--primary",
      "input[type='submit']",
    ];

    const usernameInput = await firstVisible(page, usernameSelectors);
    const passwordInput = await firstVisible(page, passwordSelectors);

    if (!usernameInput || !passwordInput) {
      throw new Error("未识别到登录输入框，请确认是否出现验证码、SSO 页或异常拦截页。");
    }

    await usernameInput.fill(username);
    await passwordInput.fill(password);

    let clicked = false;
    const submitButton = await firstVisible(page, submitSelectors);
    if (submitButton) {
      await submitButton.click();
      clicked = true;
    } else {
      await passwordInput.press("Enter");
      clicked = true;
    }

    if (!clicked) {
      throw new Error("没有找到可点击的登录按钮。");
    }

    await page.waitForTimeout(2500);
    const currentUrl = page.url();

    if (currentUrl.includes("/home") || !currentUrl.includes("login")) {
      return `已执行登录动作。当前地址：${currentUrl}\n如果有验证码或二次验证，请在打开的浏览器里继续完成。`;
    }

    return `已提交账号密码，但仍停留在：${currentUrl}\n可能是账号密码错误，或需要验证码。`;
  } finally {
    // 保持浏览器打开，方便用户继续完成验证码/二次验证
  }
}

module.exports = { runLogin };
