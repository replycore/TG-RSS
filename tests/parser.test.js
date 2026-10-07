import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseChannelPage, parseSingleMessage, __internals } from "../src/tg/parser.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) => readFile(path.join(dir, "fixtures", name), "utf8");

test("解析公开频道预览页：消息、分页、频道信息", async () => {
  const html = await load("channel-page.html");
  const { posts, nextBefore, channel } = parseChannelPage(html);

  assert.ok(posts.length >= 15, `expected >=15 posts, got ${posts.length}`);
  assert.equal(typeof nextBefore, "number");
  assert.ok(nextBefore > 0, "nextBefore 应为 data-before 游标");

  assert.equal(channel.title, "Telegram News");
  assert.equal(channel.username, "telegram");
  assert.ok(channel.avatar && channel.avatar.startsWith("https://cdn"), "应解析出头像");
  assert.ok(channel.description.length > 10);
  assert.ok(channel.counters.subscribers, "应解析订阅数");
});

test("消息字段完整：id / 日期 / 文本 / 浏览数 / 链接", async () => {
  const html = await load("channel-page.html");
  const { posts } = parseChannelPage(html);
  const post = posts.find((p) => p.media.length > 0);

  assert.match(post.id, /^telegram\/\d+$/);
  assert.match(post.url, /^https:\/\/t\.me\/telegram\/\d+$/);
  assert.ok(!Number.isNaN(Date.parse(post.date)), "date 应为可解析时间");
  assert.ok(post.views, "应有浏览数");
  assert.ok(post.textHtml !== undefined && post.textPlain !== undefined);
  assert.equal(post.channelId, "-1005640892", "data-view.c 应解析出频道数字 ID");
});

test("媒体分类：视频与图片可识别，直链可用", async () => {
  const html = await load("channel-page.html");
  const { posts } = parseChannelPage(html);
  const videos = posts.flatMap((p) => p.media.filter((m) => m.type === "video"));
  const images = posts.flatMap((p) => p.media.filter((m) => m.type === "image"));

  assert.ok(videos.length >= 3, `videos=${videos.length}`);
  assert.ok(images.length >= 1, `images=${images.length}`);
  for (const m of [...videos, ...images]) {
    assert.ok(m.url, "媒体必须有直链");
    assert.match(m.url, /^https:\/\//);
  }
  const withDuration = videos.find((m) => m.duration);
  assert.ok(withDuration, "视频应解析出时长");
});

test("相册（grouped）多图不丢、不产生空媒体项", async () => {
  const html = await load("channel-album.html");
  const { posts } = parseChannelPage(html);
  const media = posts.flatMap((p) => p.media);
  assert.ok(media.filter((m) => m.type === "image").length >= 10, "相册应解析出多张图片");
  assert.equal(media.filter((m) => !m.url && !m.name).length, 0, "不允许出现空媒体项");
  assert.equal(posts.length, new Set(posts.map((p) => p.key)).size, "消息 key 不应重复");
});

test("文本 HTML 被清洗：script/style/事件属性被移除", async () => {
  const fixture = `
    <div class="tgme_widget_message js-widget_message" data-post="demo/1" data-view="eyJjIjoxfQ">
      <time datetime="2024-05-01T10:00:00+00:00"></time>
      <div class="tgme_widget_message_text js-message_text">
        <b>hi</b><script>alert(1)</script>
        <a href="javascript:alert(1)">bad</a>
        <a href="https://example.com" onclick="evil()">good</a>
        <div onclick="x()">nested <span class="tgspoiler">spoiler</span></div>
        <blockquote>quote<br>line2</blockquote>
      </div>
    </div>`;
  const { posts } = parseChannelPage(fixture);
  assert.equal(posts.length, 1);
  const html = posts[0].textHtml;
  assert.ok(!/<script/i.test(html), "script 必须被移除");
  assert.ok(!/onclick/i.test(html), "事件属性必须被移除");
  assert.ok(!/javascript:/i.test(html), "javascript: 链接必须被移除");
  assert.match(html, /<b>hi<\/b>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /spoiler/);
  assert.match(html, /quote<br>/);
  assert.equal(posts[0].date, "2024-05-01T10:00:00.000Z");
});

test("文档（文件）分类：按扩展名归入 file/audio/video", () => {
  const fixture = `
    <div class="tgme_widget_message js-widget_message" data-post="demo/9" data-view="eyJjIjoxfQ">
      <div class="tgme_widget_message_text js-message_text">files</div>
      <a class="tgme_widget_message_document" href="https://t.me/demo/9">
        <div class="tgme_widget_message_document_icon"></div>
        <div class="tgme_widget_message_document_info">
          <div class="tgme_widget_message_document_title">report.pdf</div>
          <div class="tgme_widget_message_document_extra">1.2 MB · 5 Jan 2024</div>
        </div>
      </a>
      <a class="tgme_widget_message_document" href="https://t.me/demo/9">
        <div class="tgme_widget_message_document_info">
          <div class="tgme_widget_message_document_title">song.mp3</div>
          <div class="tgme_widget_message_document_extra">4.5 MB</div>
        </div>
      </a>
      <audio class="tgme_widget_message_voice" src="https://cdn1.telesco.pe/file/voice.ogg64?token=x">
        <time class="tgme_widget_message_voice_duration">0:12</time>
      </audio>
    </div>`;
  const { posts } = parseChannelPage(fixture);
  const media = posts[0].media;
  const file = media.find((m) => m.name === "report.pdf");
  const audioFile = media.find((m) => m.name === "song.mp3");
  const voice = media.find((m) => m.type === "audio");

  assert.equal(file.type, "file");
  assert.equal(file.size, "1.2 MB · 5 Jan 2024");
  assert.equal(audioFile.type, "audio");
  assert.equal(voice.url, "https://cdn1.telesco.pe/file/voice.ogg64?token=x");
  assert.equal(voice.duration, "0:12");
  assert.ok(file.permalink || file.url, "文件需给出链接（预览页无直链时回退消息链接）");
});

test("单条 embed 页可解析", async () => {
  const html = await load("channel-page.html");
  const post = parseSingleMessage(html);
  assert.ok(post, "应解析出消息");
  assert.match(post.id, /^telegram\/\d+$/);
});

test("畸形输入不抛异常", () => {
  assert.deepEqual(parseChannelPage("").posts, []);
  assert.deepEqual(parseChannelPage(null).posts, []);
  assert.deepEqual(parseChannelPage("<html><body>no messages</body></html>").posts, []);
  assert.equal(parseSingleMessage("<div>nothing</div>"), null);
});

test("游标解析：data-before", async () => {
  const html = await load("channel-page.html");
  const { nextBefore } = parseChannelPage(html);
  const page2 = `<a href="/s/telegram?before=${nextBefore}" class="tme_messages_more js-messages_more" data-before="${nextBefore}"></a>`;
  assert.equal(__internals ? parseChannelPage(page2).nextBefore : null, nextBefore);
});
