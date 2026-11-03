import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      values[name] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      values[name] = argv[++index];
    } else {
      values[name] = true;
    }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const url = String(args.url ?? 'http://127.0.0.1:5173/');
const output = path.resolve(projectRoot, String(args.out ?? 'review/current-paint.png'));
const pageWidth = Number(args.width ?? 1700);
const pageHeight = Number(args.height ?? 1200);
const port = Number(args.port ?? 9333 + Math.floor(Math.random() * 300));
const profile = await mkdtemp(path.join(tmpdir(), 'impasto-capture-'));
const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${pageWidth},${pageHeight}`,
  '--force-device-scale-factor=1',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  url,
];

const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
let chromeExited = false;
chrome.once('exit', () => { chromeExited = true; });

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (chromeExited) throw new Error(`Chrome exited while waiting for ${label}`);
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
      // The debugging endpoint and page execution context can briefly disappear.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

let socket;
const browserLogs = [];
try {
  let targets;
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await response.json();
    return targets.some((target) => target.type === 'page' && target.url.includes('127.0.0.1'));
  }, 15_000, 'Chrome debugging target');

  const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.includes('127.0.0.1'));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      browserLogs.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      browserLogs.push(message.params.args.map((argument) => argument.value ?? argument.description).join(' '));
    }
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: pageWidth,
    height: pageHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.bringToFront');

  await waitFor(
    () => evaluate(`(() => {
      const label = document.querySelector('#gpu-label')?.textContent;
      if (label === 'GPU unavailable' || label === 'Preview error') {
        throw new Error(document.querySelector('#canvas-message')?.innerText ?? label);
      }
      return label === 'WebGPU ready';
    })()`),
    25_000,
    'WebGPU renderer',
  );

  const scene = args.scene ? String(args.scene) : null;
  const view = args.view ? String(args.view) : null;
  const numericSettings = {
    lightAzimuth: args.azimuth,
    lightElevation: args.elevation,
    relief: args.relief,
    roughness: args.roughness,
    exposure: args.exposure,
  };
  const settings = Object.fromEntries(Object.entries(numericSettings)
    .filter(([, value]) => value !== undefined && value !== true)
    .map(([key, value]) => [key, Number(value)]));
  if (view) settings.view = view;

  if (scene) {
    const expectedCaption = scene === 'composition' ? 'COMPOSITION'
      : scene === 'diagnostics' ? 'DIAGNOSTICS'
        : scene === 'materials' ? 'PAINT STUDIES'
          : scene === 'benchmark' ? 'REFERENCE CROP' : 'CLOSE-UP';
    await evaluate(`(() => {
      const button = document.querySelector('[data-scene="${scene}"]');
      if (!button) throw new Error('Unknown scene: ${scene}');
      if (!button.classList.contains('selected')) button.click();
    })()`);
    await waitFor(
      () => evaluate(`document.querySelector('#scene-caption')?.textContent.includes('${expectedCaption}')`),
      15_000,
      `scene ${scene}`,
    );
    await waitFor(
      () => evaluate(`document.querySelector('#gpu-label')?.textContent === 'WebGPU ready'`),
      25_000,
      'WebGPU renderer after scene switch',
    );
  }
  if (Object.keys(settings).length) {
    await evaluate(`window.__impasto.setSettings(${JSON.stringify(settings)})`);
  }
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise((resolve) => setTimeout(resolve, Number(args.settle ?? 350)));

  if (args.eval) {
    const value = await evaluate(String(args.eval));
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  if (args.noScreenshot) process.exitCode = 0;

  if (!args.noScreenshot) {
  const clip = await evaluate(`(() => {
    const element = ${args.full ? 'document.documentElement' : "document.querySelector('#paint-canvas')"};
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
      height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
    };
  })()`);
  if (!clip || clip.width < 1 || clip.height < 1) throw new Error('Capture clip is empty');

  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { ...clip, scale: 1 },
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(screenshot.data, 'base64'));
  console.log(`${output} ${Math.round(clip.width)}x${Math.round(clip.height)}`);
  }
} finally {
  if (browserLogs.length) console.error(browserLogs.join('\n'));
  try {
    socket?.close();
  } catch {}
  chrome.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
