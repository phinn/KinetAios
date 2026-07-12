# Plugin SDK(v1)

KinetAios lets you extend the **Direct** engine with custom tools. Drop a folder under `<userData>/plugins/<name>/` and the loader picks it up on next launch (or on **Settings → Plugins → Reload**).

> Windows: `<userData>` ≈ `C:\Users\<you>\AppData\Roaming\KinetAios`.
> macOS: `~/Library/Application Support/KinetAios`.

## v1 scope

- ✅ **Custom tools** — extend what the agent can call.
- ⏳ **Custom engines** — needs to implement the full `AgentEvent` streaming contract. Tracked for v2.
- ❌ **Sandboxing** — plugins are full-trust Node code (same model as VSCode extensions). Install only what you trust.

## Anatomy

```
plugins/
  my-plugin/
    plugin.json     # manifest (required)
    index.js        # CommonJS module (required)
```

### `plugin.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "you"
}
```

### `index.js`

```js
module.exports = {
  tools: [
    {
      name: 'my_tool',
      description: 'When to call this',
      parameters: {
        type: 'object',
        properties: { foo: { type: 'string', description: '...' } },
        required: ['foo'],
      },
      readOnly: true, // optional — read-only tools run concurrently; write tools serialize
      async run(args, ctx) {
        // ctx.cwd = current conversation working dir
        // ctx.confirm(cmd) = ask user to approve a shell command (returns Promise<boolean>)
        return `got: ${args.foo}`;
      },
    },
  ],
};
```

See `plugins/examples/echo/` for a working sample.

## Tool interface

```ts
interface Tool {
  name: string;          // unique across built-ins + other plugins
  description: string;   // helps the LLM decide when to call it
  parameters: Record<string, unknown>; // JSON Schema (OpenAI function-calling format)
  readOnly?: boolean;    // default false
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}
```

Plugin tools live in the same namespace as built-ins. If two plugins (or a plugin + builtin) register the same `name`, the loader takes both and the agent sees a duplicate — pick unique names.

## Dev loop

1. Edit your `index.js`.
2. Settings → Plugins → **Reload** (no app restart needed).
3. New conversation → ask the agent to use your tool.

The loader clears `require.cache` on every load, so edits land on the next reload.

## What plugins **cannot** do in v1

- Register a new engine (Direct / Claude Code / Codex only, for now).
- Inject system prompt fragments — wrap your tool's behavior in its `description` instead.
- Run in the renderer — plugins are main-process only.
