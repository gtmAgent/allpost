/**
 * 推特图文/视频发帖：直达 compose URL → 填文案 → 上传图片或多图 / 单个视频 → 发布。
 * 定位优先 data-testid / role / href，避免依赖界面语言文案。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const sleep = (ms: number) => Bun.sleep(ms);

function socialHomeBase(): string {
  const raw = (Bun.env.SOCIAL_HOME || 'https://x.com').trim().replace(/\/+$/, '');
  return raw || 'https://x.com';
}

function normalizeMedia(raw: TaskRunConfig['media']): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function normalizeVideo(raw: TaskRunConfig['video']): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '';
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({ step, reason, code, labels });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function waitForCount(
  client: XportBrowserClient,
  path: ReturnType<typeof nodePath>,
  expect: 'ge1' | 'eq0',
  rounds: number,
  intervalMs: number,
): Promise<number> {
  let last = -1;
  for (let i = 0; i < rounds; i++) {
    const [ok, , count] = await client.getNodeCount(0, path);
    last = ok ? (count ?? 0) : 0;
    if (expect === 'ge1' && last >= 1) return last;
    if (expect === 'eq0' && last === 0) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function pageUrlNow(client: XportBrowserClient): Promise<string> {
  const [ok, , pageUrl] = await client.getPageUrl();
  return ok ? String(pageUrl ?? '') : '';
}

function isAccountRestrictedUrl(url: string): boolean {
  return /\/i\/graduated-access/i.test(url);
}

/** 发帖框内发布按钮：现场可能是 tweetButton 或 tweetButtonInline（MCP/incident 证据）。 */
function composePostButtonPath() {
  return nodePath()
    .css('div[role="dialog"][aria-modal="true"]')
    .then()
    .css(
      'button[data-testid="tweetButton"]:not([disabled])',
      'button[data-testid="tweetButtonInline"]:not([disabled])',
    )
    .one();
}

function composeTextboxPath() {
  return nodePath()
    .css('div[role="dialog"][aria-modal="true"]')
    .then()
    .css('div[data-testid="tweetTextarea_0"]')
    .one();
}

/** 发布后二次确认（确认层可叠在发帖框之上；结构 testid，不依赖文案）。 */
async function dismissPublishConfirmations(client: XportBrowserClient): Promise<boolean> {
  let clicked = false;
  const confirmBtn = nodePath().css('button[data-testid="confirmationSheetConfirm"]').one();
  for (let i = 0; i < 3; i++) {
    if (((await client.getNodeCount(0, confirmBtn))[2] ?? 0) < 1) break;
    client.taskLog(`click confirmationSheetConfirm round=${i + 1}`);
    await client.clickNode(0, confirmBtn);
    clicked = true;
    await sleep(900);
  }
  return clicked;
}

/** 关掉挡住主流程、且不是发帖框的遮罩（结构定位，不依赖文案语言）。 */
async function dismissBlockingSheets(client: XportBrowserClient): Promise<void> {
  const composeTextbox = composeTextboxPath();
  if (((await client.getNodeCount(0, composeTextbox))[2] ?? 0) >= 1) return;

  const confirmBtn = nodePath().css('button[data-testid="confirmationSheetConfirm"]').one();
  if (((await client.getNodeCount(0, confirmBtn))[2] ?? 0) >= 1) {
    await client.clickNode(0, confirmBtn);
    await sleep(800);
  }

  if (((await client.getNodeCount(0, composeTextbox))[2] ?? 0) >= 1) return;

  // 条款 / Premium / graduated-access 等 sheet：关按钮用 testid，不依赖「Got it」文案
  const sheetClose = nodePath()
    .css('div[data-testid="sheetDialog"]')
    .then()
    .css('button[data-testid="app-bar-close"]')
    .one();
  if (((await client.getNodeCount(0, sheetClose))[2] ?? 0) >= 1) {
    await client.clickNode(0, sheetClose);
    await sleep(800);
  }

  if (((await client.getNodeCount(0, composeTextbox))[2] ?? 0) >= 1) return;

  const modalClose = nodePath()
    .css('div[role="dialog"][aria-modal="true"]')
    .then()
    .css('button[data-testid="app-bar-close"]')
    .one();
  // 仅当弹层里没有发帖输入框时才关，避免误关 compose
  if (
    ((await client.getNodeCount(0, composeTextbox))[2] ?? 0) < 1 &&
    ((await client.getNodeCount(0, modalClose))[2] ?? 0) >= 1
  ) {
    await client.clickNode(0, modalClose);
    await sleep(800);
  }

  if (((await client.getNodeCount(0, composeTextbox))[2] ?? 0) >= 1) return;

  await client.pressKey(0, 'escape');
  await sleep(600);
}

