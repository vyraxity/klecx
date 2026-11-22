import { z } from "zod";
import { CREDIT_HISTORY_TYPES } from "@/lib/usage/types";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const usagePeriodQuerySchema = z.object({
  period: z.enum(["current", "prev"]).default("current"),
});

export const usageTimeseriesQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
});

export const creditHistoryQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  type: z.enum(CREDIT_HISTORY_TYPES).default("all"),
  format: z.enum(["json", "csv"]).default("json"),
});
