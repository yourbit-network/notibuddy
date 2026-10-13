import { z } from 'zod';
export const answerSchema=z.object({
  action:z.string().min(1).max(200).refine(value=>value.trim().length>0),
  text:z.string().max(50000).optional(),values:z.record(z.unknown()).optional(),authenticated:z.boolean().optional(),
}).strict();
