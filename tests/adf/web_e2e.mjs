// Real Chrome via its documented DevTools pipe, with no package installation or network service.
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {promisify} from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), "adf-chrome-"));
const fixture = spawn("python3", ["tests/adf/web_fixture.py"], {
  env: {...process.env, PYTHONPATH: "."}, stdio: ["ignore", "pipe", "inherit"],
});
let chrome;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const input = createInterface({input: fixture.stdout});
  const [line] = await Promise.race([once(input, "line"), once(fixture, "exit").then(values => {
    throw Error(`Fixture exited (${values})`);
  })]);
  const {url, root, python} = JSON.parse(line);
  const cli = async (...args) => JSON.parse((await exec(python, ["-m", "adf", ...args], {cwd: root})).stdout);
  const location = new URL(url);
  const request = async headers => fetch(location.origin + "/api", {
    method: "POST", headers: {"Content-Type": "application/json", ...headers},
    body: JSON.stringify({action: "status", args: {}}),
  });
  const access = "Bearer " + new URLSearchParams(location.hash.slice(1)).get("access");
  assert.equal((await request({Origin: location.origin})).status, 403);
  assert.equal((await request({Origin: "http://localhost:9", Authorization: access})).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const call = httpRequest(location.origin + "/", {headers: {Host: "localhost:" + location.port}}, response => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on("error", reject).end();
  });
  assert.equal(badHost, 403);

  const executable = process.env.ADF_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  chrome = spawn(executable, ["--headless", "--remote-debugging-pipe", `--user-data-dir=${temp}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"],
  {stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]});
  let count = 0, buffer = "";
  const pending = new Map();
  chrome.stdio[4].setEncoding("utf8");
  chrome.stdio[4].on("data", chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\0")) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Error(message.error.message));
      else entry.resolve(message.result);
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++count;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Chrome did not respond to " + method));
      }, 8000);
      pending.set(id, {resolve, reject, timer});
      chrome.stdio[3].write(JSON.stringify({id, method, params, sessionId}) + "\0");
    });
  }
  const {targetId} = await cdp("Target.createTarget", {url: "about:blank"});
  const {sessionId} = await cdp("Target.attachToTarget", {targetId, flatten: true});
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (result.exceptionDetails) throw Error(result.result.description || "Chrome script failed");
    return result.result.value;
  };
  async function wait(expression) {
    for (let count = 0; count < 80; count++) {
      if (await evaluate(expression)) return;
      await delay(150);
    }
    throw Error("Browser expectation failed: " + expression + "\n" + await evaluate("document.body.innerText"));
  }
  const click = async selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = async (selector, value) => evaluate(
    `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const body = text => `document.body.innerText.includes(${JSON.stringify(text)})`;

  await cdp("Page.navigate", {url}, sessionId);
  await wait(body("監督に接続"));
  await fill("#message", "MARKDOWN_FIXTURE\nsecond line");
  await click("#prompt button");
  await wait("document.querySelector('.agent strong')?.textContent === 'fixture reply'");
  assert.equal(await evaluate("document.querySelector('.agent pre code').textContent"), "verified");
  assert.equal(await evaluate("document.querySelector('.agent img')"), null);
  assert.equal(await evaluate("document.querySelector('.human .markdown').textContent"), "MARKDOWN_FIXTURE\nsecond line");
  await click("#theme");
  assert.ok(await evaluate("document.documentElement.dataset.theme"));

  await click("#open-plan");
  await fill('#plan [name="scope"]', "Inspect evidence");
  await fill('#plan [name="issues"]', "8");
  await fill('#plan [name="tokens"]', "80000");
  await click("#plan button");
  await wait(body("GitHub 操作の承認待ち"));
  assert.equal((await cli("status")).sessions.find(row => row.role === "developer").turn_requests, 0);
  await click("#stop");
  await click('nav [data-page="issues"]');
  await wait(body("失効"));
  await click("#load-issues");
  await wait(body("Synthetic evidence"));
  await click("#issue-list button");
  await wait(body("<script>unsafe()</script>"));
  assert.equal(await evaluate("document.querySelector('#issue-detail script')"), null);

  await evaluate("document.querySelector('#issues details').open = true; window.confirm = () => true");
  await fill('#draft select[name="kind"]', "checklist");
  await evaluate("document.querySelector('#draft select').dispatchEvent(new Event('change'))");
  await fill('#draft [name="criterion"]', "Cross-check");
  await click("#draft button");
  await wait(body("承認して GitHub に送信"));
  await evaluate("[...document.querySelectorAll('#operations button')].find(b => b.textContent.includes('承認して')).click()");
  await wait(body("送信中・結果不明"));
  await evaluate("[...document.querySelectorAll('#operations button')].find(b => b.textContent === 'GitHub で照合').click()");
  await wait(body("確認済み"));

  await cli("template", "trial", '["/bin/sleep","3"]');
  await cli("send", "developer", "launch experiment", "--experiment", "trial");
  let waiting;
  for (let count = 0; count < 30; count++) {
    const value = await cli("status");
    const developer = value.sessions.find(row => row.role === "developer");
    if (developer.state === "waiting") {
      waiting = developer;
      break;
    }
  }
  assert.ok(waiting, "Developer entered experiment waiting with no browser ownership");

  const before = (await cli("status")).sessions.find(row => row.role === "coordinator");
  await cdp("Page.navigate", {url: "about:blank"}, sessionId);
  await cli("send", "coordinator", "While browser closed");
  await delay(3500);
  const progress = await cli("status");
  const finished = progress.sessions.find(row => row.role === "developer");
  const [job] = progress.jobs;
  assert.deepEqual([finished.thread, finished.turn_requests], [waiting.thread, waiting.turn_requests + 1]);
  assert.deepEqual([job.state, job.wake, job.waiting_requests, job.waiting_tokens],
    ["succeeded", "sent", job.initial_requests, job.initial_tokens]);
  await cdp("Page.navigate", {url}, sessionId);
  await wait(body("While browser closed"));
  const after = (await cli("skill", "coordinator")).state.sessions.find(row => row.role === "coordinator");
  assert.deepEqual([after.thread, after.turn_requests], [before.thread, before.turn_requests + 1]);
  await click('nav [data-page="experiments"]');
  await wait(body("trial · succeeded"));
  await evaluate("[...document.querySelectorAll('#jobs button')].find(b => b.textContent === 'ログ').click()");
  await wait(body("EXPERIMENT_COMPLETED"));
  await cli("stop", "--immediate");
  console.log("Chrome E2E: operator authentication, Markdown, role approval/stop, GitHub recovery, reconnect passed");
} finally {
  if (chrome) {
    chrome.kill();
    await once(chrome, "exit").catch(() => {});
  }
  if (fixture.exitCode === null) {
    fixture.kill();
    await once(fixture, "exit").catch(() => {});
  }
  await rm(temp, {force: true, recursive: true});
}
