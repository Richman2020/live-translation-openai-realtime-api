/** Geometry-only replay in the real authenticated controlled page. No call is started. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface LayoutPage {
  evaluate(expression: string): Promise<any>;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
];

export async function captureControlledCaptionLayout(page: LayoutPage, phase: 'before' | 'after', output: string) {
  await mkdir(output, { recursive: true });
  const pageEngine = await page.evaluate(`document.getElementById('translation-engine').value`);
  const currentCloudMode = phase === 'after' && pageEngine === 'continuous-captions' && process.env.CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS === 'false';
  const evidenceLabel = currentCloudMode ? 'current-cloud-mode' : phase;
  const reportPath = join(output, `caption-layout-${evidenceLabel}.json`);
  if (phase === 'before' && existsSync(reportPath)) throw new Error('The original caption layout evidence already exists.');
  const baseline = phase === 'after' ? JSON.parse(await readFile(join(output, 'caption-layout-before.json'), 'utf8')) : null;
  await page.evaluate(`(async () => {
    const { renderConversationUtterance } = await import('/conversation-view.js');
    const rows = [];
    const chinese = '请确认这周四下午三点的预约。我们需要提前准备哪些资料？如果时间有变化，请在通话中告诉我，我会重新核对日期和地址。';
    const english = 'Please confirm the appointment for Thursday at three. Which documents should we prepare? If the time changes, tell me so I can check the date and address again.';
    const currentCloudMode = ${JSON.stringify(currentCloudMode)};
    for (let index = 0; index < 24; index++) {
      const local = index % 2 === 0;
      if (currentCloudMode && local) {
        rows.push(renderConversationUtterance({
          id: 'layout-native-' + index, sessionId: 'offline-layout', role: 'local',
          at: 1791840000000 + index * 6000, pairing: 'unpaired', boundary: 'diagnostic',
          captionSource: 'native_output', audioCorrespondence: 'generated_only',
          original: null, translation: { text: 'I need to confirm the appointment for Thursday at three. Please let me know which documents I should bring.', final: false },
          playback: { status: 'unconfirmed' },
        }));
        continue;
      }
      rows.push(renderConversationUtterance({
        id: 'layout-' + index, sessionId: 'offline-layout', role: local ? 'local' : 'remote',
        at: 1791840000000 + index * 6000, pairing: 'explicit', boundary: 'utterance',
        original: { text: local ? chinese : english, final: true },
        translation: { text: local ? english : chinese, final: index !== 1 },
        playback: { status: currentCloudMode ? 'unknown' : 'unconfirmed' },
      }));
    }
    document.getElementById('empty-conversation').hidden = true;
    document.getElementById('transcript').replaceChildren(...rows);
    document.getElementById('call-hint').textContent = '离线布局样例 · 未拨号';
  })()`);
  const measurements = [];
  const stateChecks = [];
  for (const viewport of viewports) {
    await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`window.scrollTo(0, 0); document.getElementById('transcript-scroll').scrollTop = 0; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const measure = () => page.evaluate(`(() => {
      const scroll = document.getElementById('transcript-scroll');
      const rect = scroll.getBoundingClientRect();
      const style = getComputedStyle(scroll);
      const left = Math.max(0, rect.left + parseFloat(style.paddingLeft));
      const top = Math.max(0, rect.top + parseFloat(style.paddingTop));
      const right = Math.min(innerWidth, rect.left + scroll.clientWidth - parseFloat(style.paddingRight));
      const bottom = Math.min(innerHeight, rect.top + scroll.clientHeight - parseFloat(style.paddingBottom));
      const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
      const end = document.getElementById('end-call');
      const endRect = end.getBoundingClientRect();
      const hit = document.elementFromPoint(endRect.left + endRect.width / 2, endRect.top + endRect.height / 2);
      const primary = [...document.querySelectorAll('.mine .conversation-original .transcript-text, .their .conversation-translation .transcript-text')];
      const auxiliary = [...document.querySelectorAll('.mine .conversation-translation .transcript-text, .their .conversation-original .transcript-text')];
      let visibleChineseCharacters = 0;
      for (const part of primary) {
        const text = part.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        for (let index = 0; index < text.length; index++) {
          range.setStart(text, index); range.setEnd(text, index + 1);
          const character = range.getBoundingClientRect();
          if (character.left >= left && character.right <= right && character.top >= top && character.bottom <= bottom) visibleChineseCharacters++;
        }
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        content: { width, height, area: width * height, top, bottom },
        chineseFontPx: parseFloat(getComputedStyle(primary[0]).fontSize),
        englishFontPx: parseFloat(getComputedStyle(auxiliary[0]).fontSize),
        visibleChineseCharacters,
        endCall: { width: endRect.width, height: endRect.height, top: endRect.top, bottom: endRect.bottom,
          fullyVisible: endRect.left >= 0 && endRect.right <= innerWidth && endRect.top >= 0 && endRect.bottom <= innerHeight,
          unobstructed: Boolean(hit && (hit === end || end.contains(hit))) },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        zoom: getComputedStyle(document.documentElement).zoom,
        scrollNode: scroll.id,
        dialCardBottom: document.querySelector('.dial-card').getBoundingClientRect().bottom,
        connectionCardTop: document.querySelector('.connection-card').getBoundingClientRect().top,
      };
    })()`);
    const measurement = await measure();
    measurements.push({ name: viewport.name, ...measurement });
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(output, `caption-${evidenceLabel}-${viewport.name}.png`), Buffer.from(screenshot.data, 'base64'));
    if (phase === 'after') {
      await page.evaluate(`document.getElementById('conversation-latest').hidden = false; document.getElementById('conversation-history-status').hidden = false;`);
      const history = await measure();
      await page.evaluate(`document.querySelector('.audio-delivery').open = true;`);
      const expanded = await measure();
      await page.evaluate(`document.getElementById('end-call').disabled = false; document.getElementById('app-error').hidden = false; document.getElementById('app-error').textContent = '离线布局检查：清理状态说明'; window.scrollTo(0, document.documentElement.scrollHeight);`);
      const scrolled = await measure();
      assert.equal(scrolled.endCall.fullyVisible, true, `${viewport.name}: enabled end call stays visible after page scroll`);
      assert.equal(scrolled.endCall.unobstructed, true, `${viewport.name}: enabled end call remains clickable after page scroll`);
      assert.ok(expanded.dialCardBottom <= expanded.connectionCardTop, `${viewport.name}: dial card does not overlap connection status`);
      const stateCheck = { name: viewport.name, historyContentHeight: history.content.height, historyContentArea: history.content.area,
        expandedContentHeight: expanded.content.height, dialStatusDoNotOverlap: true,
        enabledEndCallAfterPageScroll: scrolled.endCall, enabledButtonIsGeometryOnly: true, unmarkedGeometryMatchesOriginal: false };
      stateChecks.push(stateCheck);
      await page.evaluate(`document.getElementById('end-call').disabled = true; document.getElementById('app-error').hidden = true; document.getElementById('app-error').textContent = ''; document.querySelector('.audio-delivery').open = false; document.getElementById('conversation-latest').hidden = true; document.getElementById('conversation-history-status').hidden = true; window.scrollTo(0, 0);`);
      await page.evaluate(`delete document.documentElement.dataset.phoneSurface; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const unmarked = await measure();
      await page.evaluate(`document.documentElement.dataset.phoneSurface = 'controlled';`);
      const previous = baseline.measurements.find((item: any) => item.name === viewport.name);
      if (!currentCloudMode) {
        assert.equal(unmarked.content.height, previous.content.height, `${viewport.name}: unmarked page retains original visible height`);
        assert.equal(unmarked.content.width, previous.content.width, `${viewport.name}: unmarked page retains original visible width`);
        stateCheck.unmarkedGeometryMatchesOriginal = true;
      }
    }
  }
  const report: Record<string, unknown> = { phase, pageEngine, currentCloudMode, measurements, realSupplierCalls: 0, sdkCalls: 0 };
  if (phase === 'after') {
    const comparisons = measurements.map(current => {
      const previous = baseline.measurements.find((item: any) => item.name === current.name);
      return { name: current.name,
        heightRatio: previous.content.height ? current.content.height / previous.content.height : null,
        areaRatio: previous.content.area ? current.content.area / previous.content.area : null,
        visibleChineseCharactersBefore: previous.visibleChineseCharacters,
        visibleChineseCharactersAfter: current.visibleChineseCharacters,
      };
    });
    for (const item of comparisons.filter(item => !currentCloudMode && item.name !== 'mobile')) {
      assert.ok(item.heightRatio !== null && item.heightRatio >= 2, `${item.name}: visible caption height must at least double`);
      assert.ok(item.areaRatio !== null && item.areaRatio >= 2, `${item.name}: visible caption area must at least double`);
      const history = stateChecks.find(state => state.name === item.name);
      assert.ok(history);
      const previous = baseline.measurements.find((measurement: any) => measurement.name === item.name);
      assert.ok(history.historyContentHeight >= previous.content.height * 2, `${item.name}: reading history retains double the original visible height`);
    }
    for (const item of measurements) {
      assert.equal(item.endCall.fullyVisible, true, `${item.name}: end call remains visible`);
      assert.equal(item.endCall.unobstructed, true, `${item.name}: end call remains unobstructed`);
      assert.ok(item.endCall.height >= 44, `${item.name}: end call has a 44px target`);
      assert.equal(item.horizontalOverflow, false, `${item.name}: no horizontal page overflow`);
      assert.ok(item.chineseFontPx > item.englishFontPx, `${item.name}: Chinese is primary`);
    }
    if (!currentCloudMode) report.comparisons = comparisons;
    else report.comparisonScope = 'Current cloud mode with native unpaired English and paired remote Chinese. Different fixture; the protected before/after area comparison remains separate.';
    report.stateChecks = stateChecks;
    report.passed = true;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
