const { installAgentNetwork } = require('../desktop/agent-network.cjs');

const calls = [];
const handlers = new Map();
const ipcMain = {
  on: (channel, fn) => handlers.set(channel, fn),
  handle: (channel, fn) => handlers.set(channel, fn),
};
const net = {
  fetch: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response('{"data":[{"id":"deepseek-v4.1-flash-1017","context_window":131072}]}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
};
const fakeWindow = { webContents: { id: 1 } };
const frame = { url: 'rpe://app/' };
fakeWindow.webContents.mainFrame = frame;
const event = { sender: fakeWindow.webContents, senderFrame: frame };

installAgentNetwork({ ipcMain, net, origin: 'rpe://app', window: () => fakeWindow });

(async () => {
  const request = handlers.get('rpen-agent-request');
  const glm = await request(event, { id: 'a1', path: '/models', key: 'sk-test', body: {}, baseUrl: 'https://xh.v1api.cc/v1' });
  console.log('GLM /models  ->', calls[0].url, '| ok=', glm.ok, '| result=', JSON.stringify(glm.result));

  const chat = await request(event, { id: 'a2', path: '/chat/completions', key: 'sk-test', body: { model: 'deepseek-v4.1-flash-1017', messages: [] }, baseUrl: 'https://xh.v1api.cc/v1' });
  console.log('GLM /chat    ->', calls[1].url, '| ok=', chat.ok);

  const ds = await request(event, { id: 'a3', path: '/models', key: 'sk-test', body: {}, baseUrl: undefined });
  console.log('DeepSeek 默认 ->', calls[2].url, '| ok=', ds.ok);

  const bad = await request(event, { id: 'a4', path: '/models', key: 'sk-test', body: {}, baseUrl: 'http://evil.example.com' });
  console.log('非 https 拒绝 ->', bad.ok, '|', bad.message);
})();
