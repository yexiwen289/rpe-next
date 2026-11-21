// User-configurable OpenAI-compatible provider.
//
// The built-in DeepSeek relay stays the default. A second, fully editable
// provider is offered as a fallback; SenseNova is pre-filled as a ready preset.
// Settings live in localPreferences, so each user can write and save their own
// baseUrl / model / key without touching the source tree.

export const CUSTOM_PROVIDER_ID = 'custom';
export const CUSTOM_SETTINGS_KEY = 'vibephi-agent-custom-v1';

export const DEFAULT_SENSENOVA_BASE_URL = 'https://token.sensenova.cn/v1';
export const DEFAULT_SENSENOVA_MODEL = 'sensenova-6.8-flash-lite';
import { runtimeEnv } from '../platform/runtime-env.mjs';

// 密钥来自本地 .env（RPE_SENSENOVA_API_KEY），源码中不留明文。
export const DEFAULT_SENSENOVA_API_KEY = runtimeEnv('RPE_SENSENOVA_API_KEY');

export const AGENT_CUSTOM_PRESETS = Object.freeze([
  {
    id: 'sensenova',
    name: 'SenseNova 6.8 Flash Lite',
    nameKey: 'agent-custom.preset.sensenova',
    baseUrl: DEFAULT_SENSENOVA_BASE_URL,
    model: DEFAULT_SENSENOVA_MODEL,
    key: DEFAULT_SENSENOVA_API_KEY,
    contextWindow: 1048576,
    sendThinking: false,
  },
  {
    id: 'blank',
    name: '自定义（空白）',
    nameKey: 'agent-custom.preset.blank',
    baseUrl: '',
    model: '',
    key: '',
    contextWindow: 1048576,
    sendThinking: false,
  },
]);

const cleanText = (value, fallback, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fallback;

export function agentCustomConfig(saved = {}) {
  const windowValue = Number(saved.contextWindow);
  const enabled = saved.enabled === true;
  return {
    name: cleanText(saved.name, '自定义 OpenAI 兼容', 120),
    baseUrl: cleanText(saved.baseUrl, '', 300).replace(/\/+$/, ''),
    model: cleanText(saved.model, '', 120),
    key: typeof saved.key === 'string' ? saved.key.trim().slice(0, 512) : '',
    contextWindow: Number.isSafeInteger(windowValue) && windowValue >= 8192 && windowValue <= 16777216 ? windowValue : 1048576,
    // Only GLM-style relays understand the `thinking` field; sending it to a
    // generic endpoint makes SenseNova return HTTP 400 "invalid arguments".
    sendThinking: saved.sendThinking === true,
    enabled: enabled && Boolean(cleanText(saved.baseUrl, '', 300)) && Boolean(cleanText(saved.model, '', 120)),
  };
}