/** 发帖是否已结束：以发帖 textbox 消失为主；无发帖 dialog 或已回 home 也算成功。 */
function isComposeClosed(textboxCount: number, composeDialogCount: number, url: string): boolean {
  if (textboxCount === 0) return true;
  if (composeDialogCount === 0) return true;
  if (/\/home(?:\?|$|#)/i.test(url) && textboxCount === 0) return true;
  return false;
}

async function openComposeDialog(
  client: XportBrowserClient,
  composeUrl: string,
): Promise<'ok' | 'nav_failed' | 'not_found'> {
  const [goOk] = await client.pageGoTo(0, { url: composeUrl, timeoutMs: 60_000 });
  if (!goOk) return 'nav_failed';
  await sleep(1000);

  const textbox = nodePath()
    .css('div[role="dialog"][aria-modal="true"]')
    .then()
    .css('div[data-testid="tweetTextarea_0"]')
    .one();

  let ready = await waitForCount(client, textbox, 'ge1', 40, 500);
  if (ready >= 1) return 'ok';

  client.taskLog('compose textbox missing; dismiss sheets then retry compose URL');
  await dismissBlockingSheets(client);
  await sleep(500);

  const [retryOk] = await client.pageGoTo(0, { url: composeUrl, timeoutMs: 60_000 });
  if (!retryOk) return 'nav_failed';
  await sleep(1000);
  ready = await waitForCount(client, textbox, 'ge1', 40, 500);
  return ready >= 1 ? 'ok' : 'not_found';
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const mediaType = taskConfig.media_type === 'video' ? 'video' : 'image';
  const content = String(taskConfig.content ?? '').trim();
  const media = normalizeMedia(taskConfig.media);
  const video = normalizeVideo(taskConfig.video);
  const mediaCount = mediaType === 'video' ? (video ? 1 : 0) : media.length;

  if (!content) {
    return automationFailWithContext('请填写帖文案', {
      code: 'UNKNOWN',
      step: 'validate_content',
    });
  }
  if (mediaType === 'image' && media.length === 0) {
    return automationFailWithContext('请至少选择一张配图（media_type=image）', {
      code: 'UNKNOWN',
      step: 'validate_media',
    });
  }
  if (mediaType === 'video' && !video) {
    return automationFailWithContext('请选择一个视频（media_type=video，每帖仅 1 个）', {
      code: 'UNKNOWN',
      step: 'validate_video',
    });
  }

  client.taskLog(
    `mediaType=${mediaType} contentLen=${content.length} mediaCount=${mediaCount}`,
  );

  try {
    const homeUrl = `${socialHomeBase()}/home`;
    const composeUrl = `${socialHomeBase()}/compose/post`;

    // 先到主页确认登录态，再直达发帖 URL，避开主页条款/Premium 等遮罩挡侧栏发帖按钮
    const [homeOk, homeMsg] = await client.pageGoTo(0, { url: homeUrl, timeoutMs: 60_000 });
    if (!homeOk) {
      return failStep(client, 'open_home', homeMsg || '打开主页失败', 'NAV_FAILED', { homeUrl });
    }
    await sleep(1200);

    const url = await pageUrlNow(client);
    if (/\/login|\/i\/flow\/login/i.test(url)) {
      return failStep(client, 'check_login', '浏览器未登录 X，请先登录后再跑任务', 'NOT_LOGGED_IN', {
        url,
      });
    }
    if (isAccountRestrictedUrl(url)) {
      return failStep(
        client,
        'check_account',
        '该 X 账号功能受限（需提升信任度后才能发帖），请换已可正常发帖的账号重试',
        'ACCOUNT_RESTRICTED',
        { url },
      );
    }

    await dismissBlockingSheets(client);

    const opened = await openComposeDialog(client, composeUrl);
    if (opened === 'nav_failed') {
      return failStep(client, 'open_compose', '打开发帖页失败', 'NAV_FAILED', { composeUrl });
    }
    if (opened === 'not_found') {
      return failStep(
        client,
        'open_compose',
        '发帖框未打开，请确认已登录；若有条款/订阅弹窗请先关闭后再试',
        'ELEMENT_NOT_FOUND',
        { composeUrl },
      );
    }

    const composeOpen = nodePath().css('div[role="dialog"][aria-modal="true"]').one();
    const textbox = nodePath()
      .css('div[role="dialog"][aria-modal="true"]')
      .then()
      .css('div[data-testid="tweetTextarea_0"]')
      .one();

    await sleep(500);
    const [typeOk, typeMsg] = await client.typeInNode(0, textbox, content);
    if (!typeOk) {
      return failStep(client, 'type_content', typeMsg || '输入文案失败', 'ELEMENT_NOT_FOUND');
    }
    await sleep(600);

    const fileInput = nodePath()
      .css('div[role="dialog"][aria-modal="true"]')
      .then()
      .css('input[data-testid="fileInput"]')
      .one();

    const attachments = nodePath()
      .css('div[role="dialog"][aria-modal="true"]')
      .then()
      .css('div[data-testid="attachments"]')
      .one();

    // 视频预览：attachments 内 video（MCP 探路确认）
    const attachmentVideo = nodePath()
      .css('div[role="dialog"][aria-modal="true"]')
      .then()
      .css('div[data-testid="attachments"]')
      .then()
      .css('video')
      .one();

    if (mediaType === 'video') {
      const [upOk, upMsg] = await client.uploadFile(0, fileInput, video);
      if (!upOk) {
        return failStep(client, 'upload_video', upMsg || '上传视频失败', 'UNKNOWN');
      }
      // 视频需处理/转码，等待更久；先等附件区出现，再等 video 元素就绪
      const attachCount = await waitForCount(client, attachments, 'ge1', 120, 500);
      if (attachCount < 1) {
        return failStep(client, 'wait_video', '视频附件未出现，请换片重试或检查网络', 'UNKNOWN');
      }
      const videoReady = await waitForCount(client, attachmentVideo, 'ge1', 120, 500);
      if (videoReady < 1) {
        return failStep(
          client,
          'wait_video_preview',
          '视频预览未加载完成，请换片重试或检查网络',
          'UNKNOWN',
        );
      }
      await sleep(1200);
    } else {
      const [upOk, upMsg] =
        media.length === 1
          ? await client.uploadFile(0, fileInput, media[0]!)
          : await client.uploadFiles(0, fileInput, media);
      if (!upOk) {
        return failStep(client, 'upload_media', upMsg || '上传配图失败', 'UNKNOWN');
      }

      const attachCount = await waitForCount(client, attachments, 'ge1', 40, 500);
      if (attachCount < 1) {
        return failStep(client, 'wait_media', '配图未加载完成，请换图重试或检查网络', 'UNKNOWN');
      }
      await sleep(800);
    }

    const postBtn = composePostButtonPath();
    const composeTextbox = composeTextboxPath();
    // 配图处理完前 Post 可能 disabled；先等到可点
    const enabledReady = await waitForCount(client, postBtn, 'ge1', mediaType === 'video' ? 60 : 40, 500);
    if (enabledReady < 1) {
      return failStep(
        client,
        'publish_post',
        '发布按钮不可用（媒体可能仍在处理），请换图/换片后重试',
        'UNKNOWN',
      );
    }

    const maxAttempts = mediaType === 'video' ? 14 : 10;
    const settleMs = mediaType === 'video' ? 2500 : 1500;
    let published = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const [postCountOk, , postCount] = await client.getNodeCount(0, postBtn);
      if (postCountOk && (postCount ?? 0) >= 1) {
        client.taskLog(`click Post attempt=${attempt}`);
        await client.scrollNodeIntoView(0, postBtn);
        await sleep(400);
        await client.clickNode(0, postBtn);
        await sleep(700);
        await dismissPublishConfirmations(client);
      } else {
        // 提交中按钮可能暂时消失；仍处理确认层并等待关闭
        await dismissPublishConfirmations(client);
      }
      await sleep(settleMs);

      const curUrl = await pageUrlNow(client);
      if (isAccountRestrictedUrl(curUrl)) {
        return failStep(
          client,
          'publish_post',
          '该 X 账号功能受限，无法完成发帖；请换可正常发帖的账号，或先在 App 内提升账号信任度后再试',
          'ACCOUNT_RESTRICTED',
          { url: curUrl },
        );
      }

      // 发帖框 textbox 消失 = 发布成功；其它 dialog（条款/订阅）不算失败遮挡
      const textboxLeft = (await client.getNodeCount(0, composeTextbox))[2] ?? 0;
      const composeLeft = (await client.getNodeCount(0, composeOpen))[2] ?? 0;
      if (isComposeClosed(textboxLeft, composeLeft, curUrl)) {
        published = true;
        break;
      }
    }

    if (!published) {
      // 末轮再点一次确认并短等，避免卡在二次确认
      await dismissPublishConfirmations(client);
      await sleep(1500);
      const curUrl = await pageUrlNow(client);
      const textboxLeft = (await client.getNodeCount(0, composeTextbox))[2] ?? 0;
      const composeLeft = (await client.getNodeCount(0, composeOpen))[2] ?? 0;
      if (!isComposeClosed(textboxLeft, composeLeft, curUrl)) {
        return failStep(
          client,
          'publish_post',
          '点击发布后发帖框未关闭，可能触发确认弹窗或风控，请人工检查后重试',
          'UNKNOWN',
        );
      }
    }

    await sleep(800);
    const [, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: mediaType === 'video' ? '视频发帖成功' : '发帖成功',
      data: {
        mediaType,
        content,
        mediaCount,
        finalUrl: String(finalUrl ?? ''),
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failStep(client, 'unexpected', reason, 'UNKNOWN');
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
