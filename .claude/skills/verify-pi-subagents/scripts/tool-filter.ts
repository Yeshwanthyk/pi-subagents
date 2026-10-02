// Load-time shim: wraps the extension at $FILTER_EXT and drops tools named in $HIDE_TOOLS
// (comma-separated). drive.mjs uses it only when HIDE_TOOLS is set, e.g. to keep a
// provider that rejects some tool schema usable for the other scenarios.
const mod = await import(process.env.FILTER_EXT!);
const hidden = new Set((process.env.HIDE_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

export default function (pi: any) {
  const proxy = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") {
        return (tool: { name: string }) => (hidden.has(tool.name) ? undefined : target.registerTool(tool));
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return mod.default(proxy);
}
