/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
const reasons = {
  output_limit: "模型达到本次输出或上下文上限，未生成正文；请检查输出上限和上下文容量",
  content_filtered: "模型服务过滤了本次回复，未返回正文",
  service_unavailable: "模型服务报告资源不足，未生成正文",
  generation_aborted: "模型服务中止了本次生成，未返回正文",
  reasoning_only: "模型仅返回思考内容，未生成正文；请检查输出上限及接口兼容性",
  empty: "模型未返回最终回复，正文为空；请检查模型服务的返回结果",
} as const;
export type EmptyResponseReason = keyof typeof reasons;

/** Safe fixed diagnostics only: never retain provider text, thoughts or request bodies. */
export class EmptyModelResponseError extends Error {
  readonly reason: EmptyResponseReason;
  constructor(finishReason: unknown, hasReasoning = false) {
    const reason = finishReason === "length" ? "output_limit"
      : finishReason === "content_filter" ? "content_filtered"
      : finishReason === "insufficient_system_resource" ? "service_unavailable"
      : finishReason === "aborted" ? "generation_aborted"
      : hasReasoning ? "reasoning_only" : "empty";
    super(reasons[reason] + "。本轮未自动重试，已执行的工具动作请核对回执。");
    this.name = "EmptyModelResponseError";
    this.reason = reason;
  }
}
