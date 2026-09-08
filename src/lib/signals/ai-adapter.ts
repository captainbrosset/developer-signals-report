import { z } from 'zod';

export const enrichmentSchema = z.object({
  sourceId: z.string().min(1),
  classification: z.enum(['qualified', 'excluded', 'ambiguous']),
  themes: z.array(z.string().min(1).max(48)).max(5),
  summary: z.string().min(1).max(280),
  workaroundSeverity: z.enum([
    'none',
    'light',
    'moderate',
    'high',
    'blocked',
  ]),
});

export type Enrichment = z.infer<typeof enrichmentSchema>;

export interface AiAdapter {
  enrich(input: {
    sourceId: string;
    body: string;
  }): Promise<Enrichment>;
}

export function createAiAdapter(env = process.env): AiAdapter | undefined {
  if (env.ENABLE_AI_ENRICHMENT !== 'true') return undefined;
  if (!env.AI_ENDPOINT || !env.AI_API_KEY || !env.AI_MODEL) {
    throw new Error(
      'AI enrichment was enabled without AI_ENDPOINT, AI_API_KEY, and AI_MODEL.',
    );
  }
  return {
    async enrich(input) {
      const response = await fetch(env.AI_ENDPOINT!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.AI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.AI_MODEL,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'developer_signal_enrichment',
              strict: true,
              schema: z.toJSONSchema(enrichmentSchema),
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'Classify and summarize only the supplied GitHub comment. Never invent evidence. Return schema-constrained JSON.',
            },
            { role: 'user', content: JSON.stringify(input) },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`AI enrichment failed with HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI enrichment returned no content.');
      return enrichmentSchema.parse(JSON.parse(content));
    },
  };
}
