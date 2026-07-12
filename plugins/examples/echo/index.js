// 示例插件 —— 复制本目录改造即可。SDK v1 只支持 tools[],engine 留待后续。
// Tool 接口签名见 src/main/tools.ts:Tool { name; description; parameters; readOnly?; run(args, ctx) }。
// ctx.cwd = 当前会话工作目录;ctx.confirm(cmd) 让用户确认 shell 命令(本示例用不到)。
module.exports = {
  tools: [
    {
      name: 'echo_args',
      description: '示例工具:把传入的 JSON 参数原样返回(用于验证插件 SDK 是否工作)。',
      parameters: {
        type: 'object',
        properties: {
          payload: { type: 'string', description: '任意字符串,会被原样回显' },
        },
        required: ['payload'],
      },
      readOnly: true,
      async run(args) {
        return `echo: ${JSON.stringify(args)}`;
      },
    },
  ],
};
