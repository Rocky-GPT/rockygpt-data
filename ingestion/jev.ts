/**
 * jev.ts
 *
 * Choice questions to Jev, TypeSafe's classifier. Jev picks one of the options it is given,
 * with each option's probability and its confidence; it never writes text. The Brain routes
 * chat with the same pinned model (rockygpt-brain core/routing.py).
 *
 * API: https://docs.typesafe.ai/api. Price: https://docs.typesafe.ai/models.
 */

import { fetchWithPolicy } from './http-client';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';
// Input tokens cost $0.042 a million (September 2026); output tokens are free.
export const JEV_NANODOLLARS_PER_INPUT_TOKEN = 42;

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevAnswers {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  inputTokens: number;
}

/** Asks Jev the questions about state. Tests pass their own. */
export type AskJev = (state: unknown, questions: Readonly<Record<string, ChoiceQuestion>>) => Promise<JevAnswers>;

const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Jev's response body, checked: every question answered with one of its own options, and the input tokens it billed. */
export function jevAnswers(body: unknown, questions: Readonly<Record<string, ChoiceQuestion>>): JevAnswers {
  const { model, answers, usage } = (body ?? {}) as {
    model?: unknown;
    answers?: Record<string, Partial<ChoiceAnswer> & { type?: unknown }>;
    usage?: { input_tokens?: unknown };
  };
  const inputTokens = usage?.input_tokens;
  if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error('Jev did not report the input tokens it billed.');
  }
  const checked: Record<string, ChoiceAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers?.[key];
    const options = Object.keys(question.criteria);
    const probabilities = answer?.probabilities ?? {};
    if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !options.includes(answer.choice)
      || !probability(answer.confidence) || !options.every(option => probability(probabilities[option]))) {
      throw new Error(`Jev's answer to "${key}" is not one of its options.`);
    }
    checked[key] = {
      choice: answer.choice,
      probabilities: Object.fromEntries(options.map(option => [option, probabilities[option]])),
      confidence: answer.confidence,
    };
  }
  return { model: typeof model === 'string' ? model : '', answers: checked, inputTokens };
}

/** Asks with an API key. A rate-limited or failed request is tried three times in all. */
export function jevClient(apiKey: string): AskJev {
  return async (state, questions) => {
    const response = await fetchWithPolicy(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    }, { attempts: 3, retryNonIdempotent: true, timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
    if (!response.ok) {
      throw new Error(`Jev answered ${response.status}${response.status === 401 ? ': the API key was refused' : ''}.`);
    }
    return jevAnswers(response.json(), questions);
  };
}
