import { askAssistantResponseSchema, type AskAssistantResponse } from '@edu/contracts';
import { apiRequest } from '../../shared/api/client.ts';

/**
 * The assistant's only endpoint.
 *
 * WHAT THIS FUNCTION CANNOT SEND, because there is no parameter for it: a
 * learner id, an organization, a class, a role, a source, a system prompt or a
 * model. The signature is the contract — a component that wanted to name whose
 * material to read would have to change this file, and the server would refuse
 * it anyway.
 *
 * The response is parsed through the shared `.strict()` schema, so a field the
 * server did not intend to send throws at the boundary instead of reaching a
 * component that might render it.
 */
export const askAssistant = async (
  lessonId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AskAssistantResponse> =>
  askAssistantResponseSchema.parse(
    await apiRequest<unknown>('/assistant/ask', {
      method: 'POST',
      body: { lessonId, question },
      ...(signal ? { signal } : {}),
    }),
  );

export type { AskAssistantResponse };
