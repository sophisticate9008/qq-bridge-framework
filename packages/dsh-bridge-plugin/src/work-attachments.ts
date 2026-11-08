import { readOnlyFlags } from './file-security.js';
import type { WorkPathDescriptor } from './work-path.js';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { validWorkOutput, type WorkMediaReference } from './work-output.js';

function imageType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  const bytes = Buffer.from(data);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Installed only on a child reserved by the authenticated work channel. No protocol send capability. */
export function installWorkAttachmentTool(agent: Agent, options: {
  readonly pathRegistration?: {
    readonly enabled: () => boolean;
    readonly register: (path: string, signal: AbortSignal) => Promise<{ id: string; descriptor: WorkPathDescriptor }>;
  };
  readonly assertLease: () => void;
  readonly commit: (asset: WorkMediaReference) => void | Promise<void>;
}): () => void {
  return agent.ctx.tools.register(defineTool({
    name: 'qbf_work_attach',
    description: '登记本次工作的现有文件，宿主自动绑定当前工作与原聊天会话。模型只需提供path。可选filename与旧kind仍接受，省略时使用原文件名并自动识别，省略按文件头识别。产物放在workspace/或DSH会话目录，送达前保留且勿修改。登记返回资源编号，工作完成后由原QQ会话投递，registered不代表送达。',
    // The model needs one argument. The open root also accepts validated filename and legacy kind.
    parameters: {
      path: { type: 'string', required: true, description: '当前工作生成或选定的现有普通文件路径。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      options.assertLease();
      const optional = (value: unknown) => value === null || value === '' ? undefined : value;
      const candidate: Readonly<Record<string, unknown>> = args;
      const filename = optional(candidate.filename);
      const kind = optional(candidate.kind);
      if (Object.keys(candidate).some(key => !['path', 'filename', 'kind'].includes(key)) || exec.agent !== agent || exec.signal.aborted || typeof args.path !== 'string' || args.path.length < 1
        || args.path.length > 4096 || /[\x00-\x1f\x7f]/.test(args.path)
        || filename !== undefined && (typeof filename !== 'string' || !filename || filename.length > 160 || /[/\\\p{Cc}]/u.test(filename))
        || kind !== undefined && kind !== 'image' && kind !== 'file') throw new TypeError('Invalid work attachment request');
      const fs = agent.ctx.get('fs');
      const workingDirectory = agent.ctx.get('workingDirectory');
      if (!fs || !workingDirectory) throw new TypeError('Work filesystem or attachment storage is unavailable');
      const cwd = await workingDirectory.ensure(agent, exec.signal);
      const entry = await fs.lstat(args.path, { cwd }, exec.signal);
      if (entry?.type !== 'file') throw new TypeError('文件已失效：需要现有普通文件');
      const target = await fs.resolve(args.path, { cwd, signal: exec.signal });
      if (!options.pathRegistration?.enabled()) throw new TypeError('WORK_PATH_REQUIRED: 请配套升级宿主与桥接插件');
      {
        const registered = await options.pathRegistration.register(fs.processPath(target), exec.signal);
        options.assertLease(); exec.signal.throwIfAborted();
        const name = (typeof filename === 'string' ? filename : basename(registered.descriptor.path)).replace(/[/\\\p{Cc}]/gu, '-').slice(0, 160);
        if (!name) throw new TypeError('Invalid work attachment name');
        let image: WorkMediaReference['mediaType'];
        if (kind !== 'file') {
          const handle = await open(registered.descriptor.path, readOnlyFlags);
          try { const header = Buffer.alloc(16); await handle.read(header, 0, header.length, 0); image = imageType(header) ?? undefined; }
          finally { await handle.close(); }
        }
        if (kind === 'image' && !image) throw new TypeError('Work image must be PNG, JPEG, WebP or GIF');
        const asset: WorkMediaReference = image
          ? { type: 'media-reference', storage: 'path', kind: 'image', attachmentId: registered.id, bytes: registered.descriptor.bytes,
            name, mediaType: image }
          : { type: 'media-reference', storage: 'path', kind: 'file', attachmentId: registered.id, bytes: registered.descriptor.bytes, name };
        if (!validWorkOutput(asset)) throw new TypeError('Invalid registered work path');
        options.assertLease(); exec.signal.throwIfAborted(); await options.commit(asset);
        return { registered: true, sent: false, storage: 'path', kind: asset.kind, resourceId: registered.id, name, bytes: asset.bytes, expiresAt: registered.descriptor.expiresAt };
      }
    },
  }));
}
