import { AgentSourceIndex } from '../core/agent-source.mjs';
import { checkAgentSignal } from '../core/agent-commands.mjs';
import { assetUrl } from '../core/asset-url.mjs';
import { t } from '../i18n.mjs';

export class AgentSourceReader {
  constructor(request = (url, options) => fetch(url, options)) { this.request = request; }
  async load(signal) {
    checkAgentSignal(signal);
    if (!this.index) {
      const response = await this.request(assetUrl('agent-source.json'), { signal });
      if (!response.ok) throw Error(t('agent-source.sbbc12e1'));
      const bundle = await response.json(); checkAgentSignal(signal); this.index = new AgentSourceIndex(bundle);
    }
    return this.index;
  }
  async query(args, signal) {
    checkAgentSignal(signal);
    const index = await this.load(signal);
    return index.query(args, signal);
  }
  /** 读取单个源文件的完整文本（供知识库解析等场景使用）。 */
  async readText(path, signal) {
    checkAgentSignal(signal);
    const index = await this.load(signal);
    return index.readText(path);
  }
}
