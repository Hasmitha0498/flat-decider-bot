// generateJson: low thinking, fallback models on "high demand", and graceful handling of unsupported settings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Call = { model: string; thinking?: string };
const calls: Call[] = [];
let script: ((call: Call) => unknown)[] = [];

vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW' },
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { model: string; config: { thinkingConfig?: { thinkingLevel: string } } }) => {
        const call = { model: req.model, thinking: req.config.thinkingConfig?.thinkingLevel };
        calls.push(call);
        const step = script.shift();
        if (!step) throw new Error('no scripted response left');
        return { text: JSON.stringify(step(call)) };
      },
    };
  },
}));

import { attemptPlan, generateJson } from '../src/gemini/client';

const busy = () => {
  throw new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
};
const ok = () => ({ ok: true });
const request = { system: 's', prompt: 'p', jsonSchema: {}, validator: z.object({ ok: z.boolean() }) };

async function run() {
  const promise = generateJson(request);
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  script = [];
  process.env.GEMINI_API_KEY = 'test';
  process.env.GEMINI_MODEL = 'main-model';
  process.env.GEMINI_FALLBACK_MODELS = 'fallback-a,fallback-b';
});
afterEach(() => vi.useRealTimers());

describe('generateJson', () => {
  it('asks for low thinking, so long listing pages finish before the deadline', async () => {
    script = [ok];
    await expect(run()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ model: 'main-model', thinking: 'LOW' }]);
  });

  it('moves on to the next model when one is overloaded', async () => {
    script = [busy, ok];
    await expect(run()).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.model)).toEqual(['main-model', 'fallback-a']);
  });

  it('never tries the same model twice in one round', async () => {
    process.env.GEMINI_FALLBACK_MODELS = 'main-model,fallback-a';
    expect(attemptPlan().map((a) => a.model)).toEqual(['main-model', 'fallback-a', 'main-model', 'fallback-a']);
  });

  it('tries every model twice before giving up', async () => {
    expect(attemptPlan().map((a) => a.model)).toEqual(['main-model', 'fallback-a', 'fallback-b', 'main-model', 'fallback-a', 'fallback-b']);
    script = [busy, busy, busy, busy, ok];
    await expect(run()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(5);
  });

  it('fails with GeminiError after every attempt fails', async () => {
    script = Array(6).fill(busy);
    const promise = generateJson(request);
    const assertion = expect(promise).rejects.toThrow(/Gemini request failed.*high demand/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('retries without the thinking setting on a model that does not support it', async () => {
    script = [
      () => {
        throw new Error('{"error":{"code":400,"message":"Thinking level LOW is not supported for this model.","status":"INVALID_ARGUMENT"}}');
      },
      ok,
    ];
    process.env.GEMINI_MODEL = 'old-model';
    await expect(run()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ model: 'old-model', thinking: 'LOW' }, { model: 'old-model', thinking: undefined }]);
  });

  it('treats invalid JSON output as a failed attempt, never as data', async () => {
    script = [() => ({ ok: 'not a boolean' }), ok];
    await expect(run()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});
