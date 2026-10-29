/**
 * Threads 发帖：SOCIAL_HOME → 打开创作入口 → 可选文案 / 图片 / 视频 → 发布。
 * 主路径优先语言无关结构（data-lexical-editor / input[type=file] / inViewport）；
 * 已观察语文案仅作入口/发布兜底 OR（英 MCP + 中录制 HTML）。
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

const THREADS_HOME = 'https://www.threads.net/';

/** 侧栏可见「New thread / 新建串文」按钮（比隐藏 aria / Create svg 更稳）。 */
const openComposerByTextPath = nodePath()
  .css('[role="button"]')
  .containAnyText('New thread', '新建串文')
  .one();

/** 备选：右下 FAB Create（英 MCP 证据）。 */
const openComposerFabPath = nodePath().css('svg[aria-label="Create"]').one();

const lexicalCss =
  '[contenteditable="true"][data-lexical-editor="true"][role="textbox"]';

/** 视口内全部 lexical（Feed + 浮层）；打开浮层后通常 ≥2。 */
const viewportLexicalManyPath = nodePath().css(lexicalCss).inViewport().many();

/**
 * 视口内「最后一个」lexical = 浮层输入框。
 * 注意：勿用 `.last()`（内部 one() 会把 multiple 关掉，宿主 click 可能 0 命中）；
 * 用 many+reverse，点击/粘贴取倒序列表首项即原 DOM 末项。
 */
const composerTextboxPath = nodePath().css(lexicalCss).inViewport().many(0, -1).reverse();

/**
 * 隐式 file input 通常不可见（不在视口），勿加 inViewport。
 * 禁止点系统选文件框，用 uploadFile 注入。
 */
const composerFileInputPath = nodePath()
  .css('input[type="file"][accept*="image"]')
  .many(0, -1)
  .reverse();

const composerImagePreviewPath = nodePath().css('img[src^="blob:"]').many(0, -1).reverse();

const composerVideoPreviewPath = nodePath().css('video').many(0, -1).reverse();

/** Post/发布：倒序后点首项 = DOM 最靠后的那个（作曲器）。 */
const composerPostButtonPath = nodePath()
  .css('[role="button"]')
  .containAnyText('Post', '发布')
  .many(0, -1)
  .reverse();

function resolveHomeUrl(): string {
  const fromEnv = Bun.env.SOCIAL_HOME?.trim();
  if (fromEnv) {
    return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
  }
  return THREADS_HOME;
}

function resourceMd5(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '';
}

function classifyThreadsUrl(pageUrl: string): 'login' | 'on_threads' | 'other' {
  if (!pageUrl || !/threads\.(net|com)/i.test(pageUrl)) return 'other';
  if (/\/login\b/i.test(pageUrl) || /accounts\/login/i.test(pageUrl)) return 'login';
  return 'on_threads';
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
  });
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
  pred: (n: number) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const [ok, , count] = await client.getNodeCount(0, path);
    last = ok && typeof count === 'number' ? count : 0;
    if (pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

/** 每次强制导航首页，清掉残留作曲器/草稿浮层，避免点到不可见 lexical。 */
async function ensureThreadsHome(
  client: XportBrowserClient,
  homeUrl: string,
  labels: Record<string, string>,
): Promise<AutomationRunResult | null> {
  const [preOk, , preUrlRaw] = await client.getPageUrl();
  if (preOk) {
    const preState = classifyThreadsUrl(preUrlRaw ?? '');
    if (preState === 'login') {
      return failStep(
        client,
        'check_login',
        'Browser is not logged in to Threads. Please log in on this fingerprint profile first.',
        'NOT_LOGGED_IN',
        labels,
      );
    }
  }

  let lastMsg = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [ok, msg] = await client.pageGoTo(0, {
      url: homeUrl,
      timeoutMs: 45_000,
      wait: 'domcontentloaded',
    });
    lastMsg = msg || '';
    await sleep(1_200);

    const [urlOk, , pageUrlRaw] = await client.getPageUrl();
    const pageUrl = pageUrlRaw ?? '';
    const state = urlOk ? classifyThreadsUrl(pageUrl) : 'other';
    if (state === 'login') {
      return failStep(
        client,
        'check_login',
        'Browser is not logged in to Threads. Please log in on this fingerprint profile first.',
        'NOT_LOGGED_IN',
        labels,
      );
    }
    if (ok || state === 'on_threads') {
      if (!ok) {
        client.taskLog(
          `pageGoTo attempt ${attempt} reported fail but already on Threads (${pageUrl}); continue`,
        );
      }
      await sleep(800);
      return null;
    }
    client.taskLog(`pageGoTo attempt ${attempt} failed: ${lastMsg || 'unknown'}`);
    if (attempt < 2) await sleep(1_200);
  }

  return failStep(
    client,
    'open_home',
    lastMsg || 'pageGoTo failed after retry',
    'NAV_FAILED',
    labels,
  );
}

