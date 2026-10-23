import { expect, test } from '@playwright/test';
import path from 'node:path';
for (const olderPage of [false,true]) test(`restores actual reading position after asynchronous reload; olderPage=${olderPage}`,async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const fixture = path.resolve('tests/fixtures/agent-chat-lifecycle.tsx');
 await page.route('**/agent-chat-lifecycle.html', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
 await page.goto('/agent-chat-lifecycle.html');
 const viewport=page.getByRole('region',{name:'Conversation messages'});
 await expect(page.getByText('Historical reply 599',{exact:true})).toBeInViewport();
 await page.getByRole('textbox',{name:'Message agent'}).fill('Retained QA draft');
 if(olderPage){await page.getByRole('button',{name:/^Earlier messages/}).click();await expect(page.getByText('Historical reply 399',{exact:true})).toBeAttached();}
 await viewport.hover();await page.mouse.wheel(0,-700);
 await expect.poll(()=>viewport.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeGreaterThan(400);
 const capture=()=>viewport.evaluate(e=>{const rect=e.getBoundingClientRect();const ps=[...e.querySelectorAll('p')];const anchor=ps.find(p=>p.getBoundingClientRect().top>=rect.top&&p.getBoundingClientRect().bottom<=rect.bottom);return {top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,anchor:anchor?.textContent,y:anchor?anchor.getBoundingClientRect().top-rect.top:null}});
 const before=await capture();expect(before.top).toBeGreaterThan(500);expect(before.anchor).toBeTruthy();
 await page.screenshot({path:testInfo.outputPath('before-detach.png')});
 await page.getByRole('button',{name:'Detach viewer',exact:true}).click();await expect(viewport).not.toBeAttached();
 const detached=await page.evaluate(()=>{const s=window.qaViewer.snapshot();return {top:window.qaViewer.scrollTop,transcriptReleased:!s.view?.transcript,windowEnd:s.windowEnd,draft:s.draft}});
 expect(detached.transcriptReleased).toBe(true);
 await page.getByRole('button',{name:'Restore viewer',exact:true}).click();await expect(viewport).toBeAttached();
 await expect.poll(()=>page.evaluate(()=>window.qaReadCount())).toBe(2);
 await expect(viewport.locator('p').filter({hasText:/Historical reply/})).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('reload-held.png')});
 await page.getByRole('button',{name:'Release transcript',exact:true}).click();
 await expect(page.getByText(olderPage?'Historical reply 399':'Historical reply 599',{exact:true})).toBeAttached();
 // Allow asynchronous runtime synchronization and browser scroll effects to settle.
 await page.waitForTimeout(500);
 const after=await capture();
 await testInfo.attach('actual-dom-state',{body:JSON.stringify({before,detached,after,errors},null,2),contentType:'application/json'});
 await page.screenshot({path:testInfo.outputPath('after-reload.png')});
 await expect(page.getByRole('textbox',{name:'Message agent'})).toHaveValue('Retained QA draft');
 expect(errors).toEqual([]);expect(after.anchor).toBe(before.anchor);expect(Math.abs(after.top-before.top)).toBeLessThanOrEqual(2);expect(Math.abs((after.y??0)-(before.y??0))).toBeLessThanOrEqual(2);
});


test('keeps resource and future content visible after transcript replay', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('tests/fixtures/agent-chat-lifecycle.tsx');
  await page.route('**/agent-chat-content.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto('/agent-chat-content.html?content');
  for (const replay of [false, true]) {
    if (replay) {
      await page.getByRole('button', { name: 'Detach viewer', exact: true }).click();
      await page.getByRole('button', { name: 'Restore viewer', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.qaReadCount())).toBe(2);
      await page.getByRole('button', { name: 'Release transcript', exact: true }).click();
    }
    for (const [label, value] of [['Resource: Report', 'file:///workspace/report.md'], ['Resource content', 'Embedded resource text'], ['Content: future-content', 'Future provider value']]) {
      const details = page.locator('details').filter({ has: page.locator('summary', { hasText: label }) });
      await expect(details.locator('summary')).toBeVisible();
      await details.locator('summary').click();
      await expect(details.locator('[aria-label="Content details"]')).toBeVisible();
      await expect(details.locator('[aria-label="Content details"]')).toContainText(value);
    }
    expect(await page.evaluate(() => window.qaViewer.snapshot().view?.transcript?.messages.map(message => message.id))).toEqual(['resource-link', 'embedded-resource', 'future-content']);
    await page.screenshot({ path: testInfo.outputPath(`content-replay-${replay}.png`) });
  }
  expect(errors).toEqual([]);
});
