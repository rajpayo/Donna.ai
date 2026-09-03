/**
 * Answer generator adapter for OpenAI-compatible chat models
 * (Specification 3.3). The model is selected in models.config.yaml
 * (retrieval.answer lane) — never hard-coded. The generator is a plain
 * text completion over a trust-separated prompt; it has no tools, so
 * stored content cannot request actions (SR-1). Citation verification
 * lives in @donna/retrieval's AnswerSynthesizer and fails closed.
 */
import type { AnswerGenerator } from "@donna/core";
import type { GatewayClient } from "./gateway.js";

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
}

export class OpenAiCompatibleAnswerGenerator implements AnswerGenerator {
  constructor(
    private readonly gateway: GatewayClient,
    readonly modelId: string,
    private readonly params: Record<string, unknown> = {},
  ) {}

  async generate(prompt: string): Promise<string> {
    const res = await this.gateway.postJson<ChatCompletionsResponse>(
      "/chat/completions",
      {
        model: this.modelId,
        messages: [{ role: "user", content: prompt }],
        ...this.params,
      },
      "retrieve.answer",
    );
    const content = res.choices[0]?.message.content;
    if (!content) throw new Error("Answer generator returned empty content");
    return content;
  }
}
