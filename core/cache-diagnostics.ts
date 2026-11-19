/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { readCacheAdvice } from "./cache-advice.ts";
import { cacheTestPlan, runCacheProbe } from "./cache-probe.ts";
import { supportsContextPrefix } from "./context-material.ts";
import { ModelConfig, ModelConfigError, resolveModel } from "./model-config.ts";

type Result = Awaited<ReturnType<typeof runCacheProbe>> & {
  model: string; revision: string; test_id?: string;
};
type Review = { revision: string; expires: number; confirmation?: string; result?: Result };

/** A review belongs to one saved model and configuration revision. Reading it performs no model calls. */
export class CacheDiagnostics {
  private models: ModelConfig;
  private archiveRoot: string;
  private reviews = new Map<string, Review>();
  private running = false;
  constructor(models: ModelConfig, archiveRoot: string) {
    this.models = models;
    this.archiveRoot = archiveRoot;
  }
  private current(model: string) {
    if (typeof model !== "string" || !model) throw new ModelConfigError("请选择已保存的对话模型");
    const { revision } = this.models.snapshot();
    const provider = resolveModel(this.models.config, model);
    const mode = supportsContextPrefix(provider) ? "builtin" : provider.cache_prefix_optimized ? "optimized" : "standard";
    return { provider, revision, mode };
  }
  private review(model: string, revision: string) {
    const now = Date.now();
    for (const [key, value] of this.reviews)
      if (value.expires < now || value.revision !== revision) this.reviews.delete(key);
    return this.reviews.get(model);
  }
  private async evidence(model: string, { provider, revision }: ReturnType<CacheDiagnostics["current"]>) {
    const duplicates = this.models.config.models.filter((m: any) => m.provider === provider.id && m.model === provider.model);
    const evidence = await readCacheAdvice({ archiveRoot: this.archiveRoot, modelId: model, providerId: provider.id,
      model: provider.model, uniqueModel: duplicates.length === 1, configMtimeMs: (await stat(this.models.file)).mtimeMs });
    if (this.models.snapshot().revision !== revision) throw new ModelConfigError("配置已变化，请重新检查", 409);
    return evidence;
  }
  async check(model: string) {
    const current = this.current(model);
    const { provider, revision, mode } = current;
    const evidence = await this.evidence(model, current);
    const plan = cacheTestPlan(provider);
    let review = this.review(model, revision);
    if (mode === "standard" && !plan.unavailable_reason && evidence.advice.code === "test" && !review && !this.running) {
      review = { revision, expires: Date.now() + 30 * 60000, confirmation: randomUUID() };
      this.reviews.set(model, review);
    }
    return { model, revision, mode, ...evidence, plan,
      ...(review?.confirmation && evidence.advice.code === "test" ? { confirm_token: review.confirmation } : {}),
      ...(review?.result ? { result: review.result } : {}) };
  }
  async test(input: any, signal: AbortSignal) {
    if (input?.confirm_paid !== true) throw new ModelConfigError("请先确认本次模型调用可能产生费用");
    const model = input.model;
    const current = this.current(model);
    const { provider, revision, mode } = current;
    const review = this.review(model, revision);
    if (mode !== "standard" || input.revision !== revision || !review?.confirmation ||
        input.confirm_token !== review.confirmation) throw new ModelConfigError("请重新查看诊断与费用，并确认后再测试", 409);
    if (this.running) throw new ModelConfigError("已有付费测试正在运行", 409);
    const reason = cacheTestPlan(provider).unavailable_reason;
    if (reason) throw new ModelConfigError(reason);
    signal.throwIfAborted();
    delete review.confirmation;
    this.running = true;
    try {
      if ((await this.evidence(model, current)).advice.code !== "test")
        throw new ModelConfigError("最新记录已不建议运行付费测试，请重新查看", 409);
      signal.throwIfAborted();
      const report = await runCacheProbe({provider, logger: this.models.logger, diagnostics: this.models.diagnostics, signal});
      const result: Result = { ...report, model, revision };
      if (this.models.snapshot().revision === revision) {
        if (result.verdict === "better") result.test_id = randomUUID();
        review.result = result;
        review.expires = Date.now() + 30 * 60000;
      }
      return result;
    } finally {
      this.running = false;
      if (!review.result && this.reviews.get(model) === review) this.reviews.delete(model);
    }
  }
  async apply(input: any) {
    const model = input?.model;
    const { revision, mode } = this.current(model);
    if (input.revision !== revision || typeof input.enabled !== "boolean")
      throw new ModelConfigError("请读取当前模型配置后再操作", 409);
    if (input.enabled) {
      const result = this.review(model, revision)?.result;
      if (mode !== "standard" || !result?.test_id || result.test_id !== input.test_id || result.verdict !== "better")
        throw new ModelConfigError("需要当前模型有效的对照测试结果", 409);
    } else if (mode !== "optimized") {
      throw new ModelConfigError("当前模型并未手动启用缓存优化", 409);
    }
    const updated = await this.models.setCacheOptimization(model, revision, input.enabled);
    this.reviews.delete(model);
    return updated;
  }
}
