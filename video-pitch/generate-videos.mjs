import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

function run(command, args) {
  execFileSync(command, args, { stdio: "ignore" });
}

const videos = [
  {
    id: "tokenless-pitch-en",
    voice: "Flo",
    lang: "English",
    title: "Tokenless",
    subtitle: "Save agent tokens",
    lines: [
      "Have you ever wondered how many agent responses are paid for with tokens, even though a normal web chat could answer them for free?",
      "Agents ask for second opinions, summaries, rewrites, explanations, review notes, and small checks.",
      "Not all of that needs your most expensive token path.",
      "That is the idea behind Tokenless: use tokens where they matter, and use the web version when the web version is enough.",
      "Tokenless routes suitable agent requests to the AI web apps you already use, like ChatGPT, Claude, or Gemini.",
      "The request goes to the visible web chat. The answer comes back to your agent.",
      "No copy and paste. No extra API key for that request. No leaving the agent just to ask a quick question somewhere else.",
      "The value is simple: save tokens. In some workflows, that could be 50% or more.",
      "Tokenless gives your agent a smarter route. Paid tokens for the work that deserves them. The web version for the work that does not.",
    ],
  },
  {
    id: "tokenless-pitch-zh",
    voice: "Tingting",
    lang: "Chinese",
    title: "Tokenless",
    subtitle: "帮 agent 省 token",
    lines: [
      "你有没有想过，agent 里有多少回答，其实不用花 token？它们明明可以交给免费的网页版 AI 来完成。",
      "每天，agent 都会做很多轻量任务。找第二意见，总结内容，改写文案，解释一段代码，写 code review 备注。",
      "这些事情，不一定都要走最贵的 token 路径。",
      "这就是 Tokenless 的核心价值：该用 token 的地方，用 token。网页版够用的时候，就用网页版。",
      "Tokenless 会把适合的 agent 请求，路由到你已经在浏览器里使用的 AI 网页，比如 ChatGPT、Claude、Gemini。",
      "请求发到可见的网页聊天里，回答再回到你的 agent。",
      "所以工作流不会断。不用手动复制粘贴，也不用为了这一次请求再准备 API key。",
      "它的价值很简单：省 token。在一些工作流里，甚至可能省下 50% 或更多。",
      "Tokenless 给 agent 多一条更聪明的路线。重要任务，用 token。普通任务，用网页版。",
    ],
  },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapWords(text, max) {
  const hasCjk = /[\u3400-\u9fff]/u.test(text);
  if (hasCjk) {
    const chunks = [];
    let line = "";
    const tokens = text.match(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*|[^\s]/gu) ?? [];
    for (const token of tokens) {
      if (!line && /[，。！？、；：,.!?]/u.test(token) && chunks.length) {
        chunks[chunks.length - 1] += token;
        continue;
      }

      const tokenStartsAscii = /[A-Za-z0-9]/u.test(token[0]);
      const lineEndsAscii = /[A-Za-z0-9]$/u.test(line);
      const separator = line && (tokenStartsAscii || lineEndsAscii) ? " " : "";
      const next = `${line}${separator}${token}`;
      if (line && next.length > max && !/[，。！？、；：,.!?]/u.test(token)) {
        chunks.push(line.trim());
        line = token;
      } else {
        line = next;
      }

      if (/[。！？]/u.test(token)) {
        chunks.push(line.trim());
        line = "";
      }
    }
    if (line.trim()) chunks.push(line.trim());
    return chunks.join("\n");
  }

  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/u)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function renderSlideHtml({ video, index, text }) {
  const headline = index === 0 ? video.subtitle : `${String(index + 1).padStart(2, "0")}`;
  const bodyLines = wrapWords(text, video.lang === "Chinese" ? 19 : 33).split("\n");
  const fontSize = video.lang === "Chinese" ? 66 : 62;
  const body = bodyLines.map((line) => `<div>${escapeXml(line)}</div>`).join("");
  const progressWidth = Math.round(1736 * ((index + 1) / video.lines.length));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      background: #101418;
      color: #f8f4ea;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    }
    .frame {
      position: absolute;
      inset: 86px 92px;
      border: 2px solid rgba(244, 239, 229, 0.18);
    }
    .progress {
      position: absolute;
      left: 92px;
      top: 86px;
      width: ${progressWidth}px;
      height: 8px;
      background: #ffc857;
    }
    .signal {
      position: absolute;
      right: 140px;
      top: 136px;
      width: 220px;
      height: 220px;
      border: 2px solid rgba(255, 200, 87, 0.35);
      transform: rotate(12deg);
    }
    .brand {
      position: absolute;
      left: 120px;
      top: 112px;
      font-size: 54px;
      line-height: 1;
      font-weight: 750;
      color: #ffc857;
    }
    .headline {
      position: absolute;
      left: 120px;
      top: 220px;
      font-size: 84px;
      line-height: 1;
      font-weight: 820;
      color: #f8f4ea;
    }
    .body {
      position: absolute;
      left: 120px;
      top: 388px;
      width: 1360px;
      font-size: ${fontSize}px;
      line-height: 1.3;
      font-weight: 680;
      letter-spacing: 0;
    }
    .caption {
      position: absolute;
      left: 120px;
      bottom: 126px;
      color: #9aa7ad;
      font-size: 34px;
      line-height: 1;
    }
  </style>
</head>
<body>
  <div class="frame"></div>
  <div class="progress"></div>
  <div class="signal"></div>
  <div class="brand">${escapeXml(video.title)}</div>
  <div class="headline">${escapeXml(headline)}</div>
  <div class="body">${body}</div>
  <div class="caption">${escapeXml(video.lang)} pitch video</div>
</body>
</html>`;
}

const browser = await chromium.launch();

try {
for (const video of videos) {
  const work = mkdtempSync(join(tmpdir(), `${video.id}-`));
  const narrationPath = join(work, "narration.txt");
  const audioPath = join(work, "narration.aiff");
  const concatPath = join(work, "concat.txt");
  const slidePaths = [];

  writeFileSync(
    narrationPath,
    `${video.title}. ${video.subtitle}.\n\n${video.lines.join("\n\n")}`,
  );
  run("say", ["-v", video.voice, "-o", audioPath, "-f", narrationPath]);

  const duration = Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]).toString().trim(),
  );

  const slideDuration = Math.max(5, duration / video.lines.length);

  for (let i = 0; i < video.lines.length; i += 1) {
    const htmlPath = join(work, `slide-${i}.html`);
    const pngPath = join(work, `slide-${i}.png`);
    const slidePath = join(work, `slide-${i}.mp4`);
    slidePaths.push(slidePath);
    const html = renderSlideHtml({ video, index: i, text: video.lines[i] });
    writeFileSync(htmlPath, html);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: pngPath, type: "png" });
    await page.close();

    run(
      "ffmpeg",
      [
        "-y",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        pngPath,
        "-t",
        String(slideDuration),
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        slidePath,
      ],
    );
  }

  writeFileSync(concatPath, slidePaths.map((path) => `file '${path}'`).join("\n"));
  const slidesPath = join(work, "slides.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", slidesPath]);

  run(
    "ffmpeg",
    [
      "-y",
      "-i",
      slidesPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      join(outDir, `${video.id}.mp4`),
    ],
  );
}

console.log(`Generated videos in ${outDir}`);
} finally {
  await browser.close();
}
