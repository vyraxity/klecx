import { z } from "zod";

export const createGenerationSchema = z.object({
  idempotencyKey: z.string().min(1, "Idempotency key is required").max(255),
  prompt: z.string().min(1, "Prompt cannot be empty").max(20000, "Prompt must be at most 20,000 characters"),
  // Pre-10.6 fix: no default here. Without a model the server uses the
  // person's default (resolveDefaultTextModel(): Automatic = Standard
  // Reasoning when the owner's plan includes it).
  modelKey: z.string().optional(),
  kind: z.enum(["TEXT", "IMAGE"]).optional().default("TEXT"),
  attachmentIds: z.array(z.string()).optional(),
  regenerateResponseId: z.string().optional(),
});

export type CreateGenerationInput = z.input<typeof createGenerationSchema>;
export type ParsedGenerationInput = z.infer<typeof createGenerationSchema>;