async function openComposer(client: XportBrowserClient): Promise<boolean> {
  // 先试侧栏可见文案按钮，再试 FAB Create
  let clicked = false;
  const textBtn = await waitForCount(client, openComposerByTextPath, (n) => n >= 1, 8_000);
  if (textBtn >= 1) {
    await sleep(500);
    const [ok] = await client.clickNode(0, openComposerByTextPath, -1, {
      preferClickableAncestor: true,
    });
    clicked = ok;
    client.taskLog(`open_composer: click New thread/新建串文 ok=${ok}`);
  }
  if (!clicked) {
    const fab = await waitForCount(client, openComposerFabPath, (n) => n >= 1, 8_000);
    if (fab < 1) return false;
    await sleep(500);
    const [ok] = await client.clickNode(0, openComposerFabPath, -1, {
      preferClickableAncestor: true,
    });
    clicked = ok;
    client.taskLog(`open_composer: click Create FAB ok=${ok}`);
  }
  if (!clicked) return false;

  await sleep(1_000);
  // 浮层打开后视口内 lexical ≥2（Feed + 作曲器）
  const boxes = await waitForCount(client, viewportLexicalManyPath, (n) => n >= 2, 15_000);
  if (boxes < 2) {
    client.taskLog(`open_composer: viewport lexical still ${boxes}`);
    // 有些布局 Feed 无可编辑框，仅浮层 1 个也接受
    const one = await waitForCount(client, composerTextboxPath, (n) => n >= 1, 3_000);
    return one >= 1;
  }
  return true;
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const content = String(taskConfig.content ?? '').trim();
  const image = resourceMd5(taskConfig.image);
  const video = resourceMd5(taskConfig.video);
  const homeUrl = resolveHomeUrl();
  const mediaKind = video ? 'video' : image ? 'image' : 'none';
  const labels = {
    contentPreview: content.slice(0, 80),
    mediaKind,
    homeUrl,
  };

  client.taskLog(
    `home=${homeUrl} contentLen=${content.length} image=${image ? 'yes' : 'no'} video=${video ? 'yes' : 'no'}`,
  );

  if (!content && !image && !video) {
    return automationFailWithContext(
      'at least one of content / image / video is required in taskRunConfig',
      { code: 'UNKNOWN', step: 'validate_content' },
    );
  }
  if (image && video) {
    return automationFailWithContext('do not set image and video together on one post', {
      code: 'UNKNOWN',
      step: 'validate_media',
    });
  }

  try {
    const homeGate = await ensureThreadsHome(client, homeUrl, labels);
    if (homeGate) return homeGate;

    const opened = await openComposer(client);
    if (!opened) {
      return await failStep(
        client,
        'open_composer',
        'Compose entry not found or composer did not open (New thread / 新建串文 / Create).',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    if (content) {
      await sleep(500);
      // 先点击聚焦可见框，再粘贴（避免命中不可见残留节点）
      const [focusOk] = await client.clickNode(0, composerTextboxPath);
      if (!focusOk) {
        return await failStep(
          client,
          'focus_textbox',
          'Composer textbox in viewport not clickable',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      await sleep(400);
      const [typeOk, typeMsg] = await client.pasteText(0, composerTextboxPath, content);
      if (!typeOk) {
        return await failStep(
          client,
          'fill_content',
          typeMsg || 'failed to paste post content',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      await sleep(700);
    }

    if (image || video) {
      const fileCount = await waitForCount(client, composerFileInputPath, (n) => n >= 1, 10_000);
      if (fileCount < 1) {
        return await failStep(
          client,
          'find_file_input',
          'File input not found in composer viewport',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }

      const md5 = video || image;
      const [upOk, upMsg] = await client.uploadFile(0, composerFileInputPath, md5);
      if (!upOk) {
        return await failStep(
          client,
          video ? 'upload_video' : 'upload_image',
          upMsg || 'uploadFile failed',
          'UNKNOWN',
          labels,
        );
      }

      if (video) {
        const ready = await waitForCount(client, composerVideoPreviewPath, (n) => n >= 1, 90_000, 800);
        if (ready < 1) {
          return await failStep(
            client,
            'wait_video_preview',
            'Video preview did not appear in the composer',
            'ELEMENT_NOT_FOUND',
            labels,
          );
        }
      } else {
        const ready = await waitForCount(client, composerImagePreviewPath, (n) => n >= 1, 60_000, 600);
        if (ready < 1) {
          return await failStep(
            client,
            'wait_image_preview',
            'Image preview (blob) did not appear in the composer',
            'ELEMENT_NOT_FOUND',
            labels,
          );
        }
      }
      await sleep(800);
    }

    const postBtnCount = await waitForCount(client, composerPostButtonPath, (n) => n >= 1, 20_000);
    if (postBtnCount < 1) {
      return await failStep(
        client,
        'find_post_button',
        'Post / 发布 button not found in composer viewport',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    await sleep(500);
    const contentProbe = content.slice(0, 24);
    const publishTimeoutMs = video ? 180_000 : 90_000;
    const publishDeadline = Date.now() + publishTimeoutMs;
    let published = false;
    let clicks = 0;
    while (Date.now() < publishDeadline && clicks < 6) {
      const ready = await waitForCount(client, composerPostButtonPath, (n) => n >= 1, 5_000, 400);
      if (ready >= 1) {
        const [postOk, postMsg] = await client.clickNode(0, composerPostButtonPath, -1, {
          preferClickableAncestor: true,
        });
        clicks += 1;
        if (!postOk) client.taskLog(`click Post #${clicks}: ${postMsg}`);
        else client.taskLog(`click Post #${clicks}: ok`);
      }
      await sleep(video ? 2_500 : 1_800);

      // 成功判定（语言无关）：文案框读不到 / 不再含本帖摘要，或视口 lexical ≤1
      const [, , boxCount] = await client.getNodeCount(0, viewportLexicalManyPath);
      if ((boxCount ?? 0) <= 1 && !contentProbe) {
        published = true;
        break;
      }
      if (contentProbe) {
        const [tOk, , tData] = await client.getNodeData(0, composerTextboxPath, ['text']);
        const texts = tOk && tData && Array.isArray(tData.text) ? tData.text : [];
        const joined = texts.join('\n');
        // 浮层关闭后 getNodeData 可能失败，或 Feed 框不含本帖摘要 → 均视为已发布
        if (!tOk || !joined.includes(contentProbe)) {
          published = true;
          break;
        }
      }
    }

    if (!published) {
      return await failStep(
        client,
        'publish_post',
        'Composer did not close after clicking Post. Publishing may still be in progress or blocked.',
        'UNKNOWN',
        labels,
      );
    }

    await sleep(800);
    const [finalUrlOk, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: 'threads post published',
      data: {
        contentPreview: content.slice(0, 120) || (mediaKind === 'none' ? '' : `(${mediaKind} only)`),
        mediaKind,
        finalUrl: finalUrlOk ? finalUrl : homeUrl,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN', labels);
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
