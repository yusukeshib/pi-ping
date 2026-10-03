import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Only loaded by the isolated RPC smoke test. Never makes network requests.
export default function (pi) {
  let calls = 0;
  pi.registerProvider("ping-test", {
    api: "ping-test-api",
    baseUrl: "http://127.0.0.1:1/never-used",
    apiKey: "local-test-only",
    models: [{
      id: "local", name: "Local deterministic ping test", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const failed = ++calls === 1;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        if (failed) {
          message.stopReason = "error";
          message.errorMessage = "Simulated network offline";
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({ type: "start", partial: message });
          message.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          message.content[0].text = "Recovered: authorized task complete.";
          stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
